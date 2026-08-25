CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  github_repository TEXT,
  worker_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, provider)
);

CREATE TABLE IF NOT EXISTS project_features (
  project_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, feature)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  quantity REAL NOT NULL,
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_owner_updated
ON projects(owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_project_occurred
ON usage_events(project_id, occurred_at DESC);
