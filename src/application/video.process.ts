import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
   JobData,
   ProcessVideoUseCase,
   StorageProvider,
   TranscodeProvider,
   VideoRepository,
   ProgressCallback,
} from '../domain/job.interface.js';
import { WorkerError } from '../domain/errors.js';
import { pino } from 'pino';

const logger = pino({ name: 'ProcessVideo' });

/**
 * Orchestrates the domain lifecycle of a video ingest job: Network -> Probe -> Encode -> Storage.
 */
export class ProcessVideo implements ProcessVideoUseCase {
   constructor(
      private readonly ffmpeg: TranscodeProvider,
      private readonly storage: StorageProvider,
      private readonly db: VideoRepository,
   ) {}

   /**
    * Executes the sequential pipeline required to convert an arbitrary media source to HLS.
    *
    * - Streams the raw source over HTTP directly to local NVMe via `node:stream/promises` to avoid RAM saturation.
    * - Invokes `ffprobe` to determine target mapping bounds (`sourceWidth`, `sourceHeight`).
    * - Updates the database (PostgreSQL) incrementally based on status transitions to prevent worker lock loss.
    *
    * @param job - Required DTO mapping `videoId` to an inbound `sourceUrl`.
    * @param onProgress - BullMQ callback exposing fractional `Math.round()` percentage integers back to Redis.
    * @throws {WorkerError} Forwards non-zero FFmpeg exits or network IO disconnects back to BullMQ for retry evaluation.
    */
   async execute(job: JobData, onProgress?: ProgressCallback): Promise<void> {
      const { videoId, sourceUrl, webhookUrl } = job;
      logger.info({ videoId, sourceUrl, webhookUrl }, 'Starting video processing pipeline');

      await this.db.updateStatus(videoId, 'processing');

      try {
         const parsedUrl = new URL(sourceUrl);
         const extension = path.extname(parsedUrl.pathname);

         logger.info({ videoId, extension }, 'Step 0/3: Downloading source video locally');

         const workDir = `/tmp/worker/${videoId}`;
         await fs.promises.mkdir(workDir, { recursive: true });

         const localSourcePath = path.join(workDir, `source${extension}`);

         const response = await fetch(sourceUrl);
         if (!response.ok) {
            throw new Error(
               `Failed to download source video: ${response.status} ${response.statusText}`,
            );
         }
         if (!response.body) {
            throw new Error('Response body from source video is empty');
         }

         await pipeline(
            Readable.fromWeb(response.body as any),
            fs.createWriteStream(localSourcePath),
         );
         logger.info({ videoId }, 'Source video successfully downloaded to worker disk');

         logger.info({ videoId }, 'Step 1/3: Probing source');
         const probeResult = await this.ffmpeg.probe(localSourcePath);
         await this.db.updateStatus(videoId, 'processing');
         logger.info(
            {
               videoId,
               duration: probeResult.duration,
               resolution: `${probeResult.width}x${probeResult.height}`,
               format: extension,
            },
            'Probe complete',
         );

         await this.db.saveMetadata(videoId, probeResult);

         logger.info({ videoId }, 'Step 2/3: Transcoding HLS');
         await this.db.updateStatus(videoId, 'transcoding');

         const { outputDir, renditions } = await this.ffmpeg.transcodeHLS(
            localSourcePath,
            videoId,
            probeResult.width,
            probeResult.height,
            probeResult.duration,
            onProgress,
            probeResult.frameRate,
            probeResult.audioStreams,
            probeResult.videoRange,
         );

         logger.info({ videoId }, 'Step 3/3: Uploading HLS Master');
         await this.db.updateStatus(videoId, 'uploading');

         const masterPlaylistUrl = await this.storage.uploadHLS(outputDir, videoId, onProgress);

         if (renditions && renditions.length > 0) {
            const baseUrl = masterPlaylistUrl.substring(0, masterPlaylistUrl.lastIndexOf('/') + 1);
            const fullRenditions = renditions.map((r) => ({
               ...r,
               url: `${baseUrl}${r.url}`,
            }));
            await this.db.saveRenditions(videoId, fullRenditions);
         }

         logger.info({ videoId }, 'Cleaning up worker directories');
         await this.ffmpeg.cleanup(videoId);

         await this.db.updateStatus(videoId, 'completed', {
            playlistUrl: masterPlaylistUrl,
            probeResult,
         });

         logger.info(
            { videoId, playlistUrl: masterPlaylistUrl },
            'Pipeline completed successfully',
         );

         if (webhookUrl) {
            logger.info({ webhookUrl, videoId }, 'Dialing completion webhook');
            try {
               await fetch(webhookUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                     videoId,
                     status: 'COMPLETED',
                     playlistUrl: masterPlaylistUrl,
                     probeResult,
                  }),
               });
            } catch (whErr) {
               logger.warn({ err: whErr, webhookUrl }, 'Failed to deliver completion webhook');
            }
         }
      } catch (error) {
         const errorMessage = error instanceof Error ? error.message : String(error);
         const isRetryable = error instanceof WorkerError ? error.retryable : true;

         logger.error({ err: error, videoId, retryable: isRetryable }, 'Pipeline failed');

         try {
            await this.db.updateStatus(videoId, 'failed', { error: errorMessage });
         } catch (dbErr) {
            logger.error({ err: dbErr, videoId }, 'Failed to update DB with error status');
         }

         try {
            await this.ffmpeg.cleanup(videoId);
         } catch (cleanupErr) {
            logger.warn({ err: cleanupErr, videoId }, 'Cleanup failed after error (non-critical)');
         }

         if (webhookUrl) {
            logger.info({ webhookUrl, videoId }, 'Dialing failure webhook');
            try {
               await fetch(webhookUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                     videoId,
                     status: 'FAILED',
                     error: errorMessage,
                     retryable: isRetryable,
                  }),
               });
            } catch (whErr) {
               logger.warn({ err: whErr, webhookUrl }, 'Failed to deliver failure webhook');
            }
         }

         throw error;
      }
   }
}
