import path from 'node:path';
import fs from 'node:fs/promises';
import { pino } from 'pino';
import type {
   TranscodeProvider,
   ProbeResult,
   ProgressCallback,
   TranscodeResult,
   AudioStreamInfo,
} from '../../domain/job.interface.js';
import { DEFAULT_WORK_DIR } from './types.js';
import {
   filterActiveVideoProfiles,
   computeVideoMetadata,
   computeAudioMetadata,
} from './encoding/profiles.js';
import { probe } from './core/probe.js';
import { processMasterPipeline } from './hls/pipeline.js';
import { writeMasterPlaylist } from './hls/playlist.js';
import { HLS_CONSTANTS } from './constants.js';
import { generateTierUuid, blobPathFromUuid } from './core/hash.js';

const logger = pino({ name: 'FFmpegAdapter' });

const SCHEMA_VERSION = 'v1';

const ISO_639_1_MAP: Record<string, string> = {
   eng: 'en',
   hin: 'hi',
   spa: 'es',
   fra: 'fr',
   deu: 'de',
   jpn: 'ja',
   und: 'und',
};

/**
 * Primary FFmpeg controller orchestrating pipeline sub-shells and local IO states.
 */
export class FFmpegAdapter implements TranscodeProvider {
   constructor(private readonly workDir: string = DEFAULT_WORK_DIR) {}

   /**
    * Triggers the libavformat container parser (probe.js core execution) for structural metadata.
    */
   async probe(sourceUrl: string): Promise<ProbeResult> {
      return probe(sourceUrl);
   }

   /**
    * Filters an inbound source topology against restricted `profiles.json` ladders
    * and dispatches them sequentially through libx264/libx265 encoding cores.
    *
    * - Invokes a unified UUID UUIDv4 string (`tierId`) mapper across the audio/video chunks
    *   to prevent URL discovery brute force iterations.
    *
    * @param sourceUrl - Network accessible inbound blob stream.
    * @param videoId - Used entirely for namespace tracking in logs and storage boundaries.
    * @param sourceWidth - Display layer pixel constraint mapped from `ffprobe`.
    * @param sourceHeight - Display layer scale mapped.
    * @param sourceDuration - Length evaluation multiplier for `progress()` calculations.
    * @param onProgress - Timecode scalar callback bridging percentage reports to the BullMQ wrapper.
    * @param sourceFrameRate - Baseline framerate for computing expected drop-frame bounds (NTSC limits).
    * @param audioStreams - FFprobe indexed track list mapped against requested Atmos definitions.
    * @param videoRange - Enforces strict transfer characteristics arrays ('SDR', 'PQ', 'HLG').
    * @returns Resolution paths mapped to `blobPathFromUuid` for the final Azure ingest.
    */
   async transcodeHLS(
      sourceUrl: string,
      videoId: string,
      sourceWidth: number,
      sourceHeight: number,
      sourceDuration: number,
      onProgress?: ProgressCallback,
      sourceFrameRate?: number,
      audioStreams: AudioStreamInfo[] = [],
      videoRange?: string,
   ): Promise<TranscodeResult> {
      const outputDir = path.join(this.workDir, videoId, 'hls');
      const activeProfiles = filterActiveVideoProfiles(sourceWidth, sourceHeight, videoRange);

      const complexityMultiplier = 1.0;

      const rawVideoVariants = computeVideoMetadata(
         activeProfiles,
         sourceWidth,
         sourceHeight,
         complexityMultiplier,
      );

      const rawAudioRenditions = computeAudioMetadata(audioStreams);
      const hlsTime = rawVideoVariants[0]?.hlsTime ?? 6;

      const videoVariants = rawVideoVariants.map((v) => {
         const tierId = generateTierUuid();
         const relativeUrl = path.join(SCHEMA_VERSION, blobPathFromUuid(tierId));
         return { ...v, relativeUrl };
      });

      const audioRenditions = rawAudioRenditions.map((a) => {
         const lang2Letter = ISO_639_1_MAP[a.language] || a.language;
         const uniqueAudioName = `${lang2Letter}_${a.name}`;
         const tierId = generateTierUuid();
         const relativeUrl = path.join(SCHEMA_VERSION, blobPathFromUuid(tierId));
         return { ...a, relativeUrl };
      });

      for (const v of videoVariants) {
         await fs.mkdir(path.join(outputDir, v.relativeUrl), { recursive: true });
      }
      for (const a of audioRenditions) {
         await fs.mkdir(path.join(outputDir, a.relativeUrl), { recursive: true });
      }

      await processMasterPipeline(
         sourceUrl,
         outputDir,
         videoId,
         videoVariants,
         audioRenditions,
         hlsTime,
         onProgress,
         sourceFrameRate,
         sourceDuration,
         videoRange,
      );

      const fileExists = async (p: string) =>
         fs
            .stat(p)
            .then(() => true)
            .catch(() => false);

      const validVideoVariants = [];
      for (const v of videoVariants) {
         const p = path.join(outputDir, v.relativeUrl, HLS_CONSTANTS.VARIANT_PLAYLIST_NAME);
         if (await fileExists(p)) validVideoVariants.push(v);
      }

      if (validVideoVariants.length === 0) {
         throw new Error(
            'All video encoding phases failed. No valid video segments were generated.',
         );
      }

      const validAudioRenditions = [];

      for (const a of audioRenditions) {
         const p = path.join(outputDir, a.relativeUrl, HLS_CONSTANTS.VARIANT_PLAYLIST_NAME);
         if (await fileExists(p)) validAudioRenditions.push(a);
      }

      await writeMasterPlaylist(
         outputDir,
         validVideoVariants,
         validAudioRenditions,
         sourceFrameRate,
      );

      logger.info({ videoId }, 'All variants transcoded, Dispersed Hash Tree master written');

      const renditions = validVideoVariants.map((v) => ({
         resolution: v.name,
         width: v.actualWidth,
         height: v.actualHeight,
         bitrate: v.bitrate,
         url: `../${v.relativeUrl}/${HLS_CONSTANTS.VARIANT_PLAYLIST_NAME}`,
      }));

      return { outputDir, renditions };
   }

   async cleanup(videoId: string): Promise<void> {
      const dir = path.join(this.workDir, videoId);
      await fs.rm(dir, { recursive: true, force: true });
   }
}
