import path from 'node:path';
import { config } from '../../../config/env.js';
import type { VideoVariantMeta, AudioVariantMeta } from '../types.js';
import { HLS_CONSTANTS } from '../constants.js';

export interface FrameRateInfo {
   ffmpegFraction: string;
   appleFormat: string;
   gopSize: number;
}

export function getBroadcastFrameRate(sourceFps?: number): FrameRateInfo | null {
   if (!sourceFps) return null;

   const targetFps = Math.min(sourceFps, 30);
   const eps = 0.05;

   let fraction = `${Math.round(targetFps * 1000)}/1000`;
   let exactFps = targetFps;

   if (Math.abs(targetFps - 23.976) < eps) {
      fraction = '24000/1001';
      exactFps = 24000 / 1001;
   } else if (Math.abs(targetFps - 29.97) < eps) {
      fraction = '30000/1001';
      exactFps = 30000 / 1001;
   } else {
      const rounded = Math.round(targetFps);
      if (Math.abs(targetFps - rounded) < eps) {
         fraction = `${rounded}/1`;
         exactFps = rounded;
      }
   }

   return {
      ffmpegFraction: fraction,
      appleFormat: exactFps.toFixed(3),
      gopSize: Math.round(exactFps * 2),
   };
}

export function hlsOutputFlags(hlsTime: number, outputDir: string): string[] {
   return [
      '-hls_fmp4_init_filename',
      HLS_CONSTANTS.INIT_SEGMENT_NAME,
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof+cmaf+omit_tfhd_offset',
      '-f',
      'hls',
      '-hls_time',
      String(hlsTime),
      '-hls_list_size',
      '0',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_flags',
      config.HLS_OUTPUT_MODE === 'SINGLE_FILE'
         ? '+independent_segments+single_file+round_durations'
         : '+independent_segments+round_durations',
      '-hls_segment_filename',
      config.HLS_OUTPUT_MODE === 'SINGLE_FILE'
         ? path.join(outputDir, HLS_CONSTANTS.SINGLE_VIDEO_NAME)
         : path.join(outputDir, HLS_CONSTANTS.VIDEO_SEGMENT_NAME),
      '-avoid_negative_ts',
      'make_zero',
      '-fflags',
      '+genpts',
      '-use_stream_ids_as_track_ids',
      '1',
      '-video_track_timescale',
      '90000',
   ];
}

export function videoEncoderFlags(variant: VideoVariantMeta, sourceFrameRate?: number): string[] {
   const fpsInfo = getBroadcastFrameRate(sourceFrameRate);
   const gopSize = fpsInfo ? fpsInfo.gopSize : 48;

   const codec = variant.videoCodec || 'libx264';
   const isHevc = codec === 'libx265';
   const isHdr = variant.profile === 'main10';

   const colorPrimaries = isHdr ? 'bt2020' : 'bt709';
   const colorTransfer = isHdr ? 'smpte2084' : 'bt709';
   const colorMatrix = isHdr ? 'bt2020nc' : 'bt709';
   const pixFmt = isHdr ? 'yuv420p10le' : 'yuv420p';

   const baseFlags: string[] = [
      '-c:v',
      codec,
      '-tag:v',
      isHevc ? 'hvc1' : variant.videoCodecTag.substring(0, 4),
      '-preset',
      variant.preset,
      ...(fpsInfo ? ['-r', fpsInfo.ffmpegFraction, '-fps_mode', 'cfr'] : []),
      ...(variant.profile ? ['-profile:v', variant.profile] : []),
      ...(variant.level ? ['-level', variant.level] : []),
      '-pix_fmt',
      pixFmt,
      '-colorspace',
      colorMatrix,
      '-color_primaries',
      colorPrimaries,
      '-color_trc',
      colorTransfer,
      '-color_range',
      'tv',
      '-crf',
      '23',
      '-maxrate',
      String(variant.maxrate),
      '-bufsize',
      String(variant.bufsize),
      '-b:v',
      String(variant.bitrate),
      '-g',
      String(gopSize),
      '-keyint_min',
      String(gopSize),
      '-sc_threshold',
      '0',
   ];

   if (isHevc) {
      baseFlags.push(
         '-x265-params',
         `no-open-gop=1:keyint=${gopSize}:min-keyint=${gopSize}:info=0:colorprim=${colorPrimaries}:transfer=${colorTransfer}:colormatrix=${colorMatrix}`,
         '-flags',
         '+global_header',
      );
   } else {
      baseFlags.push('-flags', '+cgop+global_header');
   }

   return baseFlags;
}

export function videoFilterChain(width: number, height: number): string {
   return [
      `scale=${width}:${height}:force_original_aspect_ratio=disable`,
      'setsar=1/1',
      'unsharp=3:3:0.5:3:3:0.5',
   ].join(',');
}

export function audioEncoderFlags(audio: AudioVariantMeta): string[] {
   const flags = [
      '-c:a',
      audio.codec,
      '-b:a',
      String(audio.bitrate),
      '-ac',
      String(audio.channels),
      '-ar',
      String(audio.sampleRate),
   ];

   const afFilter = 'aresample=async=1:first_pts=0';
   flags.push('-af', afFilter);

   return flags;
}
