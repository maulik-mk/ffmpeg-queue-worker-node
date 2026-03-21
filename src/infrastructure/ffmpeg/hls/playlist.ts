import path from 'node:path';
import fs from 'node:fs/promises';
import { pino } from 'pino';
import type { VideoVariantMeta, AudioVariantMeta } from '../types.js';
import { HLS_CONSTANTS } from '../constants.js';
import { getBroadcastFrameRate } from '../encoding/flags.js';

const logger = pino({ name: 'PlaylistWriter' });

const ISO_639_1_MAP: Record<string, string> = {
   eng: 'en',
   hin: 'hi',
   spa: 'es',
   fra: 'fr',
   deu: 'de',
   jpn: 'ja',
   und: 'und',
};

const LANGUAGE_NAMES: Record<string, string> = {
   eng: 'English',
   hin: 'Hindi',
   spa: 'Spanish (LA)',
   fra: 'Français',
   deu: 'Deutsch',
   jpn: 'Japanese',
   und: 'Unknown',
};

function getAspectRatioString(width: number, height: number): string {
   const ratio = width / height;
   if (Math.abs(ratio - 16 / 9) < 0.05) return '16:9';
   if (Math.abs(ratio - 9 / 16) < 0.05) return '9:16';
   if (Math.abs(ratio - 1.85) < 0.05) return '1.85:1';
   if (Math.abs(ratio - 2.0) < 0.05) return '2.00:1';
   if (Math.abs(ratio - 2.39) < 0.05) return '2.39:1';
   return `${ratio.toFixed(2)}:1`;
}

function getPairedAudioNames(videoHeight: number, availableAudio: AudioVariantMeta[]): string[] {
   if (!availableAudio || availableAudio.length === 0) return [];

   const hasAudio = (name: string) => availableAudio.some((a) => a.name === name);
   const hardware: string[] = [];
   if (hasAudio('aud_ac3_51_t1')) hardware.push('aud_ac3_51_t1');
   if (hasAudio('aud_eac3_51_t1')) hardware.push('aud_eac3_51_t1');

   let stereo = availableAudio[0].name;
   if (videoHeight > 720 && hasAudio('aud_aac_lc_t4')) stereo = 'aud_aac_lc_t4';
   else if (videoHeight > 432 && hasAudio('aud_aac_lc_t3')) stereo = 'aud_aac_lc_t3';
   else if (videoHeight > 270 && hasAudio('aud_aac_lc_t2')) stereo = 'aud_aac_lc_t2';
   else if (hasAudio('aud_aac_he2_t1')) stereo = 'aud_aac_he2_t1';

   return [stereo, ...hardware];
}

async function getBandwidthForDir(dirPath: string): Promise<{ peak: number; avg: number }> {
   try {
      const manifestPath = path.join(dirPath, HLS_CONSTANTS.VARIANT_PLAYLIST_NAME);
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      const lines = manifestContent.split('\n');

      let totalBits = 0;
      let totalDuration = 0;
      let peakBitrate = 0;
      let currentDuration = 0;
      let currentByteRangeLength = 0;

      for (const line of lines) {
         const trimmed = line.trim();
         if (trimmed.startsWith('#EXTINF:'))
            currentDuration = parseFloat(trimmed.split(':')[1].split(',')[0]);
         else if (trimmed.startsWith('#EXT-X-BYTERANGE:'))
            currentByteRangeLength = parseInt(trimmed.substring(17).split('@')[0], 10);
         else if (
            !trimmed.startsWith('#') &&
            (trimmed.endsWith('.m4s') || trimmed.endsWith('.mp4'))
         ) {
            let bits = 0;
            if (currentByteRangeLength > 0) {
               bits = currentByteRangeLength * 8;
               currentByteRangeLength = 0;
            } else {
               const stat = await fs.stat(path.join(dirPath, trimmed.split('?')[0]));
               bits = stat.size * 8;
            }
            const bitrate = currentDuration > 0 ? Math.round(bits / currentDuration) : 0;
            totalBits += bits;
            totalDuration += currentDuration;
            if (bitrate > peakBitrate) peakBitrate = bitrate;
         }
      }
      if (totalDuration === 0) return { peak: 0, avg: 0 };
      return { peak: peakBitrate, avg: Math.round(totalBits / totalDuration) };
   } catch (e) {
      return { peak: 0, avg: 0 };
   }
}

export async function writeMasterPlaylist(
   outputDir: string,
   videoVariants: VideoVariantMeta[],
   audioRenditions: AudioVariantMeta[],
   sourceFrameRate?: number,
): Promise<void> {
   if (!videoVariants || videoVariants.length === 0) {
      throw new Error('Cannot write master playlist: No valid video variants provided.');
   }

   const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS', ''];

   const defaultVariant = videoVariants.reduce((prev, curr) =>
      Math.abs(curr.maxrate - 2000000) < Math.abs(prev.maxrate - 2000000) ? curr : prev,
   );
   const orderedVariants = [
      defaultVariant,
      ...videoVariants.filter((v) => v.name !== defaultVariant.name),
   ];

   const variantAudioMap = new Map<string, string[]>();
   const usedAudioNames = new Set<string>();

   for (const v of orderedVariants) {
      const paired = getPairedAudioNames(v.actualHeight, audioRenditions);
      variantAudioMap.set(v.name, paired);
      paired.forEach((name) => usedAudioNames.add(name));
   }

   let currentLangGroup = '';
   for (const audio of audioRenditions) {
      if (!usedAudioNames.has(audio.name)) continue;

      const displayName = !audio.title.startsWith('Track ')
         ? audio.title
         : LANGUAGE_NAMES[audio.language] || audio.language.toUpperCase();

      if (audio.language !== currentLangGroup) {
         lines.push(`#-- ${displayName} --`);
         currentLangGroup = audio.language;
      }

      const langAttr =
         audio.language === 'und'
            ? ''
            : `LANGUAGE="${ISO_639_1_MAP[audio.language] || audio.language}",`;
      const relativeUri = `../${audio.relativeUrl}/${HLS_CONSTANTS.VARIANT_PLAYLIST_NAME}`;

      lines.push(
         `#EXT-X-MEDIA:TYPE=AUDIO,NAME="${displayName}",GROUP-ID="${audio.name}",${langAttr}DEFAULT=${audio.streamIndex === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,CHANNELS="${audio.channels}",URI="${relativeUri}"`,
      );
   }
   lines.push('');

   for (const v of orderedVariants) {
      const videoDir = path.join(outputDir, v.relativeUrl);
      const videoBw = await getBandwidthForDir(videoDir);

      const pairedAudioNames = variantAudioMap.get(v.name) || [];
      const trueVideoAvg = videoBw.avg > 0 ? videoBw.avg : v.maxrate * 0.55;
      const trueVideoPeak = videoBw.peak > 0 ? videoBw.peak : v.maxrate;
      const actualVideoRange = v.profile === 'main10' ? 'PQ' : 'SDR';
      const relativeUri = `../${v.relativeUrl}/${HLS_CONSTANTS.VARIANT_PLAYLIST_NAME}`;
      const fpsInfo = getBroadcastFrameRate(sourceFrameRate);
      const frameRateString = fpsInfo ? fpsInfo.appleFormat : (v.frameRate ?? 30).toFixed(3);

      if (pairedAudioNames.length === 0) {
         lines.push(
            `#-- stream_${v.name.padEnd(16)} ${`${v.actualWidth}x${v.actualHeight}`.padEnd(11)} AR: ${getAspectRatioString(v.actualWidth, v.actualHeight).padEnd(8)} ${v.videoCodecTag.padEnd(14)} regular avg: ${(trueVideoAvg / 1_000_000).toFixed(1).padStart(4)} Mbps max: ${(trueVideoPeak / 1_000_000).toFixed(1).padStart(4)} Mbps --`,
         );

         const attributes = [
            `AVERAGE-BANDWIDTH=${Math.round(trueVideoAvg * 1.05)}`,
            `BANDWIDTH=${Math.round(trueVideoPeak * 1.05)}`,
            `VIDEO-RANGE=${actualVideoRange}`,
            `CLOSED-CAPTIONS=NONE`,
            `CODECS="${v.videoCodecTag}"`,
            `FRAME-RATE=${frameRateString}`,
            `RESOLUTION=${v.actualWidth}x${v.actualHeight}`,
         ].join(',');

         lines.push(`#EXT-X-STREAM-INF:${attributes}`, relativeUri);
         continue;
      }

      const repAudio =
         audioRenditions.find((ar) => ar.name === pairedAudioNames[0]) || audioRenditions[0];
      const repAudioBw = await getBandwidthForDir(path.join(outputDir, repAudio.relativeUrl));
      const trueRepAudioAvg = repAudioBw.avg > 0 ? repAudioBw.avg : repAudio.bitrate;
      const trueRepAudioPeak = repAudioBw.peak > 0 ? repAudioBw.peak : repAudio.bitrate;

      const commentPeak = Math.round((trueVideoPeak + trueRepAudioPeak) * 1.05);
      const commentAvg = Math.round((trueVideoAvg + trueRepAudioAvg) * 1.05);

      lines.push(
         `#-- stream_${v.name.padEnd(16)} ${`${v.actualWidth}x${v.actualHeight}`.padEnd(11)} AR: ${getAspectRatioString(v.actualWidth, v.actualHeight).padEnd(8)} ${v.videoCodecTag.padEnd(14)} regular avg: ${(commentAvg / 1_000_000).toFixed(1).padStart(4)} Mbps max: ${(commentPeak / 1_000_000).toFixed(1).padStart(4)} Mbps --`,
      );

      for (const audioName of pairedAudioNames) {
         const a = audioRenditions.find((ar) => ar.name === audioName) || audioRenditions[0];
         const audioBw = await getBandwidthForDir(path.join(outputDir, a.relativeUrl));

         const localPeakBandwidth = Math.round(
            (trueVideoPeak + (audioBw.peak > 0 ? audioBw.peak : a.bitrate)) * 1.05,
         );
         const localAvgBandwidth = Math.round(
            (trueVideoAvg + (audioBw.avg > 0 ? audioBw.avg : a.bitrate)) * 1.05,
         );

         let audioCodecTag = 'mp4a.40.2';
         if (a.codec === 'libfdk_aac' && a.profile === 'aac_he_v2') audioCodecTag = 'mp4a.40.29';
         else if (a.codec === 'ac3') audioCodecTag = 'ac-3';
         else if (a.codec === 'eac3') audioCodecTag = 'ec-3';

         const attributes = [
            `AVERAGE-BANDWIDTH=${localAvgBandwidth}`,
            `BANDWIDTH=${localPeakBandwidth}`,
            `VIDEO-RANGE=${actualVideoRange}`,
            `CLOSED-CAPTIONS=NONE`,
            `CODECS="${v.videoCodecTag},${audioCodecTag}"`,
            `AUDIO="${audioName}"`,
            `FRAME-RATE=${frameRateString}`,
            `RESOLUTION=${v.actualWidth}x${v.actualHeight}`,
         ].join(',');

         lines.push(`#EXT-X-STREAM-INF:${attributes}`, relativeUri);
      }
   }

   const masterPath = path.join(outputDir, HLS_CONSTANTS.MASTER_PLAYLIST_NAME);
   await fs.writeFile(masterPath, lines.join('\n'));
   logger.info({ masterPath }, 'Master playlist written');
}
