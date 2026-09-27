export const VIDEO_PROJECTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS video_projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    duration_seconds REAL NOT NULL DEFAULT 0,
    aspect_ratio TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'analysis',
    analysis_json TEXT NOT NULL,
    brief_json TEXT NOT NULL,
    proposals_json TEXT,
    selections_json TEXT NOT NULL DEFAULT '{}',
    reference_assets_json TEXT NOT NULL DEFAULT '[]',
    creative_pack_json TEXT,
    model_version TEXT NOT NULL DEFAULT '',
    usage_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_video_projects_owner_updated
    ON video_projects(owner_id, updated_at DESC)`,
] as const;
