import pg from 'pg';
import { pino } from 'pino';
import type {
   VideoRepository,
   JobStatus,
   ProbeResult,
   VideoRendition,
} from '../../domain/job.interface.js';

const logger = pino({ name: 'PostgresVideoRepository' });

/**
 * PostgreSQL adapter for persisting video state and metadata.
 *
 * @remarks
 * - Manages its own connection pool. Must call `close()` during graceful shutdown to prevent connection leaks.
 * - Upserts are used for metadata (`ON CONFLICT (video_id) DO UPDATE`) to safely support job retries (idempotency).
 * - `updateStatus` serves as a sanity check: it intentionally throws if the video ID vanishes mid-process.
 */
export class PostgresVideoRepository implements VideoRepository {
   private readonly pool: pg.Pool;

   constructor(connectionString: string) {
      this.pool = new pg.Pool({
         connectionString,
         ssl: {
            rejectUnauthorized: false,
         },
      });
   }

   async updateStatus(
      videoId: string,
      status: JobStatus,
      metadata?: Record<string, unknown>,
   ): Promise<void> {
      logger.info({ videoId, status }, 'Updating video status');

      const fields: string[] = ['status = $1', 'updated_at = NOW()'];
      const values: unknown[] = [status];
      let paramIndex = 2;

      if (metadata?.playlistUrl) {
         fields.push(`playlist_url = $${paramIndex++}`);
         values.push(metadata.playlistUrl);
      }
      if (metadata?.spriteUrl) {
         fields.push(`sprite_url = $${paramIndex++}`);
         values.push(metadata.spriteUrl);
      }
      if (metadata?.posterUrl) {
         fields.push(`poster_url = $${paramIndex++}`);
         values.push(metadata.posterUrl);
      }
      if (metadata?.error) {
         fields.push(`error_message = $${paramIndex++}`);
         values.push(metadata.error);
      }

      values.push(videoId);
      const query = `UPDATE videos SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING id`;

      const result = await this.pool.query(query, values);

      if (result.rowCount === 0) {
         logger.warn({ videoId, status }, 'Video ID not found in database (update skipped)');
         throw new Error(`Video ID ${videoId} not found in database`);
      }

      logger.info({ videoId, status }, 'Video status updated');
   }

   async saveMetadata(videoId: string, meta: ProbeResult): Promise<void> {
      const query = `
         INSERT INTO video_metadata (video_id, duration, width, height, codec, size_bytes, frame_rate, aspect_ratio, video_range)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (video_id) DO UPDATE SET
            duration = EXCLUDED.duration,
            width = EXCLUDED.width,
            height = EXCLUDED.height,
            codec = EXCLUDED.codec,
            size_bytes = EXCLUDED.size_bytes,
            frame_rate = EXCLUDED.frame_rate,
            aspect_ratio = EXCLUDED.aspect_ratio,
            video_range = EXCLUDED.video_range
      `;

      try {
         await this.pool.query(query, [
            videoId,
            meta.duration,
            meta.width,
            meta.height,
            meta.codec,
            meta.fileSize,
            meta.frameRate,
            meta.aspectRatio,
            meta.videoRange,
         ]);
         logger.info({ videoId }, 'Video metadata saved');
      } catch (err) {
         logger.error({ videoId, err }, 'Failed to save video metadata');
         throw new Error(`Failed to save metadata: ${(err as Error).message}`);
      }
   }

   async saveRenditions(videoId: string, renditions: VideoRendition[]): Promise<void> {
      if (!renditions || renditions.length === 0) return;

      const client = await this.pool.connect();
      try {
         await client.query('BEGIN');
         await client.query('DELETE FROM video_renditions WHERE video_id = $1', [videoId]);

         const query = `
            INSERT INTO video_renditions (video_id, resolution, width, height, bitrate, url)
            VALUES ($1, $2, $3, $4, $5, $6)
         `;

         for (const r of renditions) {
            await client.query(query, [videoId, r.resolution, r.width, r.height, r.bitrate, r.url]);
         }

         await client.query('COMMIT');
         logger.info({ videoId, count: renditions.length }, 'Video renditions saved');
      } catch (err) {
         await client.query('ROLLBACK');
         logger.error({ videoId, err }, 'Failed to save renditions');
         throw new Error(`Failed to save renditions: ${(err as Error).message}`);
      } finally {
         client.release();
      }
   }

   async close(): Promise<void> {
      await this.pool.end();
   }
}
