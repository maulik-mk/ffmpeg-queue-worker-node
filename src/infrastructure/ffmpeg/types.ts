import type { ProgressCallback } from '../../domain/job.interface.js';

export interface VideoProfile {
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
}

export interface AudioProfile {
   name: string;
   channels: number;
   codec: string;
   profile?: string;
   bitrate: number;
   sampleRate: number;
   hardwareProfile: boolean;
}

export type VideoVariantMeta = VideoProfile & {
   actualWidth: number;
   actualHeight: number;
   relativeUrl: string;
};

export type AudioVariantMeta = AudioProfile & {
   sourceChannels: number;
   language: string;
   streamIndex: number;
   title: string;
   relativeUrl: string;
};

export interface RunOptions {
   args: string[];
   label: string;
   videoId: string;
   onProgress?: ProgressCallback;
   duration?: number;
}

export const DEFAULT_WORK_DIR = '/tmp/worker';
