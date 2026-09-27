CREATE TABLE IF NOT EXISTS account_visits (
  user_id TEXT PRIMARY KEY,
  first_source TEXT NOT NULL DEFAULT 'jinggan',
  first_used_at INTEGER NOT NULL
);
