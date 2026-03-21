import { spawn } from 'node:child_process';
import { pino } from 'pino';
import { TranscodeError, ValidationError, SourceNotFoundError } from '../../../domain/errors.js';
import type { RunOptions } from '../types.js';

const logger = pino({ name: 'FFmpegRunner' });

/**
 * Robust child-process wrapper for invoking the FFmpeg binary safely in Node.js.
 *
 * @remarks
 * - Parses FFmpeg's chaotic `stderr` payload to extract frame-accurate progression values.
 * - Maintains a rolling buffer of `stderr` (hard-capped at 50kb) to prevent V8 memory leaks during hours-long encodes.
 * - Maps raw exit codes and the tail of the stderr buffer into actionable `TranscodeError` domain exceptions.
 */
export function runFFmpeg(opts: RunOptions): Promise<void> {
   const { args, label, videoId, onProgress, duration } = opts;

   return new Promise((resolve, reject) => {
      const cmd = `ffmpeg ${args.join(' ')}`;
      logger.info({ videoId, label, cmd }, 'FFmpeg command started');

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderrBuffer = '';
      let lastLogPercent = -1;

      proc.stderr.on('data', (chunk: Buffer) => {
         const text = chunk.toString();
         stderrBuffer += text;

         if (stderrBuffer.length > 50000) {
            stderrBuffer = stderrBuffer.slice(-25000);
         }

         if (onProgress || duration) {
            const match = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
            if (match) {
               const [, h, m, s] = match.map(Number);
               const seconds = h * 3600 + m * 60 + s;

               let percent = seconds;

               if (duration && duration > 0) {
                  percent = Math.min(100, Math.round((seconds / duration) * 100));

                  if (percent % 5 === 0 && percent !== lastLogPercent) {
                     logger.info(
                        { videoId, label, progress: `${percent}%` },
                        'Processing video...',
                     );
                     lastLogPercent = percent;
                  }
               }

               if (onProgress) {
                  onProgress({ variant: label, percent });
               }
            }
         }

         for (const line of text.split('\n')) {
            const lower = line.toLowerCase();
            if (lower.includes('error') || lower.includes('crypto')) {
               logger.warn({ videoId, label, stderr: line.trim() }, 'FFmpeg stderr');
            }
         }
      });

      proc.on('close', (code) => {
         if (code === 0) {
            if (duration) logger.info({ videoId, label, progress: '100%' }, 'Processing complete!');
            resolve();
         } else {
            const lastLines = stderrBuffer.split('\n').slice(-5).join('\n');
            logger.error({ videoId, label, code, stderr: lastLines }, 'FFmpeg process failed');
            reject(new TranscodeError(`FFmpeg ${label} exited with code ${code}: ${lastLines}`));
         }
      });

      proc.on('error', (err) => {
         logger.error({ err, videoId, label }, 'FFmpeg spawn error');
         reject(new TranscodeError(`Failed to spawn FFmpeg for ${label}: ${err.message}`, err));
      });
   });
}

interface FfprobeStream {
   codec_type: string;
   codec_name?: string;
   width?: number;
   height?: number;
   r_frame_rate?: string;
   channels?: number;
}

interface FfprobeFormat {
   duration?: number;
   size?: number;
}

interface FfprobeOutput {
   streams: FfprobeStream[];
   format: FfprobeFormat;
}

export function runFFprobe(sourceUrl: string): Promise<FfprobeOutput> {
   const args = [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      sourceUrl,
   ];

   return new Promise((resolve, reject) => {
      logger.info({ sourceUrl }, 'Probing source');

      const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
         stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
         stderr += chunk.toString();
      });

      proc.on('close', (code) => {
         if (code !== 0) {
            if (stderr.includes('404') || stderr.includes('Server returned')) {
               return reject(new SourceNotFoundError(sourceUrl));
            }
            return reject(
               new ValidationError(`ffprobe failed (code ${code}): ${stderr.slice(-200)}`),
            );
         }

         try {
            const result = JSON.parse(stdout) as FfprobeOutput;
            resolve(result);
         } catch {
            reject(new ValidationError(`Failed to parse ffprobe output: ${stdout.slice(0, 200)}`));
         }
      });

      proc.on('error', (err) => {
         reject(new ValidationError(`Failed to spawn ffprobe: ${err.message}`));
      });
   });
}
