import type { ProgressCallback } from '../../domain/job.interface.js';

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

export type VideoVariantMeta = VideoProfile & {
   actualWidth: number;
   actualHeight: number;
   relativeUrl: string;
};

export type AudioVariantMeta = AudioProfile & {
   groupId?: string;
   sourceChannels: number;
   sourceCodec?: string;
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
