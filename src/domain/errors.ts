/**
 * Derived exception class enforcing `{ retryable: boolean }` properties.
 * Designed explicitly so the BullMQ execution loop can discriminate between `EIO` / network transient faults
 * versus deterministic decoder/syntax panics which will never succeed.
 */
export class WorkerError extends Error {
   public readonly retryable: boolean;

   constructor(message: string, retryable: boolean, options?: ErrorOptions) {
      super(message, options);
      this.name = this.constructor.name;
      this.retryable = retryable;
   }
}

/**
 * Maps to HTTP 404/403 closures when resolving `sourceUrl` blobs into `import { pipeline }`.
 */
export class SourceNotFoundError extends WorkerError {
   constructor(url: string, cause?: Error) {
      super(`Source video not found: ${url}`, false, { cause });
   }
}

/**
 * Thrown strictly when `ffprobe` JSON parsing misses `codec_type === 'video'` segments,
 * preventing OOM exceptions across downstream multiplex mapping arrays.
 */
export class ValidationError extends WorkerError {
   constructor(message: string) {
      super(message, false);
   }
}

/**
 * Thrown dynamically upon `code !== 0` closures from spawned `ffmpeg` PIDs.
 * Allows `retryable=true` scaling to bypass transient OS thread allocation panics.
 */
export class TranscodeError extends WorkerError {
   constructor(message: string, cause?: Error) {
      super(message, true, { cause });
   }
}

/**
 * Bounds Azure/S3 multipart SDK connection strings resetting during `BlockBlobClient.upload()`.
 */
export class UploadError extends WorkerError {
   constructor(message: string, cause?: Error) {
      super(message, true, { cause });
   }
}
