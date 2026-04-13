/**
 * Enforces standard RFC 8216 file mappings used uniformly across CDN deployments.
 */
export const HLS_CONSTANTS = {
   MASTER_PLAYLIST_NAME: 'playlist.m3u8',

   VARIANT_PLAYLIST_NAME: 'manifest.m3u8',
} as const;
