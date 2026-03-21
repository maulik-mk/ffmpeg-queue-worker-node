/**
 * Base custom exception for all domain errors. Wraps the underlying `.cause` for traceability.
 * Features a `retryable` flag that signals to the queue wrapper whether to re-queue the job
 * (e.g., transient network issue) or fail it permanently (e.g., validation failure).
 */
export class WorkerError extends Error {
   public readonly retryable: boolean;

   constructor(message: string, retryable: boolean, options?: ErrorOptions) {
      super(message, options);
      this.name = this.constructor.name;
      this.retryable = retryable;
   }
}

export class SourceNotFoundError extends WorkerError {
   constructor(url: string, cause?: Error) {
      super(`Source video not found: ${url}`, false, { cause });
   }
}

export class ValidationError extends WorkerError {
   constructor(message: string) {
      super(message, false);
   }
}

export class TranscodeError extends WorkerError {
   constructor(message: string, cause?: Error) {
      super(message, true, { cause });
   }
}

export class UploadError extends WorkerError {
   constructor(message: string, cause?: Error) {
      super(message, true, { cause });
   }
}
