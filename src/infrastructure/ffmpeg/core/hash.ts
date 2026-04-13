import { v7 as uuidv7 } from 'uuid';

/**
 * Invokes uuidv7 generator mapped to POSIX timestamps.
 * Guarantees monotonic time-sorting across distributed blobs preventing hot-partitions
 * on internal S3 and SSD indexing mechanisms.
 */
export function generateTierUuid(): string {
   return uuidv7();
}

/**
 * Implements a balanced shard-tree prefix `[0-9a-f]{2}/...` for object key spaces.
 * Forces horizontal scaling against object storage namespace limitations (e.g. AWS 3500 PUTs/sec limit per prefix).
 */
export function blobPathFromUuid(id: string): string {
   const cleanId = id.toLowerCase().replace(/-/g, '');

   const p1 = cleanId.slice(0, 2);
   const p2 = cleanId.slice(2, 4);
   const p3 = cleanId.slice(4, 6);

   return `${p1}/${p2}/${p3}/${id}`;
}
