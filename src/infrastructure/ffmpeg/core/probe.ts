import { pino } from 'pino';
import type { ProbeResult, AudioStreamInfo } from '../../../domain/job.interface.js';
import { ValidationError } from '../../../domain/errors.js';
import { runFFprobe } from './runner.js';

const logger = pino({ name: 'ProbeCommand' });
const MAX_DURATION_SECONDS = 7200;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export async function probe(sourceUrl: string): Promise<ProbeResult> {
   logger.info({ sourceUrl }, 'Probing source video');

   const data = await runFFprobe(sourceUrl);

   const videoStream = data.streams.find((s) => s.codec_type === 'video');
   if (!videoStream) {
      throw new ValidationError('No video stream found in source');
   }

   const duration = data.format.duration ?? 0;
   const fileSize = data.format.size ?? 0;
   const width = videoStream.width ?? 0;
   const height = videoStream.height ?? 0;
   const codec = videoStream.codec_name ?? 'unknown';

   const rFrameRate = videoStream.r_frame_rate ?? '30/1';
   const [fpNum, fpDen] = rFrameRate.split('/').map(Number);
   const frameRate = fpDen ? Math.round(fpNum / fpDen) : fpNum;

   const rawAudioStreams = data.streams.filter((s) => s.codec_type === 'audio');

   const audioStreams: AudioStreamInfo[] = rawAudioStreams.map((stream, arrayIndex) => {
      const s = stream as any;
      const tags = s.tags || {};

      const lang = tags.language || tags.LANGUAGE || 'und';

      const title = tags.title || tags.TITLE || tags.handler_name || `Track ${arrayIndex + 1}`;

      return {
         index: arrayIndex,
         language: lang.toLowerCase().slice(0, 3),
         channels: s.channels ?? 2,
         title: title,
      };
   });

   if (audioStreams.length === 0) {
      audioStreams.push({ index: -1, language: 'und', channels: 2, title: 'Track 1' });
   }

   let videoRange = 'SDR';
   const colorTransfer = (videoStream as any).color_transfer?.toLowerCase() || '';
   if (colorTransfer.includes('smpte2084')) {
      videoRange = 'PQ';
   } else if (colorTransfer.includes('arib-std-b67') || colorTransfer.includes('hlg')) {
      videoRange = 'HLG';
   }

   if (duration > MAX_DURATION_SECONDS) {
      throw new ValidationError(
         `Video too long: ${Math.round(duration)}s (max: ${MAX_DURATION_SECONDS}s)`,
      );
   }

   if (fileSize > MAX_FILE_SIZE_BYTES) {
      throw new ValidationError(
         `File too large: ${Math.round(fileSize / 1024 / 1024)}MB (max: ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)`,
      );
   }

   if (height < 240) {
      throw new ValidationError(`Resolution too low: ${width}x${height} (min: 240p)`);
   }

   const originalAspectRatio = width / height;
   let aspectRatio = '16:9';

   const ratioStr = originalAspectRatio.toFixed(2);
   if (ratioStr === '1.78') aspectRatio = '16:9';
   else if (ratioStr === '0.56') aspectRatio = '9:16';
   else if (ratioStr === '1.85') aspectRatio = '1.85:1';
   else if (ratioStr === '2.00') aspectRatio = '2.00:1';
   else if (ratioStr === '2.39') aspectRatio = '2.39:1';
   else aspectRatio = `${ratioStr}:1`;

   const result: ProbeResult = {
      duration,
      width,
      height,
      aspectRatio,
      originalAspectRatio,
      codec,
      fileSize,
      frameRate,
      audioStreams,
      videoRange,
   };

   logger.info(
      { sourceUrl, audioLanguagesDetected: audioStreams.map((a) => a.language), videoRange },
      'Probe complete',
   );
   return result;
}
