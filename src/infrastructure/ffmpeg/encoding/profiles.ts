import { createRequire } from 'node:module';
import { config } from '../../../config/env.js';
import type { VideoProfile, AudioProfile, VideoVariantMeta, AudioVariantMeta } from '../types.js';
import type { AudioStreamInfo } from '../../../domain/job.interface.js';

const require = createRequire(import.meta.url);

const ABR_VIDEO = {
   avc_sdr: (require('./ABR/video/avc.sdr.json') as VideoProfile[]).map((v, i) => ({
      ...v,
      tierNumber: i + 1,
   })),
   hvc_sdr: (require('./ABR/video/hvc.sdr.json') as VideoProfile[]).map((v, i) => ({
      ...v,
      tierNumber: i + 1,
   })),
   hvc_pq: (require('./ABR/video/hvc.pq.json') as VideoProfile[]).map((v, i) => ({
      ...v,
      tierNumber: i + 1,
   })),
   dvh_pq: (require('./ABR/video/dvh.pq.json') as VideoProfile[]).map((v, i) => ({
      ...v,
      tierNumber: i + 1,
   })),
};

const cleanDomain = config.DOMAIN_SUBDOMAIN_NAME?.replace(/^https?:\/\//, '').replace(/\/$/, '');

const ABR_AUDIO = (require('./ABR/audio/audio.json') as AudioProfile[]).map((a) => ({
   ...a,
   groupId: cleanDomain ? `${a.name}-${cleanDomain}` : a.name,
   name: a.name,
}));

const VIDEO_PROFILES: VideoProfile[] = [
   ...ABR_VIDEO.avc_sdr,
   ...ABR_VIDEO.hvc_sdr,
   ...ABR_VIDEO.hvc_pq,
   ...ABR_VIDEO.dvh_pq,
];

const AUDIO_PROFILES: AudioProfile[] = ABR_AUDIO;

/**
 * Picks the video resolutions to generate based on the original video's size and color format.
 * Drops quality levels that would stretch the video larger than its original size.
 *
 * @param sourceWidth - Width of the original video.
 * @param sourceHeight - Height of the original video.
 * @param videoRange - The video color range ('SDR', 'PQ', 'HLG'). Defaults to 'SDR'.
 * @returns A list of video profiles that the encoder should generate.
 */
export function filterActiveVideoProfiles(
   sourceWidth: number,
   sourceHeight: number,
   videoRange: string = 'SDR',
): VideoProfile[] {
   let compatibleProfiles: VideoProfile[] = [];

   // Developer Override: Force a specific profile group for testing
   if (config.TEST_VIDEO_PROFILE && config.TEST_VIDEO_PROFILE !== 'ALL') {
      const forcedKey = config.TEST_VIDEO_PROFILE as keyof typeof ABR_VIDEO;
      compatibleProfiles = [...ABR_VIDEO[forcedKey]];
   } else if (videoRange === 'SDR') {
      compatibleProfiles = [...ABR_VIDEO.avc_sdr, ...ABR_VIDEO.hvc_sdr];
   } else if (videoRange === 'PQ' || videoRange === 'HLG') {
      compatibleProfiles = [...ABR_VIDEO.hvc_pq, ...ABR_VIDEO.dvh_pq];
   } else {
      compatibleProfiles = VIDEO_PROFILES;
   }

   const isVertical = sourceHeight > sourceWidth;

   const active = compatibleProfiles.filter((v) => {
      const standardWidth = Math.round((v.height * 16) / 9);
      if (isVertical) {
         return sourceHeight >= standardWidth || sourceWidth >= v.height;
      } else {
         return sourceWidth >= standardWidth || sourceHeight >= v.height;
      }
   });

   if (active.length === 0) {
      active.push(compatibleProfiles[0] || ABR_VIDEO.avc_sdr[0]);
   }

   return active;
}

/**
 * Calculates the exact pixel dimensions and bitrates for each video quality level.
 * Ensures the video scales correctly without stretching or breaking the aspect ratio.
 *
 * @param profiles - The chosen video profiles to generate.
 * @param sourceWidth - Width of the original video.
 * @param sourceHeight - Height of the original video.
 * @param complexityMultiplier - Bitrate adjustment factor based on how complex the video is.
 * @returns A list of video settings ready for the ffmpeg encoder.
 */
export function computeVideoMetadata(
   profiles: VideoProfile[],
   sourceWidth: number,
   sourceHeight: number,
   complexityMultiplier: number = 1.0,
): Omit<VideoVariantMeta, 'relativeUrl'>[] {
   const activeProfiles = profiles;
   const sourceArea = sourceWidth * sourceHeight;
   const sourceAspectRatio = sourceWidth / sourceHeight;

   return activeProfiles.map((profile) => {
      const standardWidth = Math.round((profile.height * 16) / 9);
      const targetArea = standardWidth * profile.height;

      let scale = Math.sqrt(targetArea / sourceArea);
      scale = Math.min(scale, 1.0);

      let maxWidthLimit = Infinity;
      let maxHeightLimit = Infinity;

      if (standardWidth >= 1920) {
         maxWidthLimit = standardWidth;
         maxHeightLimit = profile.height;
      } else if (standardWidth <= 864) {
         maxWidthLimit = 864;
         maxHeightLimit = 486;
      } else {
         maxWidthLimit = standardWidth * 1.25;
         maxHeightLimit = profile.height * 1.25;
      }

      if (sourceHeight > sourceWidth) {
         const temp = maxWidthLimit;
         maxWidthLimit = maxHeightLimit;
         maxHeightLimit = temp;
      }

      if (sourceWidth * scale > maxWidthLimit) {
         scale = maxWidthLimit / sourceWidth;
      }
      if (sourceHeight * scale > maxHeightLimit) {
         scale = maxHeightLimit / sourceHeight;
      }

      let exactWidth, exactHeight, actualWidth, actualHeight;

      if (sourceWidth >= sourceHeight) {
         exactHeight = sourceHeight * scale;
         actualHeight = Math.floor(exactHeight / 2) * 2;
         exactWidth = actualHeight * sourceAspectRatio;
         actualWidth = Math.round(exactWidth / 2) * 2;
      } else {
         exactWidth = sourceWidth * scale;
         actualWidth = Math.floor(exactWidth / 2) * 2;
         exactHeight = actualWidth / sourceAspectRatio;
         actualHeight = Math.round(exactHeight / 2) * 2;
      }

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

/**
 * Figures out which audio qualities to generate based on the original audio tracks.
 * Handles keeping multiple languages and detecting high-quality surround sound (like Atmos).
 *
 * @param sourceAudioStreams - The audio streams found in the original video.
 * @returns A list of audio settings ready for the ffmpeg encoder.
 */
export function computeAudioMetadata(
   sourceAudioStreams: AudioStreamInfo[] = [],
): AudioVariantMeta[] {
   const renditions: AudioVariantMeta[] = [];

   for (const stream of sourceAudioStreams) {
      for (const profile of AUDIO_PROFILES) {
         if (profile.hardwareProfile && stream.channels < 2) continue;

         const isAtmosCapableCodec = stream.codec === 'eac3' || stream.codec === 'truehd';
         const isAtmosSource = isAtmosCapableCodec && stream.channels >= 6;

         if (profile.isAtmos && !isAtmosSource) continue;

         renditions.push({
            ...profile,
            groupId: profile.groupId,
            sourceChannels: stream.channels,
            sourceCodec: stream.codec,
            language: stream.language,
            streamIndex: stream.index,
            title: stream.title,
            relativeUrl: '',
            isAtmos: profile.isAtmos && isAtmosSource,
         });
      }
   }

   return renditions;
}
