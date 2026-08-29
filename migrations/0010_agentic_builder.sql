CREATE TABLE IF NOT EXISTS agent_projects (
  project_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  intent_json TEXT,
  architecture_json TEXT,
  task_plan_json TEXT,
  model_strategy_json TEXT,
  validation_json TEXT,
  build_commit_sha TEXT,
  workflow_run_id TEXT,
  d1_database_id TEXT,
  d1_database_name TEXT,
  live_url TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_projects_phase ON agent_projects(phase, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_build_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  status TEXT NOT NULL,
  workflow_run_id TEXT,
  commit_sha TEXT,
  validation_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_build_runs_project ON agent_build_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_build_runs_status ON agent_build_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_llm_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  build_id TEXT,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  response_chars INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_llm_calls_project ON agent_llm_calls(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_llm_calls_build ON agent_llm_calls(build_id, created_at DESC);
