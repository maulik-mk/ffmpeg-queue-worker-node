/**
 * Runtime configuration validated via Zod schema.
 * Designed to fail-fast: if any required variable is missing or malformed, the process crashes
 * immediately before attempting to bind ports or connect to the database.
 */
import { z } from 'zod';

/**
 * Strips literal quotes injected by `.env` loaders to prevent DSN/connection string parsing errors.
 */
const unquotedString = z.string().transform((s) => s.replace(/^["'](.*?)["']$/, '$1'));

const envSchema = z.object({
   NODE_ENV: unquotedString
      .pipe(z.enum(['development', 'production', 'test']))
      .default('development'),
   PORT: z.coerce.number().default(3000),
   REDIS_URL: unquotedString.pipe(z.string().url()),
   WORKER_CONCURRENCY: z.coerce.number().default(1),

   TEST_DURATION_SECONDS: z.coerce.number().optional(),
   HLS_OUTPUT_MODE: unquotedString.pipe(z.enum(['SINGLE_FILE', 'SEGMENTED'])).default('SEGMENTED'),

   JOB_LOCK_DURATION_MS: z.coerce.number().default(120000),
   JOB_LOCK_RENEW_MS: z.coerce.number().default(30000),

   AZURE_UPLOAD_BATCH_SIZE: z.coerce.number().default(20),
   AZURE_UPLOAD_RETRIES: z.coerce.number().default(3),
   AZURE_STORAGE_CONNECTION_STRING: unquotedString.optional(),
   AZURE_STORAGE_ACCOUNT_URL: unquotedString.optional(),
   AZURE_STORAGE_CONTAINER_NAME: unquotedString.pipe(
      z.string().min(1, 'AZURE_STORAGE_CONTAINER_NAME is required'),
   ),
   CONTAINER_DIRECTORY_1: unquotedString.pipe(
      z.string().min(3, 'CONTAINER_DIRECTORY_1 is required'),
   ),
   CORS_ORIGIN: unquotedString.default('*'),
   DATABASE_URL: unquotedString.pipe(z.string().min(1, 'DATABASE_URL is required')),
});

/**
 * Validated application configuration. Extracted directly from `process.env`.
 * @throws {ZodError} If validation fails during module load.
 */
export const config: z.infer<typeof envSchema> = envSchema.parse(process.env);
