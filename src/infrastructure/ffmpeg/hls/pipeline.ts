import path from 'node:path';
import fs from 'node:fs/promises';
import { pino } from 'pino';
import { config } from '../../../config/env.js';
import type { ProgressCallback } from '../../../domain/job.interface.js';
import type { VideoVariantMeta, AudioVariantMeta } from '../types.js';
import {
   videoEncoderFlags,
   videoFilterChain,
   audioEncoderFlags,
   hlsOutputFlags,
} from '../encoding/flags.js';
import { runFFmpeg } from '../core/runner.js';
import { HLS_CONSTANTS } from '../constants.js';

const logger = pino({ name: 'HlsPipeline' });

/**
 * Post-process variant manifests to fix init segment URIs.
 * FFmpeg's -hls_base_url only applies to .m4s segment URIs, NOT to #EXT-X-MAP:URI (init segments).
 * This function prepends the CDN base URL to the init segment filename.
 */
async function fixInitSegmentUrls(
   outputDir: string,
   relativeUrl: string,
   baseUrl: string | undefined,
): Promise<void> {
   if (!baseUrl) return;
   const manifestPath = path.join(outputDir, relativeUrl, HLS_CONSTANTS.VARIANT_PLAYLIST_NAME);
   try {
      let content = await fs.readFile(manifestPath, 'utf8');
      // Match: #EXT-X-MAP:URI="filename.mp4" (bare filename without http)
      content = content.replace(
         /#EXT-X-MAP:URI="(?!https?:\/\/)([^"]+)"/g,
         `#EXT-X-MAP:URI="${baseUrl}$1"`,
      );
      await fs.writeFile(manifestPath, content);
   } catch (err) {
      logger.warn({ manifestPath, err }, 'Could not fix init segment URL');
   }
}

export async function processMasterPipeline(
   sourceUrl: string,
   outputDir: string,
   videoId: string,
   videoVariants: VideoVariantMeta[],
   audioRenditions: AudioVariantMeta[],
   hlsTime: number,
   onProgress?: ProgressCallback,
   sourceFrameRate?: number,
   sourceDuration?: number,
   videoRange: string = 'SDR',
): Promise<void> {
   const h264Sdr = videoVariants.filter((v) => v.videoCodec === 'libx264');
   const h265Sdr = videoVariants.filter(
      (v) => v.videoCodec === 'libx265' && v.videoRange === 'SDR',
   );
   const h265Hdr = videoVariants.filter((v) => v.videoCodec === 'libx265' && v.videoRange === 'PQ');

   let currentBaseProgress = 0;
   const weightAudio = audioRenditions.length > 0 ? 10 : 0;
   const weightH264 = h264Sdr.length > 0 ? 20 : 0;
   const weightH265Sdr = h265Sdr.length > 0 ? 30 : 0;
   const weightH265Hdr = h265Hdr.length > 0 ? 40 : 0;
   const totalWeight = weightAudio + weightH264 + weightH265Sdr + weightH265Hdr;

   const runPhase = async (label: string, weight: number, buildArgs: () => string[]) => {
      const args = buildArgs();
      await runFFmpeg({
         args,
         label,
         videoId,
         duration: config.TEST_DURATION_SECONDS || sourceDuration,
         onProgress: (p) => {
            if (onProgress) {
               const scaledProgress = currentBaseProgress + p.percent * (weight / totalWeight);
               onProgress({ variant: label, percent: scaledProgress });
            }
         },
      });
      currentBaseProgress += (weight / totalWeight) * 100;
   };

   const getBaseInputArgs = () => {
      const args = [];

      args.push('-drc_scale', '0');

      if (config.TEST_DURATION_SECONDS) {
         args.push('-t', String(config.TEST_DURATION_SECONDS));
      }

      if (sourceUrl.startsWith('http')) {
         args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      }
      args.push('-i', sourceUrl);
      return args;
   };

   if (audioRenditions.length > 0) {
      await runPhase('Phase_1_Audio', weightAudio, () => {
         const args = [...getBaseInputArgs()];

         audioRenditions.forEach((audio) => {
            const audioDir = path.join(outputDir, audio.relativeUrl);
            const manifestPath = path.join(audioDir, HLS_CONSTANTS.VARIANT_PLAYLIST_NAME);
            const streamMap = audio.streamIndex !== -1 ? `0:a:${audio.streamIndex}?` : '0:a:0?';

            const baseUrl = config.DOMAIN_SUBDOMAIN_NAME
               ? `${config.DOMAIN_SUBDOMAIN_NAME}/${config.AZURE_STORAGE_CONTAINER_NAME}/${config.CONTAINER_DIRECTORY_1}/${audio.relativeUrl}/`
               : undefined;

            args.push(
               '-map',
               streamMap,
               ...audioEncoderFlags(audio),
               ...hlsOutputFlags(hlsTime, audioDir, videoId, undefined, audio, baseUrl),
               manifestPath,
            );
         });
         return args;
      });

      // Fix init segment URLs for all audio renditions
      for (const audio of audioRenditions) {
         const baseUrl = config.DOMAIN_SUBDOMAIN_NAME
            ? `${config.DOMAIN_SUBDOMAIN_NAME}/${config.AZURE_STORAGE_CONTAINER_NAME}/${config.CONTAINER_DIRECTORY_1}/${audio.relativeUrl}/`
            : undefined;
         await fixInitSegmentUrls(outputDir, audio.relativeUrl, baseUrl);
      }
   }

   const buildVideoPhaseArgs = (variants: VideoVariantMeta[], isHdr: boolean) => {
      const args = [...getBaseInputArgs()];
      const filtergraph: string[] = [];

      let preFilter = '';

      if (isHdr) {
         preFilter = '[0:v:0]format=yuv420p10le';
      } else {
         if (videoRange === 'PQ') {
            preFilter = `[0:v:0]zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
         } else if (videoRange === 'HLG') {
            preFilter = `[0:v:0]zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
         } else {
            preFilter = '[0:v:0]format=yuv420p';
         }
         // preFilter += `,hqdn3d=3:3:2:2`;
      }

      if (variants.length > 1) {
         const splits = variants.map((_, i) => `[split_${i}]`).join('');
         filtergraph.push(`${preFilter},split=${variants.length}${splits}`);
      } else {
         filtergraph.push(`${preFilter}[split_0]`);
      }

      variants.forEach((variant, i) => {
         const scaleFilter = videoFilterChain(variant.actualWidth, variant.actualHeight);
         filtergraph.push(`[split_${i}]${scaleFilter}[vout${i}]`);
      });

      args.push('-filter_complex', filtergraph.join('; '));

      variants.forEach((variant, index) => {
         const variantDir = path.join(outputDir, variant.relativeUrl);
         const manifestPath = path.join(variantDir, HLS_CONSTANTS.VARIANT_PLAYLIST_NAME);

         const baseUrl = config.DOMAIN_SUBDOMAIN_NAME
            ? `${config.DOMAIN_SUBDOMAIN_NAME}/${config.AZURE_STORAGE_CONTAINER_NAME}/${config.CONTAINER_DIRECTORY_1}/${variant.relativeUrl}/`
            : undefined;

         args.push(
            '-map',
            `[vout${index}]`,
            ...videoEncoderFlags(variant, sourceFrameRate),
            ...hlsOutputFlags(hlsTime, variantDir, videoId, variant, undefined, baseUrl),
            manifestPath,
         );
      });
      return args;
   };

   if (h264Sdr.length > 0)
      await runPhase('Phase_2_H264_SDR', weightH264, () => buildVideoPhaseArgs(h264Sdr, false));
   if (h265Sdr.length > 0)
      await runPhase('Phase_3_H265_SDR', weightH265Sdr, () => buildVideoPhaseArgs(h265Sdr, false));
   if (h265Hdr.length > 0)
      await runPhase('Phase_4_H265_HDR', weightH265Hdr, () => buildVideoPhaseArgs(h265Hdr, true));

   // Fix init segment URLs for all video variants
   for (const v of videoVariants) {
      const baseUrl = config.DOMAIN_SUBDOMAIN_NAME
         ? `${config.DOMAIN_SUBDOMAIN_NAME}/${config.AZURE_STORAGE_CONTAINER_NAME}/${config.CONTAINER_DIRECTORY_1}/${v.relativeUrl}/`
         : undefined;
      await fixInitSegmentUrls(outputDir, v.relativeUrl, baseUrl);
   }
}
