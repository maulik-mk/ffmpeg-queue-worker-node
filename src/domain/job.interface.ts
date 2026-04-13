/**
 * Explicit schema interfaces required across the ingestion boundaries (worker -> pg -> storage).
 */
export interface JobData {
   videoId: string;
   sourceUrl: string;
   userId: string;
   /** Resolves a callback POST upon zero-exit codes enabling loose-coupled status meshes. */
   webhookUrl?: string;
}

/**
 * Indexed mapping bound to libavformat streams array for track persistence.
 */
export interface AudioStreamInfo {
   index: number;
   codec: string;
   language: string;
   channels: number;
   title: string;
}

/**
 * Maps raw `ffprobe` JSON outputs into explicitly-typed constraints.
 */
export interface ProbeResult {
   duration: number;
   width: number;
   height: number;
   aspectRatio: string;
   originalAspectRatio: number;
   codec: string;
   fileSize: number;
   frameRate: number;
   audioStreams: AudioStreamInfo[];
   videoRange: string;
}

/**
 * Output artifact references mapped directly into CDN manifest namespaces.
 */
export interface VideoRendition {
   resolution: string;
   width: number;
   height: number;
   bitrate: number;
   /** Pre-built HTTP relative-blob URL mapping directly to EXT-X-STREAM-INF payloads. */
   url: string;
}

/**
 * Final memory resolution passed back up to the master BullMQ job processor.
 */
export interface TranscodeResult {
   /** Virtualized tmpfs / NVMe root mapping the segmented output arrays. */
   outputDir: string;
   renditions: VideoRendition[];
}

/**
 * Tracks row-level states in PostgreSQL to handle pre-emption and idempotency locks.
 */
export type JobStatus =
   | 'queued'
   | 'processing'
   | 'transcoding'
   | 'uploading'
   | 'completed'
   | 'failed';

/**
 * Implements the atomic transactions expected off `pg` client handles.
 */
export interface VideoRepository {
   updateStatus(
      videoId: string,
      status: JobStatus,
      metadata?: Record<string, unknown>,
   ): Promise<void>;

   saveMetadata(videoId: string, metadata: ProbeResult): Promise<void>;
   saveRenditions(videoId: string, renditions: VideoRendition[]): Promise<void>;
}

/**
 * Maps the internal Node disk blocks outwards to object blob spaces via multipart SDK uploads.
 */
export interface StorageProvider {
   /**
    * Iterates the segment manifests onto Azure/AWS, injecting exact `video/mp4` and `application/vnd.apple.mpegurl` headers.
    * @returns Fully qualified FQDN for the resulting master array.
    */
   uploadHLS(folderPath: string, videoId: string, onProgress?: ProgressCallback): Promise<string>;
}

/**
 * Progress delegate invoked off chunk offsets per internal `ffprobe` loop bindings.
 */
export type ProgressCallback = (data: { variant: string; percent: number }) => void;

/**
 * Abstract boundary wrapping child_process execution of the native OS ffmpeg binary.
 */
export interface TranscodeProvider {
   /**
    * Synchronous `spawn` intercept for the inbound libavformat properties array.
    */
   probe(sourceUrl: string): Promise<ProbeResult>;

   /**
    * Pushes bounded stream definitions through the libx265 / libx264 cores.
    */
   transcodeHLS(
      sourceUrl: string,
      videoId: string,
      sourceWidth: number,
      sourceHeight: number,
      sourceDuration: number,
      onProgress?: ProgressCallback,
      sourceFrameRate?: number,
      audioStreams?: AudioStreamInfo[],
      videoRange?: string,
   ): Promise<TranscodeResult>;

   /**
    * Empties the `tmpfs` blocks post-execution, strictly avoiding disk bloat errors.
    */
   cleanup(videoId: string): Promise<void>;
}

/**
 * Dependency-injected service orchestrating the state/execute lifecycle of worker units.
 */
export interface ProcessVideoUseCase {
   execute(job: JobData, onProgress?: ProgressCallback): Promise<void>;
}
