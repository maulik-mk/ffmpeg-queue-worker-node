export const HLS_CONSTANTS = {
   MASTER_PLAYLIST_NAME: 'playlist.m3u8',

   VIDEO_SEGMENT_NAME: 'data_%03d.m4s',
   SINGLE_VIDEO_NAME: 'data.m4s',

   INIT_SEGMENT_NAME: 'init.mp4',

   VARIANT_PLAYLIST_NAME: 'manifest.m3u8',

   AUDIO_TIERS: {
      SURROUND: 'a1',
      STEREO: 'a2',
   },
} as const;
