CREATE TABLE IF NOT EXISTS videos (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processing', 'transcoding', 'uploading', 'completed', 'failed')),
  playlist_url         TEXT,
  sprite_url           TEXT,
  poster_url           TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_metadata (
    video_id    TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    duration    NUMERIC(10, 6) NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    codec       TEXT NOT NULL,
    frame_rate  NUMERIC(6, 3) DEFAULT 0,
    bit_rate    BIGINT DEFAULT 0,
    size_bytes  BIGINT DEFAULT 0,
    video_range TEXT DEFAULT 'SDR',
    aspect_ratio TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_renditions (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id    TEXT REFERENCES videos(id) ON DELETE CASCADE,
    resolution  TEXT NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    bitrate     INTEGER,
    url         TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_videos_user_id ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_vmeta_video_id ON video_metadata(video_id);
CREATE INDEX IF NOT EXISTS idx_vrend_video_id ON video_renditions(video_id);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON videos;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON videos
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
