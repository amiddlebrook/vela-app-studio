export { BuildCoordinator } from './index';

const runtime = import('./entry-runtime');

type RuntimeEnv = {
  DB?: D1Database;
};

type AgentRow = {
  project_id: string;
  phase: string;
  intent_json: string | null;
  architecture_json: string | null;
  task_plan_json: string | null;
  model_strategy_json: string | null;
  validation_json: string | null;
  build_commit_sha: string | null;
  live_url: string | null;
  last_error: string | null;
};

function parsed(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function agentPayload(row: AgentRow | undefined, fallbackPhase?: unknown): Record<string, unknown> | null {
  if (!row && typeof fallbackPhase !== 'string') return null;
  return {
    phase: row?.phase || fallbackPhase,
    intent: parsed(row?.intent_json || null),
    architecture: parsed(row?.architecture_json || null),
    task_plan: parsed(row?.task_plan_json || null),
    models: parsed(row?.model_strategy_json || null),
    validation: parsed(row?.validation_json || null),
    commit_sha: row?.build_commit_sha || null,
    live_url: row?.live_url || null,
    last_error: row?.last_error || null,
  };
}

async function forceAgentStateIntoProjects(response: Response, env: RuntimeEnv): Promise<Response> {
  if (!response.ok || !env.DB) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return response;

  let body: { projects?: Array<Record<string, unknown> & { id?: string; status?: string; agent?: unknown }> };
  try {
    body = await response.clone().json() as typeof body;
  } catch {
    return response;
  }

  const projects = body.projects || [];
  const ids = projects.map(project => project.id).filter((id): id is string => Boolean(id));
  if (!ids.length) return response;

  let byId = new Map<string, AgentRow>();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT project_id,phase,intent_json,architecture_json,task_plan_json,model_strategy_json,validation_json,build_commit_sha,live_url,last_error FROM agent_projects WHERE project_id IN (${placeholders})`)
      .bind(...ids).all<AgentRow>();
    byId = new Map((rows.results || []).map(row => [row.project_id, row]));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'confirmation_gate_agent_lookup_failed', reason: error instanceof Error ? error.message : String(error) }));
  }

  const gatePhases = new Set([
    'awaiting_intent_confirmation',
    'awaiting_architecture_confirmation',
    'awaiting_build_plan_confirmation',
    'bootstrapping_agent',
    'agent_running',
    'awaiting_deploy_approval',
    'awaiting_user_acceptance',
  ]);

  body.projects = projects.map(project => {
    const id = project.id || '';
    const row = byId.get(id);
    if (row) return { ...project, agent: agentPayload(row, project.status) };
    if (!project.agent && typeof project.status === 'string' && gatePhases.has(project.status)) {
      return { ...project, agent: agentPayload(undefined, project.status) };
    }
    return project;
  });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const module = await runtime;
    let response = await module.default.fetch(request, env as never, ctx);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/projects') {
      response = await forceAgentStateIntoProjects(response, env);
    }
    return response;
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await runtime;
    return module.default.queue(batch as never, env as never);
  },
};
