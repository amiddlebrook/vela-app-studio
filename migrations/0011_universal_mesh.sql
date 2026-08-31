CREATE TABLE IF NOT EXISTS mesh_workspaces (
  owner_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_links (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mesh_links_owner ON mesh_links(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS mesh_credentials (
  owner_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  secret_ciphertext TEXT,
  public_config_json TEXT,
  status TEXT NOT NULL DEFAULT 'configured',
  last_tested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, node_id)
);

CREATE TABLE IF NOT EXISTS mesh_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  summary_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mesh_runs_owner ON mesh_runs(owner_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mesh_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  node_id TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mesh_events_run ON mesh_events(run_id, created_at ASC);
