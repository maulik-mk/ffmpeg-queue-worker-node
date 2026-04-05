import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pino } from 'pino';
import { config } from '../../../config/env.js';
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
   if (Math.abs(ratio - 16 / 9) < 0.02) return '16:9';
   if (Math.abs(ratio - 9 / 16) < 0.02) return '9:16';
   if (Math.abs(ratio - 4 / 3) < 0.02) return '4:3';
   if (Math.abs(ratio - 1.0) < 0.02) return '1:1';
   if (Math.abs(ratio - 1.85) < 0.02) return '1.85:1';
   if (Math.abs(ratio - 2.0) < 0.02) return '2.00:1';
   if (Math.abs(ratio - 2.35) < 0.02) return '2.35:1';
   if (Math.abs(ratio - 2.39) < 0.02) return '2.39:1';
   if (Math.abs(ratio - 1.9) < 0.02) return '1.90:1';
   return `${ratio.toFixed(2)}:1`;
}

function formatBitrate(bps: number): string {
   if (bps < 1_000_000) {
      return `${Math.round(bps / 1000)
         .toString()
         .padStart(4)} kbps`;
   }
   return `${(bps / 1_000_000).toFixed(1).padStart(4)} Mbps`;
}

function getStableId(name: string, extra?: string): string {
   const input = `${name}${extra ? `-${extra}` : ''}`;
   return createHash('sha256').update(input).digest('hex');
}

function getPairedAudioNames(
   videoWidth: number,
   videoHeight: number,
   availableAudio: AudioVariantMeta[],
): string[] {
   if (!availableAudio || availableAudio.length === 0) return [];

   const maxDim = Math.max(videoWidth, videoHeight);
   const hasAudio = (name: string) => availableAudio.some((a) => a.name === name);
   const getGroupId = (name: string) =>
      availableAudio.find((a) => a.name === name)?.groupId || name;

   const hardware: string[] = [];
   if (hasAudio('audio-ac3')) hardware.push(getGroupId('audio-ac3'));
   if (hasAudio('audio-atmos')) hardware.push(getGroupId('audio-atmos'));

   let stereoName = 'audio-stereo-64';
   if (maxDim >= 1280 && hasAudio('audio-stereo-160')) stereoName = 'audio-stereo-160';
   else if (maxDim >= 854 && hasAudio('audio-stereo-128')) stereoName = 'audio-stereo-128';
   else if (hasAudio('audio-stereo-64')) stereoName = 'audio-stereo-64';
   else stereoName = availableAudio[0].name;

   return [getGroupId(stereoName), ...hardware];
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
               const filename = trimmed.split('/').pop()?.split('?')[0];
               if (!filename) continue;
               const stat = await fs.stat(path.join(dirPath, filename));
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

   const getCodecWeight = (v: VideoVariantMeta) => {
      if (v.videoCodecTag.startsWith('avc')) return 1;
      if (v.videoCodecTag.startsWith('hvc') && v.videoRange === 'SDR') return 2;
      if (v.videoCodecTag.startsWith('hvc') && v.videoRange === 'PQ') return 3;
      if (v.videoCodecTag.startsWith('dv')) return 4;
      return 5;
   };

   const anchorVariants = videoVariants.filter((v) => v.tierNumber === 7);
   const otherVariants = videoVariants.filter((v) => v.tierNumber !== 7);

   anchorVariants.sort((a, b) => getCodecWeight(a) - getCodecWeight(b));

   otherVariants.sort((a, b) => {
      const weightA = getCodecWeight(a);
      const weightB = getCodecWeight(b);
      if (weightA !== weightB) return weightA - weightB;
      return a.maxrate - b.maxrate;
   });

   const orderedVariants = [...anchorVariants, ...otherVariants];

   const variantAudioMap = new Map<string, string[]>();
   const usedAudioNames = new Set<string>();

   for (const v of orderedVariants) {
      const paired = getPairedAudioNames(v.actualWidth, v.actualHeight, audioRenditions);
      variantAudioMap.set(v.name, paired);
      paired.forEach((name) => usedAudioNames.add(name));
   }

   let currentLangGroup = '';
   for (const audio of audioRenditions) {
      const audioGroupId = audio.groupId || audio.name;
      if (!usedAudioNames.has(audioGroupId)) continue;

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
      const stableRenditionId = getStableId(audio.name, audio.language);

      const channelAttr = audio.isAtmos ? '16/JOC' : audio.channels.toString();

      lines.push(
         `#EXT-X-MEDIA:TYPE=AUDIO,NAME="${displayName}",GROUP-ID="${audioGroupId}",${langAttr}DEFAULT=${
            audio.streamIndex === 0 ? 'YES' : 'NO'
         },AUTOSELECT=YES,CHANNELS="${channelAttr}",STABLE-RENDITION-ID="${stableRenditionId}",URI="${relativeUri}"`,
      );
   }
   lines.push('');

   for (const v of orderedVariants) {
      const videoDir = path.join(outputDir, v.relativeUrl);
      const videoBw = await getBandwidthForDir(videoDir);

      const pairedAudioNames = variantAudioMap.get(v.name) || [];
      const trueVideoAvg = videoBw.avg > 0 ? videoBw.avg : v.bitrate * 0.9;
      const trueVideoPeak = videoBw.peak > 0 ? videoBw.peak : v.maxrate;

      const isDovi = v.videoCodecTag.startsWith('dv');
      const actualVideoRange = isDovi || v.profile === 'main10' ? 'PQ' : 'SDR';
      const relativeUri = `../${v.relativeUrl}/${HLS_CONSTANTS.VARIANT_PLAYLIST_NAME}`;
      const fpsInfo = getBroadcastFrameRate(sourceFrameRate);
      const frameRateString = fpsInfo ? fpsInfo.aFormat : (v.frameRate ?? 30).toFixed(3);

      if (pairedAudioNames.length === 0) {
         lines.push(
            `#-- ${v.name.padEnd(16)} ${`${v.actualWidth}x${v.actualHeight}`.padEnd(11)} AR: ${getAspectRatioString(v.actualWidth, v.actualHeight).padEnd(8)} ${v.videoCodecTag.padEnd(14)} regular avg: ${formatBitrate(trueVideoAvg)} max: ${formatBitrate(trueVideoPeak)} --`,
         );

         const attributes = [
            `AVERAGE-BANDWIDTH=${Math.round(trueVideoAvg)}`,
            `BANDWIDTH=${trueVideoPeak}`,
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
         audioRenditions.find((ar) => (ar.groupId || ar.name) === pairedAudioNames[0]) ||
         audioRenditions[0];
      const repAudioBw = await getBandwidthForDir(path.join(outputDir, repAudio.relativeUrl));
      const trueRepAudioAvg = repAudioBw.avg > 0 ? repAudioBw.avg : repAudio.bitrate;
      const trueRepAudioPeak = repAudioBw.peak > 0 ? repAudioBw.peak : repAudio.bitrate;

      lines.push(
         `#-- ${v.name.padEnd(16)} ${`${v.actualWidth}x${v.actualHeight}`.padEnd(
            11,
         )} AR: ${getAspectRatioString(v.actualWidth, v.actualHeight).padEnd(
            8,
         )} ${v.videoCodecTag.padEnd(14)} regular avg: ${formatBitrate(
            Math.round(trueVideoAvg + trueRepAudioAvg),
         )} max: ${formatBitrate(trueVideoPeak + trueRepAudioPeak)} --`,
      );

      for (const audioGroupId of pairedAudioNames) {
         const a =
            audioRenditions.find((ar) => (ar.groupId || ar.name) === audioGroupId) ||
            audioRenditions[0];
         const audioBw = await getBandwidthForDir(path.join(outputDir, a.relativeUrl));

         const audioAvg = audioBw.avg > 0 ? audioBw.avg : a.bitrate;
         const audioPeak = audioBw.peak > 0 ? audioBw.peak : a.bitrate;

         const localAvgBandwidth = Math.round(trueVideoAvg + audioAvg);
         const localPeakBandwidth = Math.round(trueVideoPeak + audioPeak);

         let audioCodecTag = 'mp4a.40.2';
         if (a.profile === 'aac_he') audioCodecTag = 'mp4a.40.5';
         else if (a.profile === 'aac_he_v2') audioCodecTag = 'mp4a.40.29';
         else if (a.codec === 'ac3') audioCodecTag = 'ac-3';
         else if (a.codec === 'eac3') audioCodecTag = 'ec-3';

         const maxDim = Math.max(v.actualWidth, v.actualHeight);
         const isHighDef = maxDim >= 1280;
         const isUltraHighDef =
            maxDim >= 2560 || v.profile === 'main10' || v.videoCodecTag.startsWith('dvh1');

         let hdcpLevel = 'NONE';
         if (isUltraHighDef) hdcpLevel = 'TYPE-1';
         else if (isHighDef) hdcpLevel = 'TYPE-0';

         const stableVariantId = getStableId(v.name, v.videoCodecTag);

         const attributes = [
            `AVERAGE-BANDWIDTH=${localAvgBandwidth}`,
            `BANDWIDTH=${localPeakBandwidth}`,
            `VIDEO-RANGE=${actualVideoRange}`,
            `CLOSED-CAPTIONS=NONE`,
            `CODECS="${v.videoCodecTag},${audioCodecTag}"`,
            `AUDIO="${audioGroupId}"`,
            `FRAME-RATE=${frameRateString}`,
            `HDCP-LEVEL=${hdcpLevel}`,
            `RESOLUTION=${v.actualWidth}x${v.actualHeight}`,
            `STABLE-VARIANT-ID="${stableVariantId}"`,
         ].join(',');

         lines.push(`#EXT-X-STREAM-INF:${attributes}`, relativeUri);
      }
   }

   const masterPath = path.join(outputDir, HLS_CONSTANTS.MASTER_PLAYLIST_NAME);
   await fs.writeFile(masterPath, lines.join('\n'));
   logger.info({ masterPath }, 'Master playlist written');
}
