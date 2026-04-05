export interface JobData {
   videoId: string;
   sourceUrl: string;
   userId: string;
   webhookUrl?: string;
}

export interface AudioStreamInfo {
   index: number;
   codec: string;
   language: string;
   channels: number;
   title: string;
}

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

export interface VideoRendition {
   resolution: string;
   width: number;
   height: number;
   bitrate: number;
   url: string;
}

export interface TranscodeResult {
   outputDir: string;
   renditions: VideoRendition[];
}

export type JobStatus =
   | 'queued'
   | 'processing'
   | 'transcoding'
   | 'uploading'
   | 'completed'
   | 'failed';

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
 * Dependency-inversion interface for blob storage providers (e.g., Azure Blob Storage, AWS S3).
 */
export interface StorageProvider {
   uploadHLS(folderPath: string, videoId: string, onProgress?: ProgressCallback): Promise<string>;
}

export type ProgressCallback = (data: { variant: string; percent: number }) => void;

/**
 * Domain boundary around the native FFmpeg system binary.
 * Implementors must guarantee that `cleanup()` removes all trailing artifacts from the OS.
 */
export interface TranscodeProvider {
   probe(sourceUrl: string): Promise<ProbeResult>;

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

   cleanup(videoId: string): Promise<void>;
}

export interface ProcessVideoUseCase {
   execute(job: JobData, onProgress?: ProgressCallback): Promise<void>;
}
