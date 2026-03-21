import { Worker, Job, UnrecoverableError } from 'bullmq';
import { config } from '../../config/env.js';
import { pino } from 'pino';
import type { JobData, ProcessVideoUseCase } from '../../domain/job.interface.js';

const logger = pino({ name: 'QueueWorker' });

/**
 * BullMQ consumer that binds the Redis queue to the `ProcessVideo` domain logic.
 *
 * @remarks
 * - Maps domain progress callbacks directly to BullMQ `job.updateProgress`.
 * - Relies on Redis lock durations (`config.JOB_LOCK_DURATION_MS`) to detect computationally locked/crashed workers.
 * - Does not throw on failure; relies on BullMQ's internal retry mechanism and `.on('failed')` listeners.
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
