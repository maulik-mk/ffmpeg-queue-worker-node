import path from 'node:path';
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

/**
 * Executes the multi-phase FFmpeg transcoding pipeline using dynamically generated `filter_complex` graphs.
 *
 * @remarks
 * - Phases are executed sequentially (Audio -> H.264 -> H.265) to strictly bound peak active memory usage.
 * - The `filter_complex` graph splits the decoded input stream in memory, avoiding redundant decodes per resolution.
 * - Aggregates and normalizes percentage callbacks across phases using algorithmic weighting based on codec complexity.
 */
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
      (v) => v.videoCodec === 'libx265' && v.profile !== 'main10',
   );
   const h265Hdr = videoVariants.filter(
      (v) => v.videoCodec === 'libx265' && v.profile === 'main10',
   );

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

      if (config.TEST_DURATION_SECONDS) {
         args.push('-t', String(config.TEST_DURATION_SECONDS));
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

            args.push(
               '-map',
               streamMap,
               ...audioEncoderFlags(audio),
               ...hlsOutputFlags(hlsTime, audioDir),
               manifestPath,
            );
         });
         return args;
      });
   }

   const buildVideoPhaseArgs = (variants: VideoVariantMeta[], isHdr: boolean) => {
      const args = [...getBaseInputArgs()];
      const filtergraph: string[] = [];

      let preFilter = isHdr ? '[0:v:0]format=yuv420p10le' : '[0:v:0]format=yuv420p';

      if (!isHdr && (videoRange === 'PQ' || videoRange === 'HLG')) {
         preFilter = `[0:v:0]zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=hable:desat=0,zscale=transfer=bt709:matrix=bt709:primaries=bt709:range=tv,format=yuv420p`;
      }
      if (!isHdr) preFilter += `,hqdn3d=3:3:2:2`;

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

         args.push(
            '-map',
            `[vout${index}]`,
            ...videoEncoderFlags(variant, sourceFrameRate),
            ...hlsOutputFlags(hlsTime, variantDir),
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
}
