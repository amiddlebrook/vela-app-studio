CREATE TABLE IF NOT EXISTS build_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_build_events_project_created
ON build_events(project_id, created_at DESC);
