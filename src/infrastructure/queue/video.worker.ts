import { Worker, Job, UnrecoverableError } from 'bullmq';
import { config } from '../../config/env.js';
import { pino } from 'pino';
import type { JobData, ProcessVideoUseCase } from '../../domain/job.interface.js';

const logger = pino({ name: 'QueueWorker' });

/**
 * Subscribes to the Redis BullMQ stream for un-processed video conversions.
 *
 * @remarks
 * - Enforces a static `{ lockDuration: config.JOB_LOCK_DURATION_MS }` interval to detect zombie encoding
 *   pods and restore crashed jobs to `active` arrays automatically per BullMQ retry strategies.
 * - Maps `ProcessVideo.execute()` percentage returns dynamically to `job.updateProgress()` avoiding blocking main event loop.
 */
export class VideoWorker {
   private readonly worker: Worker<JobData>;

   constructor(private readonly processVideo: ProcessVideoUseCase) {
      const redisUrl = new URL(config.REDIS_URL);
      const connection = {
         host: redisUrl.hostname,
         port: parseInt(redisUrl.port, 10),
         username: redisUrl.username || undefined,
         password: redisUrl.password || undefined,
         tls: redisUrl.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
         keepAlive: 10000,
         enableReadyCheck: false,
         maxRetriesPerRequest: null,
      };

      this.worker = new Worker<JobData>(
         'video-processing',
         async (job: Job<JobData>) => {
            logger.info(
               { jobId: job.id, videoId: job.data.videoId, attempt: job.attemptsMade + 1 },
               'Processing job',
            );

            await this.processVideo.execute(job.data, (progress) => {
               job.updateProgress(progress).catch(() => {});
            });
         },
         {
            connection,
            concurrency: config.WORKER_CONCURRENCY,
            autorun: false,
            lockDuration: config.JOB_LOCK_DURATION_MS,
            lockRenewTime: config.JOB_LOCK_RENEW_MS,
         },
      );

      this.worker.on('completed', (job: Job<JobData>) => {
         logger.info(
            {
               jobId: job.id,
               videoId: job.data.videoId,
               duration: `${Date.now() - job.timestamp}ms`,
            },
            'Job completed',
         );
      });

      this.worker.on('failed', (job: Job<JobData> | undefined, err: Error) => {
         logger.error(
            { jobId: job?.id, videoId: job?.data?.videoId, attempt: job?.attemptsMade, err },
            'Job failed',
         );
      });

      this.worker.on('stalled', (jobId: string) => {
         logger.warn({ jobId }, 'Job stalled — may need manual retry');
      });

      this.worker.on('error', (err: Error) => {
         logger.error({ err }, 'Worker error');
      });
   }

   start(): void {
      this.worker.run();
      logger.info('Worker started listening on queue: video-processing');
   }

   async close(): Promise<void> {
      await this.worker.close();
      logger.info('Worker shut down gracefully');
   }
}
