import type { ProgressCallback } from '../../domain/job.interface.js';

/**
 * Baseline constraints defining video multiplex arrays.
 * Binds explicit maxrate and bufsize to avoid CDN/Player network buffer starvation.
 */
export interface VideoProfile {
   tierNumber?: number;
   name: string;
   width: number;
   height: number;
   bitrate: number;
   maxrate: number;
   bufsize: number;
   hlsTime?: number;
   frameRate?: number;
   videoCodec?: string;
   videoCodecTag: string;
   videoRange?: string;
   preset: string;
   profile?: string;
   level?: string;
   crf?: number;
}

/**
 * Encodes deterministic track constraints per ITU limits.
 */
export interface AudioProfile {
   name: string;
   groupId?: string;
   channels: number;
   codec: string;
   profile?: string;
   bitrate: number;
   sampleRate: number;
   hardwareProfile: boolean;
   isAtmos?: boolean;
   isCinemaMaster?: boolean;
}

/**
 * Maps the abstract `VideoProfile` onto explicit bounding-box scale factors computed off `ffprobe` DAR constraints.
 */
export type VideoVariantMeta = VideoProfile & {
   actualWidth: number;
   actualHeight: number;
   relativeUrl: string;
};

/**
 * Merges surround-sound source maps from `AudioProfile` onto downmix definitions.
 */
export type AudioVariantMeta = AudioProfile & {
   groupId?: string;
   sourceChannels: number;
   sourceCodec?: string;
   language: string;
   streamIndex: number;
   title: string;
   relativeUrl: string;
};

/**
 * Forces spawn arrays onto sub-shell PIDs.
 */
export interface RunOptions {
   args: string[];
   label: string;
   videoId: string;
   onProgress?: ProgressCallback;
   duration?: number;
}

export const DEFAULT_WORK_DIR = '/tmp/worker';
