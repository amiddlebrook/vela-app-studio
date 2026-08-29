export { BuildCoordinator } from './index';

const agentic = import('./entry-agentic');

const AGENT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_projects (
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
  )`,
  `CREATE TABLE IF NOT EXISTS agent_build_runs (
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
  )`,
  `CREATE TABLE IF NOT EXISTS agent_llm_calls (
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
  )`,
  `CREATE TABLE IF NOT EXISTS project_full_prompts (
    project_id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

function guardedDatabase(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return async (sql: string) => {
          if (sql.includes('CREATE TABLE IF NOT EXISTS agent_projects')) {
            for (const statement of AGENT_SCHEMA_STATEMENTS) {
              await target.prepare(statement).run();
            }
            return { count: AGENT_SCHEMA_STATEMENTS.length, duration: 0 };
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}

function guardedEnv(env: unknown): unknown {
  const runtime = env as { DB?: D1Database } & Record<PropertyKey, unknown>;
  if (!runtime?.DB) return env;
  const db = guardedDatabase(runtime.DB);
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === 'DB') return db;
      return Reflect.get(target, property, receiver);
    },
  });
}

function diagnostic(error: unknown): Response {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(JSON.stringify({ event: 'agentic_runtime_uncaught', reason }));
  return Response.json({
    ok: false,
    error: 'Procedural agent runtime failed',
    reason,
    mode: 'procedural-agentic',
  }, { status: 500, headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        mode: 'procedural-agentic',
        execution_plane: 'github-actions',
        llm_provider: 'openrouter',
        model_policy: 'explicit-:free-only',
        confirmation_gates: [
          'intent',
          'architecture',
          'engineering_plan',
          'deployment',
          'final_user_acceptance',
        ],
        timestamp: new Date().toISOString(),
      }, { headers: { 'cache-control': 'no-store' } });
    }
    try {
      const module = await agentic;
      return await module.default.fetch(request, guardedEnv(env) as never, ctx);
    } catch (error) {
      return diagnostic(error);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    const module = await agentic;
    return module.default.queue(batch as never, guardedEnv(env) as never);
  },
};
