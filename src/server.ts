/**
 * Application entry point: Bootstraps the HTTP server and BullMQ worker.
 *
 * @remarks
 * - Wires the dependency injection graph for the video processing pipeline.
 * - Exposes Kubernetes-compatible readiness (`/ready`) and liveness (`/health`) probes.
 * - Enforces a strict 30s graceful shutdown timeout on SIGINT/SIGTERM to prevent
 *   orphaned pods if external dependencies (e.g., Azure Storage, DB) hang.
 */
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/env.js';
import { VideoWorker } from './infrastructure/queue/video.worker.js';
import { ProcessVideo } from './application/video.process.js';
import { FFmpegAdapter } from './infrastructure/ffmpeg/index.js';
import { AzureStorageService } from './infrastructure/storage/azure.service.js';
import { PostgresVideoRepository } from './infrastructure/db/db.js';

const server: FastifyInstance = Fastify({
   logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
   },
});

await server.register(helmet);

const allowedOrigins = config.CORS_ORIGIN === '*' ? '*' : config.CORS_ORIGIN.split(',');
await server.register(cors, {
   origin: allowedOrigins,
});

await server.register(rateLimit, {
   max: 100,
   timeWindow: '1 minute',
});

server.get('/health', async () => ({
   status: 'ok',
   uptime: process.uptime(),
   timestamp: new Date().toISOString(),
}));

let isReady = false;

server.get('/ready', async (_req, reply) => {
   if (isReady) return { status: 'ready' };
   return reply.status(503).send({ status: 'not_ready' });
});

/**
 * Bootstraps external dependencies, starts the worker pipeline, and binds the server.
 *
 * Flow during SIGINT/SIGTERM:
 * 1. Sets `isReady = false` (returns HTTP 503) to drain load balancer traffic.
 * 2. Waits for the active BullMQ worker job to finish (up to 30s).
 * 3. Gracefully closes DB connections and the HTTP server.
 */
const start = async () => {
   try {
      const ffmpeg = new FFmpegAdapter();
      const storage = new AzureStorageService();

      const db = new PostgresVideoRepository(config.DATABASE_URL);
      const processVideo = new ProcessVideo(ffmpeg, storage, db);
      const worker = new VideoWorker(processVideo);
      worker.start();

      await server.listen({ port: config.PORT, host: '0.0.0.0' });
      isReady = true;
      server.log.info(`Worker service ready on port ${config.PORT}`);

      const shutdown = async (signal: string) => {
         server.log.info(`Received ${signal}, shutting down...`);
         isReady = false;

         const timeout = setTimeout(() => {
            server.log.error('Shutdown timed out after 30s, forcing exit');
            process.exit(1);
         }, 30_000);

         try {
            await worker.close();
            await db.close();
            await server.close();
            clearTimeout(timeout);
            process.exit(0);
         } catch (err) {
            server.log.error({ err }, 'Error during shutdown');
            clearTimeout(timeout);
            process.exit(1);
         }
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
   } catch (err) {
      server.log.error(err);
      process.exit(1);
   }
};

start();
