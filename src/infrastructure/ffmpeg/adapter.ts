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
import { probeComplexity } from './core/complexity.js';
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
 * The "Brain" of the transcoding engine.
 *
 * @remarks
 * - Orchestrates the entire lifecycle: Probing -> Complexity Analysis -> Transcoding -> Manifest Mapping.
 * - Implements a Dispersed Hash Tree schema (via `blobPathFromUuid`) to prevent directory iteration attacks in public storage.
 * - Employs a "Smart Per-Title" intelligence: Probes the file's visual complexity before assigning final bitrates and renditions.
 */
export class FFmpegAdapter implements TranscodeProvider {
   constructor(private readonly workDir: string = DEFAULT_WORK_DIR) {}
   async probe(sourceUrl: string): Promise<ProbeResult> {
      return probe(sourceUrl);
   }

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

      logger.info({ videoId }, 'Analyzing video complexity for Smart Per-Title Bitrate adaptation');

      const { multiplier: complexityMultiplier } = await probeComplexity(
         sourceUrl,
         sourceDuration,
         videoId,
         sourceWidth,
         sourceHeight,
      );

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
