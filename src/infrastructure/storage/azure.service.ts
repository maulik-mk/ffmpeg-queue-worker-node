import path from 'node:path';
import fs from 'node:fs/promises';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { pino } from 'pino';
import { config } from '../../config/env.js';
import type { ProgressCallback } from '../../domain/job.interface.js';

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

      for (const filePath of files) {
         const relativeToHlsDir = path.relative(folderPath, filePath).replace(/\\/g, '/');
         let blobPath = '';

         if (relativeToHlsDir === 'playlist.m3u8') {
            blobPath = `${this.envDirectory}/${videoId}/playlist.m3u8`;
         } else if (relativeToHlsDir.startsWith('v1/')) {
            blobPath = `${this.envDirectory}/${relativeToHlsDir}`;
         } else {
            blobPath = `${this.envDirectory}/${videoId}/${relativeToHlsDir}`;
         }

         const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
         let contentType = 'application/octet-stream';

         if (filePath.endsWith('.m3u8')) {
            contentType = 'application/vnd.apple.mpegurl';
         } else if (filePath.endsWith('.m4s') || filePath.endsWith('.mp4')) {
            contentType = 'video/mp4';
         }

         const fileBuffer = await fs.readFile(filePath);
         await blockBlobClient.uploadData(fileBuffer, {
            blobHTTPHeaders: {
               blobContentType: contentType,
            },
         });

         if (relativeToHlsDir === 'playlist.m3u8') {
            masterPlaylistUrl = blockBlobClient.url;
         }

         uploadedCount++;
         if (onProgress) {
            onProgress({ variant: 'Azure Upload', percent: (uploadedCount / files.length) * 100 });
         }
      }

      logger.info({ videoId, uploadedFiles: uploadedCount }, 'Azure upload complete');
      return masterPlaylistUrl;
   }
}
