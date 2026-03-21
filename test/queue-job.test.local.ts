/**
 * Local E2E demo script used to test the video-processing pipeline.
 *
 * This file acts as a lightweight simulation of the main backend. It inserts
 * a test record into Postgres and enqueues a BullMQ job so the FFmpeg worker
 * (microservice) can pick it up and process the video.
 *
 * The purpose of this script is to validate the full processing flow locally:
 *
 * Backend (simulated) → Postgres → BullMQ Queue → FFmpeg Worker → Video Processing
 *
 * This is only a small demo/test @utility and is not part of the production
 * backend logic.
 *
 * -----------------------------------------------------------------------------
 * Required environment variables (defined in `.env`)
 * @See [.env.example](https://github.com/maulik-mk/ffmpeg-queue-worker-node/blob/main/.env.example)
 * -----------------------------------------------------------------------------
 *
 * | Variable               | Description                                      |
 * | ---------------------- | ------------------------------------------------ |
 * | `REDIS_URL`            | Redis connection URL (`redis://` or `rediss://`) |
 * | `DATABASE_URL`         | Postgres database URL                            |
 * | `RAW_VIDEO_SOURCE_URL` | Public URL of the source video to process        |
 *
 * -----------------------------------------------------------------------------
 * Optional environment variables
 * -----------------------------------------------------------------------------
 *
 * | Variable          | Default       | Description                          |
 * | ----------------- | ------------- | ------------------------------------ |
 * | `HLS_OUTPUT_MODE` | `"SEGMENTED"` | `"SEGMENTED"` or `"SINGLE_FILE"`     |
 *
 * -----------------------------------------------------------------------------
 * HLS Output Modes
 * -----------------------------------------------------------------------------
 *
 * SEGMENTED
 * ---------
 * FFmpeg outputs each HLS segment as a separate fMP4 (`.m4s`) file along with
 * an initialization segment. This is the standard HLS VOD layout.
 *
 * Player behavior:
 * - Fetches small segments on demand
 * - Playback can begin after the first segment
 * - Adaptive bitrate switching happens at segment boundaries
 * - Seeking targets individual segments
 *
 * Infrastructure implications:
 * - Per-segment CDN caching and invalidation
 * - Parallel uploads to Azure Blob Storage
 * - Larger object count per video
 *
 * SINGLE_FILE
 * -----------
 * FFmpeg appends all media data into a single fMP4 file per variant and
 * references byte ranges via `EXT-X-BYTERANGE`.
 *
 * Player behavior:
 * - Uses HTTP Range requests
 * - Playback, ABR switching, and seeking work normally on compliant CDNs
 * - May buffer if byte-range caching is poorly supported
 *
 * Infrastructure implications:
 * - Fewer objects stored in Azure Blob Storage
 * - Simpler storage management and cleanup
 * - Entire variant must upload before the manifest becomes usable
 *
 * -----------------------------------------------------------------------------
 * Usage
 * -----------------------------------------------------------------------------
 *
 * ```sh
 * pnpm run dev:local:test:job
 * pnpm run dev:local:e2e
 * ```
 *
 * -----------------------------------------------------------------------------
 * References
 * -----------------------------------------------------------------------------
 *
 * @See `../.env.example` for the full list of supported environment variables.
 */

import { Queue } from "bullmq";
import { pino } from "pino";
import { v7 as uuidv7 } from "uuid";

const logger = pino({ name: "QueueTestJob" });
const QUEUE_NAME = "video-processing";

const REQUIRED_ENV = ["REDIS_URL", "DATABASE_URL", "RAW_VIDEO_SOURCE_URL"] as const;

/**
 * Validates that all required environment variables are present.
 *
 * @returns Resolved environment configuration.
 * @throws Logs missing keys and exits with code `1` if any are absent.
 */
function validateEnv(): {
    redisUrl: string;
    databaseUrl: string;
    sourceUrl: string;
    hlsOutputMode: string;
} {
    const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        logger.error(
            { missing },
            `Missing required environment variable(s). Add them to your .env file and retry.`,
        );
        process.exit(1);
    }

    return {
        redisUrl: process.env.REDIS_URL!,
        databaseUrl: process.env.DATABASE_URL!,
        sourceUrl: process.env.RAW_VIDEO_SOURCE_URL!,
        hlsOutputMode: process.env.HLS_OUTPUT_MODE ?? "SEGMENTED",
    };
}

/**
 * Parses a Redis URL into a BullMQ-compatible connection object.
 *
 * @param redisUrl - Full Redis connection URL (`redis://` or `rediss://`).
 * @returns Connection options including optional TLS configuration.
 */
function parseRedisConnection(redisUrl: string) {
    const url = new URL(redisUrl);
    return {
        host: url.hostname,
        port: parseInt(url.port),
        username: url.username,
        password: url.password,
        tls: url.protocol === "rediss:" ? { rejectUnauthorized: false } : undefined,
    };
}

/**
 * Entry point — connects to Redis, seeds Postgres, and enqueues a
 * `process-video` job.
 */
async function main() {
    const env = validateEnv();
    const videoId = uuidv7();

    // #1. Connect to Redis
    logger.info("Connecting to Redis…");
    const connection = parseRedisConnection(env.redisUrl);
    const queue = new Queue(QUEUE_NAME, { connection });

    // #2. Seed the database
    logger.info({ videoId }, "Seeding Postgres…");
    const pg = await import("pg");
    const connectionString = env.databaseUrl;
    const pool = new pg.default.Pool({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await pool.query(
            `INSERT INTO videos (id, user_id, source_url, status) VALUES ($1, $2, $3, $4)`,
            [videoId, "test-user-local", env.sourceUrl, "queued"],
        );
    } catch (err) {
        logger.error({ err }, "Failed to seed database");
        await pool.end();
        await queue.close();
        process.exit(1);
    }
    await pool.end();
    logger.info("Database seeded successfully");

    // #3. Enqueue the job
    logger.info({ videoId, sourceUrl: env.sourceUrl }, "Adding job to queue…");

    await queue.add("process-video", {
        videoId,
        sourceUrl: env.sourceUrl,
        userId: "test-user-local",
        hlsOutputMode: env.hlsOutputMode,
        webhookUrl: null,
    });

    logger.info("Job added successfully — start the worker to process it.");
    await queue.close();
}

main();
