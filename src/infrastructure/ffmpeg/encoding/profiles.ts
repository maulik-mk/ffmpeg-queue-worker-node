import { createRequire } from 'node:module';
import type { VideoProfile, AudioProfile, VideoVariantMeta, AudioVariantMeta } from '../types.js';
import type { AudioStreamInfo } from '../../../domain/job.interface.js';

const require = createRequire(import.meta.url);
const videoConfig = require('./profiles/video.json') as Record<string, VideoProfile[]>;
const audioConfig = require('./profiles/audio.json') as AudioProfile[];

const VIDEO_PROFILES: VideoProfile[] = [
   ...(videoConfig.h264_sdr || []),
   ...(videoConfig.h265_sdr || []),
   ...(videoConfig.h265_hdr || []),
];

const AUDIO_PROFILES: AudioProfile[] = audioConfig;

export function filterActiveVideoProfiles(
   sourceWidth: number,
   sourceHeight: number,
   videoRange: string = 'SDR',
): VideoProfile[] {
   const isVertical = sourceHeight > sourceWidth;

   let compatibleProfiles = VIDEO_PROFILES;
   if (videoRange === 'SDR') {
      compatibleProfiles = VIDEO_PROFILES.filter((p) => !p.name.includes('hdr'));
   }

   const active = compatibleProfiles.filter((v) => {
      const standardWidth = Math.round((v.height * 16) / 9);
      if (isVertical) {
         return sourceHeight >= standardWidth || sourceWidth >= v.height;
      } else {
         return sourceWidth >= standardWidth || sourceHeight >= v.height;
      }
   });

   if (active.length === 0) {
      active.push(compatibleProfiles[0] || VIDEO_PROFILES[0]);
   }

   return active;
}

export function computeVideoMetadata(
   profiles: VideoProfile[],
   sourceWidth: number,
   sourceHeight: number,
   complexityMultiplier: number = 1.0,
): Omit<VideoVariantMeta, 'relativeUrl'>[] {
   const activeProfiles = profiles;

   const isVertical = sourceHeight > sourceWidth;

   return activeProfiles.map((profile) => {
      const standardWidth = Math.round((profile.height * 16) / 9);
      let maxBoxWidth = standardWidth;
      let maxBoxHeight = profile.height;

      if (isVertical) {
         maxBoxWidth = profile.height;
         maxBoxHeight = standardWidth;
      }

      const scaleWidth = maxBoxWidth / sourceWidth;
      const scaleHeight = maxBoxHeight / sourceHeight;
      const scale = Math.min(scaleWidth, scaleHeight, 1.0);

      const outWidth = sourceWidth * scale;
      const outHeight = sourceHeight * scale;

      const actualWidth = Math.round(outWidth / 2) * 2;
      const actualHeight = Math.round(outHeight / 2) * 2;

      const dynamicMaxrate = Math.round(profile.maxrate * complexityMultiplier);
      const dynamicBufsize = Math.round(profile.bufsize * complexityMultiplier);
      const dynamicBitrate = Math.round(profile.bitrate * complexityMultiplier);

      return {
         ...profile,
         actualWidth,
         actualHeight,
         bitrate: dynamicBitrate,
         maxrate: dynamicMaxrate,
         bufsize: dynamicBufsize,
      };
   });
}

export function computeAudioMetadata(
   sourceAudioStreams: AudioStreamInfo[] = [],
): Omit<AudioVariantMeta, 'relativeUrl'>[] {
   const renditions: Omit<AudioVariantMeta, 'relativeUrl'>[] = [];

   for (const stream of sourceAudioStreams) {
      for (const profile of AUDIO_PROFILES) {
         if (profile.hardwareProfile && stream.channels < 2) continue;

         renditions.push({
            ...profile,
            sourceChannels: stream.channels,
            language: stream.language,
            streamIndex: stream.index,
            title: stream.title,
         });
      }
   }

   return renditions;
}
