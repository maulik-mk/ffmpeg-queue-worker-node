import path from 'node:path';
import fs from 'node:fs/promises';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { pino } from 'pino';
import { config } from '../../config/env.js';
import type { ProgressCallback } from '../../domain/job.interface.js';
import { HLS_CONSTANTS } from '../ffmpeg/constants.js';

const logger = pino({ name: 'AzureStorage' });

/**
 * Azure Blob Storage adapter for uploading generated HLS playlists and segments.
 *
 * @remarks
 * - Recursively scans the local output directory and mirrors the final structure to the Blob container.
 * - Automatically infers and injects correct `Content-Type` headers (`application/vnd.apple.mpegurl` or `video/mp4`).
 * - Security note: Uses `DefaultAzureCredential` in production (Managed Identity), falling back to connection strings locally.
 */
export class AzureStorageService {
   private readonly blobServiceClient: BlobServiceClient;
   private readonly containerName = config.AZURE_STORAGE_CONTAINER_NAME;
   private readonly envDirectory = config.CONTAINER_DIRECTORY_1;

   constructor() {
      if (config.NODE_ENV === 'production') {
         if (!config.AZURE_STORAGE_ACCOUNT_URL) {
            throw new Error(
               'AZURE_STORAGE_ACCOUNT_URL is required in production for Managed Identity',
            );
         }
         this.blobServiceClient = new BlobServiceClient(
            config.AZURE_STORAGE_ACCOUNT_URL,
            new DefaultAzureCredential(),
         );
         logger.info('Azure Storage authenticated via Managed Identity');
      } else {
         if (!config.AZURE_STORAGE_CONNECTION_STRING) {
            throw new Error('AZURE_STORAGE_CONNECTION_STRING is required in development');
         }
         this.blobServiceClient = BlobServiceClient.fromConnectionString(
            config.AZURE_STORAGE_CONNECTION_STRING,
         );
         logger.info('Azure Storage authenticated via Connection String');
      }
   }

   private async getFilesRecursive(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
         entries.map((entry) => {
            const res = path.resolve(dir, entry.name);
            return entry.isDirectory() ? this.getFilesRecursive(res) : res;
         }),
      );
      return Array.prototype.concat(...files) as string[];
   }

   async uploadHLS(
      folderPath: string,
      videoId: string,
      onProgress?: ProgressCallback,
   ): Promise<string> {
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      await containerClient.createIfNotExists({ access: 'blob' });

      const files = await this.getFilesRecursive(folderPath);
      let uploadedCount = 0;
      let masterPlaylistUrl = '';

      let currentIndex = 0;
      const totalFiles = files.length;

      const uploadWorker = async () => {
         while (currentIndex < totalFiles) {
            const fileIndex = currentIndex++;
            const filePath = files[fileIndex];

            const relativeToHlsDir = path.relative(folderPath, filePath).replace(/\\/g, '/');
            let blobPath = '';

            if (relativeToHlsDir === HLS_CONSTANTS.MASTER_PLAYLIST_NAME) {
               blobPath = `${this.envDirectory}/${videoId}/${HLS_CONSTANTS.MASTER_PLAYLIST_NAME}`;
            } else if (relativeToHlsDir.startsWith('v1/')) {
               blobPath = `${this.envDirectory}/${relativeToHlsDir}`;
            } else {
               blobPath = `${this.envDirectory}/${videoId}/${relativeToHlsDir}`;
            }

            const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
            let contentType = 'application/octet-stream';

            if (filePath.endsWith('.m3u8')) {
               contentType = 'application/vnd.apple.mpegurl';
            } else if (filePath.endsWith('.m4s')) {
               contentType = 'application/octet-stream';
            } else if (filePath.endsWith('.mp4')) {
               contentType = 'video/mp4';
            }

            let attempts = 0;
            const maxRetries = config.AZURE_UPLOAD_RETRIES;
            let success = false;

            while (attempts < maxRetries && !success) {
               try {
                  attempts++;
                  await blockBlobClient.uploadFile(filePath, {
                     blobHTTPHeaders: {
                        blobContentType: contentType,
                     },
                  });
                  success = true;
               } catch (error) {
                  if (attempts >= maxRetries) {
                     logger.error(
                        { videoId, filePath, attempts },
                        'Failed to upload Blob file after max retries',
                     );
                     throw error;
                  }
                  await new Promise((res) => setTimeout(res, 1000 * attempts));
               }
            }

            if (relativeToHlsDir === HLS_CONSTANTS.MASTER_PLAYLIST_NAME) {
               masterPlaylistUrl = blockBlobClient.url;
            }

            uploadedCount++;
            if (onProgress) {
               const percent = Math.round((uploadedCount / totalFiles) * 100);
               const prevPercent = Math.round(((uploadedCount - 1) / totalFiles) * 100);
               if (percent > prevPercent) {
                  onProgress({ variant: 'Azure Upload', percent });
               }
            }
         }
      };

      const concurrency = Math.min(config.AZURE_UPLOAD_BATCH_SIZE, totalFiles);
      const workers = Array.from({ length: concurrency }).map(() => uploadWorker());

      await Promise.all(workers);

      logger.info({ videoId, uploadedFiles: uploadedCount }, 'Azure upload complete');
      return masterPlaylistUrl;
   }
}
