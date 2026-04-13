import path from 'node:path';
import { config } from '../../../config/env.js';
import type { VideoVariantMeta, AudioVariantMeta } from '../types.js';
import { HLS_CONSTANTS } from '../constants.js';

export interface FrameRateInfo {
   ffmpegFraction: string;
   aFormat: string;
   gopSize: number;
}

/**
 * Normalizes input framerate to strictly enforced NTSC drop-frame broadcast standards (24000/1001, 30000/1001).
 * Fixes temporal jitter caused by rounding errors in 23.976 / 29.970 media files.
 */
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
      aFormat: exactFps.toFixed(3),
      gopSize: Math.round(exactFps * 2),
   };
}

/**
 * Constructs the `-f hls` output parameter blocks for libavformat.
 *
 * - Forces fMP4 fragments instead of TS containers to reduce byte bloat and improve CDN caching.
 * - Extracts `tfhd` offset tracking (`+omit_tfhd_offset`) to remain fully CMAF compliant.
 * - Explicitly pushes a `+genpts` fflag so broken presentation timestamps do not crash the muxer queue.
 */
export function hlsOutputFlags(
   hlsTime: number,
   outputDir: string,
   videoId: string,
   variant?: VideoVariantMeta,
   audio?: AudioVariantMeta,
   baseUrl?: string,
): string[] {
   let segmentPattern = 'data_%03d.m4s';
   let initPattern = '000.mp4';

   if (variant) {
      let codec = variant.videoCodecTag.substring(0, 4);
      if (codec.startsWith('dv')) codec = 'dovi';
      const base = `${videoId}_${variant.name}_${codec}_${variant.actualWidth}x${variant.actualHeight}`;
      segmentPattern = `${base}_--%d.m4s`;
      initPattern = `${base}.mp4`;
   } else if (audio) {
      const base = `${videoId}_audio_${audio.language}_${audio.name}`;
      segmentPattern = `${base}--%d.m4s`;
      initPattern = `${base}.mp4`;
   }

   const flags = [
      '-hls_fmp4_init_filename',
      initPattern,
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof+cmaf+omit_tfhd_offset+write_colr',
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
      path.join(outputDir, segmentPattern),
      '-avoid_negative_ts',
      'make_zero',
      '-fflags',
      '+genpts',
      '-use_stream_ids_as_track_ids',
      '1',
      '-video_track_timescale',
      '90000',
      '-max_muxing_queue_size',
      String(config.MAX_MUXING_QUEUE_SIZE),
   ];

   if (baseUrl) {
      flags.push('-hls_base_url', baseUrl);
   }

   return flags;
}

/**
 * Maps variant resolution and HDR configurations to x264/x265 encoder flags.
 *
 * - Enforces CFR (Constant Frame Rate) to prevent A/V sync drift on manifest boundaries.
 * - Restricts VBV buffer size (`-bufsize`) tight to `-maxrate` to prevent playback buffer underflow on constrained memory devices (ref: Apple HLS Authoring Spec).
 * - Forces IDR frames strictly at GOP bounds (`-sc_threshold 0`) to guarantee seamless ABR switching.
 * - Injects static HDR10 metadata (MaxCLL/Master Display) for SMPTE ST 2084 compliance.
 */
export function videoEncoderFlags(variant: VideoVariantMeta, sourceFrameRate?: number): string[] {
   const fpsInfo = getBroadcastFrameRate(sourceFrameRate);
   const gopSize = fpsInfo ? fpsInfo.gopSize : 48;

   const codec = variant.videoCodec || 'libx264';
   const isHevc = codec === 'libx265';
   const isHdr =
      (variant.videoRange === 'PQ' || variant.videoRange === 'HLG') && variant.profile === 'main10';

   const colorPrimaries = isHdr ? 'bt2020' : 'bt709';
   const colorTransfer = isHdr
      ? variant.videoRange === 'HLG'
         ? 'arib-std-b67'
         : 'smpte2084'
      : 'bt709';
   const colorMatrix = isHdr ? 'bt2020nc' : 'bt709';
   const pixFmt = variant.profile === 'main10' ? 'yuv420p10le' : 'yuv420p';

   const baseFlags: string[] = [
      '-c:v',
      codec,
      '-tag:v',
      isHevc ? 'hvc1' : variant.videoCodecTag.substring(0, 4),
      '-preset',
      variant.preset,
      ...(codec === 'libx264' ? ['-tune', 'film'] : []), // hotfix/20-remove-x265-film-tune #20
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
      String(variant.crf || 23),
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
      '-threads',
      String(config.FFMPEG_THREADS),
   ];

   if (isHevc) {
      const isDvh = variant.videoCodecTag.startsWith('dvh1');
      const dvProfile = variant.videoCodecTag.includes('.05.') ? '5' : '8.1';
      const dvhParam = isDvh
         ? `:dolby-vision-profile=${dvProfile}:dolby-vision-rpu=filename:hdr10-opt=1`
         : '';

      const defaultMasterDisplay =
         'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)';
      const defaultMaxCll = '1000,400';
      const isPQ = colorTransfer === 'smpte2084';
      const hdr10Params = isPQ
         ? `:hdr10-opt=1:repeat-headers=1:master-display=${defaultMasterDisplay}:max-cll=${defaultMaxCll}`
         : ':repeat-headers=1';
      const extraHdrParams = isHdr ? hdr10Params : '';

      baseFlags.push(
         '-x265-params',
         `frame-threads=${config.X265_FRAME_THREADS}:wpp=1:rc-lookahead=${config.X265_RC_LOOKAHEAD}:lookahead-threads=${config.X265_LOOKAHEAD_THREADS}:no-open-gop=1:scenecut=0:keyint=${gopSize}:min-keyint=${gopSize}:info=0:no-sao=1:aq-mode=3:aq-strength=1.0:no-strong-intra-smoothing=1:deblock=-2,-2:rd=4:rdoq-level=2:tu-intra-depth=3:tu-inter-depth=3:b-adapt=2:colorprim=${colorPrimaries}:transfer=${colorTransfer}:colormatrix=${colorMatrix}${extraHdrParams}${dvhParam}`,
         '-flags',
         '+global_header',
      );
   } else {
      baseFlags.push(
         '-x264-params',
         `threads=${config.FFMPEG_THREADS === 0 ? 'auto' : config.FFMPEG_THREADS}:rc-lookahead=${config.X264_RC_LOOKAHEAD}:lookahead-threads=auto:aq-mode=3:b-adapt=2:trellis=2:subme=9:me=umh:direct=auto:deblock=-1,-1`,
         '-flags',
         '+cgop+global_header',
      );
   }

   return baseFlags;
}

/**
 * Generates the scale and setsar (Sample Aspect Ratio) filter graph.
 *
 * - Forces `setsar=1/1` bounds to prevent player hardware layout issues with anamorphic sources.
 * - Interpolates pixels via `spline+accurate_rnd+full_chroma_int` to preserve chroma sub-sampling accuracy during 10-bit YUV 4:2:0 downscales.
 */
export function videoFilterChain(width: number, height: number): string {
   return [
      `scale=${width}:${height}:force_original_aspect_ratio=disable:flags=spline+accurate_rnd+full_chroma_int`,
      'setsar=1/1',
   ].join(',');
}

/**
 * Resolves FDK-AAC and AC3 command flags, bypassing the transcoder for Atmos streams.
 *
 * - Enforces ITU-R BS.1770-4 loudness normalization (Target I=-24, TP=-2.0) on all stereo variants to match broadcast television levels.
 * - Handles 5.1 -> 2.0 fold-down using the standard ITU downmix coefficients (LFE=0.2, FC=0.707).
 * - Implements Shibata dithering during SOXR resampling for precision truncation.
 */
export function audioEncoderFlags(audio: AudioVariantMeta): string[] {
   if (audio.isAtmos) {
      return ['-c:a', 'copy'];
   }

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

   let afFilter = '';

   if (audio.sourceChannels >= 6 && audio.channels === 2) {
      afFilter += 'pan=stereo|FL=FL+0.707*FC+0.707*SL+0.2*LFE|FR=FR+0.707*FC+0.707*SR+0.2*LFE,';
   }

   const resampleParams = 'async=1:first_pts=0:resampler=soxr:precision=28:dither_method=shibata';
   afFilter += `aresample=${resampleParams},`;

   if (!audio.isCinemaMaster) {
      afFilter += 'loudnorm=I=-24:LRA=15:TP=-2.0,';
   }

   let layout = 'stereo';
   if (audio.channels === 6) layout = '5.1';
   else if (audio.channels === 8) layout = '7.1';
   else if (audio.channels === 10) layout = '5.1.4';
   else if (audio.channels === 12) layout = '7.1.4';

   const format = audio.channels === 2 ? 's16' : 'fltp';
   afFilter += `aformat=sample_rates=${audio.sampleRate}:channel_layouts=${layout}:sample_fmts=${format}`;

   flags.push('-af', afFilter);

   const bitsPerSample = audio.isCinemaMaster ? '24' : '16';
   flags.push('-bits_per_raw_sample', bitsPerSample);

   if (audio.profile) {
      flags.push('-profile:a', audio.profile);
   }

   if (audio.codec === 'libfdk_aac') {
      if (!audio.profile || audio.profile === 'aac_low') {
         flags.push('-afterburner', '1');
      }
   } else if (audio.codec === 'aac') {
      flags.push('-cutoff', '0');
   } else if (audio.codec === 'ac3' || audio.codec === 'eac3') {
      flags.push('-dialnorm', '-24');
   }

   return flags;
}
