import { pino } from 'pino';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TranscodeError } from '../../../domain/errors.js';

const logger = pino({ name: 'PerTitleVMAF' });

export interface ComplexityResult {
   multiplier: number;
   sampleBitrate: number;
}

async function runCommand(args: string[]): Promise<string> {
   return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args);
      let output = '';

      proc.stderr.on('data', (data) => {
         output += data.toString();
      });

      proc.on('close', (code) => {
         if (code !== 0) reject(new Error(`FFmpeg failed with code ${code}:\n${output}`));
         else resolve(output);
      });
   });
}

/**
 * Orchestrates a mathematically-driven Smart Per-Title Bitrate adaptation using Netflix's VMAF model.
 *
 * @remarks
 * - Phase 1: Generates a near-lossless reference encode (CRF 10, ultrafast) to establish a pristine baseline.
 * - Phase 2: Encodes empirical test points (CRF 19, 23, 27) and scores them against the reference using the VMAF neural network.
 * - Phase 3: Interpolates a Rate-Distortion curve to find the exact bits-per-second required to hit a perceptive VMAF score of 95.0.
 * - Bounding: Applies strict OTT resolution safety floors to prevent bitrate explosion on noisy/grainy source files.
 */
export async function probeComplexity(
   sourceUrl: string,
   duration: number,
   videoId: string,
   sourceWidth: number,
   sourceHeight: number,
): Promise<ComplexityResult> {
   const workDir = `/tmp/worker/${videoId}/vmaf`;
   await fs.mkdir(workDir, { recursive: true });

   const refPath = path.join(workDir, 'ref.mkv');

   logger.info({ videoId }, 'Phase 1: Generating 100% Whole-Timeline Reference (CFR Enforced)');

   try {
      await runCommand([
         '-i',
         sourceUrl,
         '-map',
         '0:v:0',
         '-an',
         '-sn',
         '-c:v',
         'libx264',
         '-crf',
         '10',
         '-preset',
         'ultrafast',
         '-fps_mode',
         'cfr',
         '-pix_fmt',
         'yuv420p',
         '-y',
         refPath,
      ]);

      logger.info({ videoId }, 'Phase 2: Encoding Full Grid & Running VMAF AI Analysis');

      const crfs = [19, 23, 27];
      const results: { crf: number; vmaf: number; kbps: number }[] = [];

      for (const crf of crfs) {
         const testPath = path.join(workDir, `test_${crf}.mkv`);

         await runCommand([
            '-i',
            refPath,
            '-c:v',
            'libx264',
            '-crf',
            String(crf),
            '-preset',
            'superfast',
            '-fps_mode',
            'cfr',
            '-y',
            testPath,
         ]);

         const stat = await fs.stat(testPath);
         const kbps = (stat.size * 8) / duration / 1000;

         const vmafOut = await runCommand([
            '-i',
            testPath,
            '-i',
            refPath,
            '-lavfi',
            '[0:v]setpts=PTS-STARTPTS,scale=1920:1080:flags=bicubic[dist];[1:v]setpts=PTS-STARTPTS,scale=1920:1080:flags=bicubic[ref];[dist][ref]libvmaf=model=path=/usr/local/share/model/vmaf_v0.6.1.json:n_subsample=24:n_threads=4:pool=harmonic_mean',
            '-f',
            'null',
            '-',
         ]);

         const match = vmafOut.match(/VMAF score: ([\d.]+)/);
         const vmaf = match ? parseFloat(match[1]) : 0;

         results.push({ crf, vmaf, kbps });
      }

      logger.info(
         { videoId, curve: results },
         'Phase 3: Full-Timeline Rate-Distortion Curve mathematically mapped',
      );

      const TARGET_VMAF = 95.0;
      results.sort((a, b) => a.vmaf - b.vmaf);

      let optimalKbps = 0;

      if (TARGET_VMAF <= results[0].vmaf) {
         optimalKbps = results[0].kbps;
      } else if (TARGET_VMAF >= results[results.length - 1].vmaf) {
         optimalKbps = results[results.length - 1].kbps;
      } else {
         for (let i = 0; i < results.length - 1; i++) {
            if (TARGET_VMAF >= results[i].vmaf && TARGET_VMAF <= results[i + 1].vmaf) {
               const p1 = results[i];
               const p2 = results[i + 1];
               const slope = (p2.kbps - p1.kbps) / (p2.vmaf - p1.vmaf);
               optimalKbps = p1.kbps + slope * (TARGET_VMAF - p1.vmaf);
               break;
            }
         }
      }

      const is4K = sourceWidth >= 3840 || sourceHeight >= 2160;
      const is1080p = (sourceWidth >= 1920 || sourceHeight >= 1080) && !is4K;

      const BASELINE_KBPS = is4K ? 20000 : is1080p ? 6000 : 3000;

      if (!optimalKbps || isNaN(optimalKbps) || optimalKbps <= 0) {
         logger.warn(
            { videoId },
            'VMAF calculation yielded invalid optimalKbps. Falling back to BASELINE.',
         );
         optimalKbps = BASELINE_KBPS;
      }

      let multiplier = optimalKbps / BASELINE_KBPS;

      const minFloor = is4K ? 0.85 : 0.6;
      const maxCeil = is4K ? 1.5 : 2.0;

      multiplier = Math.max(minFloor, Math.min(multiplier, maxCeil));

      logger.info(
         {
            videoId,
            optimalKbps: Math.round(optimalKbps),
            baselineKbps: BASELINE_KBPS,
            finalMultiplier: multiplier,
            is4K,
         },
         'Real Per-Title VMAF calculated with OTT Resolution Quality Floors applied',
      );

      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

      return { multiplier, sampleBitrate: Math.round(optimalKbps) };
   } catch (error) {
      logger.error(
         { videoId, err: error },
         'Real VMAF probe failed. Strict mode active: Failing the pipeline.',
      );

      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

      throw new TranscodeError(
         `VMAF Complexity Probe failed: ${error instanceof Error ? error.message : String(error)}`,
         error instanceof Error ? error : undefined,
      );
   }
}
