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
 * Orchestrates the core video processing pipeline: Probe -> Transcode -> Upload.
 *
 * @remarks
 * - Idempotency: If a job fails midway, retrying it will safely overwrite existing partial state.
 * - Cleanup: Guaranteed to remove local intermediate files on both success and failure pathways.
 */
export class ProcessVideo implements ProcessVideoUseCase {
   constructor(
      private readonly ffmpeg: TranscodeProvider,
      private readonly storage: StorageProvider,
      private readonly db: VideoRepository,
   ) {}

   /**
    * Executes the transcoding pipeline and synchronizes state with the database and webhook.
    *
    * @param job - Job payload from BullMQ. `videoId` acts as the idempotency key in DB/Storage.
    * @throws {WorkerError} If any step fails. Process catches this, cleans up, and rethrows
    *                       so the BullMQ wrapper can handle the retry/failure logic based on `.retryable`.
    */
   async execute(job: JobData, onProgress?: ProgressCallback): Promise<void> {
      const { videoId, sourceUrl, webhookUrl } = job;
      logger.info({ videoId, sourceUrl, webhookUrl }, 'Starting video processing pipeline');

      await this.db.updateStatus(videoId, 'processing');

      try {
         logger.info({ videoId }, 'Step 1/3: Probing source');
         const probeResult = await this.ffmpeg.probe(sourceUrl);

         await this.db.updateStatus(videoId, 'processing');
         logger.info(
            {
               videoId,
               duration: probeResult.duration,
               resolution: `${probeResult.width}x${probeResult.height}`,
            },
            'Probe complete',
         );

         await this.db.saveMetadata(videoId, probeResult);

         logger.info({ videoId }, 'Step 2/3: Transcoding HLS');
         await this.db.updateStatus(videoId, 'transcoding');

         const { outputDir, renditions } = await this.ffmpeg.transcodeHLS(
            sourceUrl,
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
