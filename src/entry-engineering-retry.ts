import { BuildCoordinator } from './index';
import { AGENT_RUNNER, AGENT_VALIDATOR, AGENT_VALIDATOR_JS, AGENT_WORKFLOW } from './agent-template';

export { BuildCoordinator };

const entry = import('./entry-agent-resilience');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = 'vela_session';
const FREE_FALLBACKS = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'inclusionai/ring-2.6-1t:free'];

type RuntimeEnv = {
  DB: D1Database;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string | CryptoKey;
  APP_ORIGIN?: string;
} & Record<string, unknown>;

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  prompt: string;
  github_repository: string | null;
  status: string;
};

type AgentRow = {
  phase: string;
  intent_json: string | null;
  architecture_json: string | null;
  task_plan_json: string | null;
  model_strategy_json: string | null;
};

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function sessionHmac(value: string, rawSecret: string): Promise<string> {
  const normalized = base64Url(await sha256(rawSecret));
  const key = await crypto.subtle.importKey('raw', toBuffer(base64UrlBytes(normalized)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function readSession(request: Request, secret: string): Promise<string | null> {
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!value) return null;
  const [id, signature] = value.split('.');
  if (!id || !signature) return null;
  return (await sessionHmac(id, secret)) === signature ? id : null;
}

async function encryptionKey(value: string | CryptoKey): Promise<CryptoKey> {
  if (typeof value !== 'string') return value;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function decryptStored(value: string, keyValue: string | CryptoKey): Promise<string> {
  const [iv, ciphertext] = value.split('.');
  if (!iv || !ciphertext) throw new Error('Invalid encrypted value');
  const key = await encryptionKey(keyValue);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(base64UrlBytes(iv)) }, key, toBuffer(base64UrlBytes(ciphertext)));
  return decoder.decode(plaintext);
}

async function scopedHmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function makeBuildToken(projectId: string, buildId: string, secret: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify({ project_id: projectId, build_id: buildId, exp: Date.now() + 6 * 60 * 60 * 1000 })));
  return `${payload}.${await scopedHmac(payload, secret)}`;
}

async function githubToken(env: RuntimeEnv, ownerId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT access_token_ciphertext FROM connections WHERE owner_id=? AND provider='github' AND status='connected'`)
    .bind(ownerId).first<{ access_token_ciphertext?: string | null }>();
  if (!row?.access_token_ciphertext) throw new Error('GitHub is not connected');
  return JSON.parse(await decryptStored(row.access_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string;
}

async function githubRequest(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'Vela-Procedural-Agent', 'x-github-api-version': '2022-11-28', ...init.headers },
  });
  return { status: response.status, text: await response.text() };
}

async function putGithubFile(token: string, repository: string, path: string, content: string, message: string): Promise<void> {
  const apiPath = `/repos/${repository}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}`;
  const existing = await githubRequest(token, apiPath);
  let sha: string | undefined;
  if (existing.status === 200) {
    try { sha = (JSON.parse(existing.text) as { sha?: string }).sha; } catch {}
  } else if (existing.status !== 404) {
    throw new Error(`GitHub read ${path} failed (${existing.status}): ${existing.text.slice(0, 800)}`);
  }
  const body: Record<string, unknown> = { message, content: base64(encoder.encode(content)), branch: 'main' };
  if (sha) body.sha = sha;
  const written = await githubRequest(token, apiPath, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (written.status < 200 || written.status >= 300) throw new Error(`GitHub write ${path} failed (${written.status}): ${written.text.slice(0, 1000)}`);
}

async function githubText(token: string, repository: string, path: string): Promise<string | null> {
  const result = await githubRequest(token, `/repos/${repository}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}?ref=main`);
  if (result.status === 404) return null;
  if (result.status !== 200) throw new Error(`GitHub read ${path} failed (${result.status}): ${result.text.slice(0, 800)}`);
  const payload = JSON.parse(result.text) as { content?: string };
  if (!payload.content) return null;
  return decoder.decode(Uint8Array.from(atob(payload.content.replace(/\s/g, '')), c => c.charCodeAt(0)));
}

function allowedValidationCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/^wrangler\s+db\s+(migrate|seed)\b/i.test(cmd)) return false;
  if (/^github\s+actions\b/i.test(cmd)) return false;
  if (/^npm\s+run\s+start\b/i.test(cmd)) return false;
  if (/^wrangler\s+deploy\s*$/i.test(cmd)) return false;
  return /^(npm|npx|node|python3?|pytest|bash|sh|test|sqlite3|git)\b/.test(cmd);
}

function sanitizePlan(plan: unknown): unknown {
  if (!plan || typeof plan !== 'object') return plan;
  const copy = structuredClone(plan) as { tasks?: Array<Record<string, unknown>>; milestones?: Array<Record<string, unknown>> };
  for (const group of [copy.tasks, copy.milestones]) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const commands = Array.isArray(item.validation_commands) ? item.validation_commands.map(String) : [];
      item.validation_commands = commands.filter(allowedValidationCommand);
    }
  }
  return copy;
}

function strengthenModels(models: unknown): Record<string, unknown> {
  const copy = models && typeof models === 'object' ? structuredClone(models) as Record<string, unknown> : {};
  const primary = typeof copy.coder === 'string' && copy.coder.endsWith(':free') ? copy.coder : 'z-ai/glm-5.2:free';
  copy.provider = 'openrouter';
  copy.architect = typeof copy.architect === 'string' ? copy.architect : primary;
  copy.coder = primary;
  copy.debugger = typeof copy.debugger === 'string' ? copy.debugger : primary;
  copy.reviewer = typeof copy.reviewer === 'string' ? copy.reviewer : primary;
  copy.research = typeof copy.research === 'string' ? copy.research : primary;
  copy.fallbacks = FREE_FALLBACKS;
  copy.policy = 'Only explicit OpenRouter :free models may execute engineering work. Vela rotates through approved explicit free fallbacks on upstream rate limits/outages; no Cloudflare Workers AI or generic scaffold coding fallback.';
  return copy;
}

async function retryEngineering(request: Request, env: RuntimeEnv, projectId: string): Promise<Response | null> {
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return json({ error: 'Start a workspace first.' }, { status: 401 });

  const project = await env.DB.prepare('SELECT id,owner_id,name,prompt,github_repository,status FROM projects WHERE id=? AND owner_id=?')
    .bind(projectId, ownerId).first<ProjectRow>();
  if (!project) return json({ error: 'Project not found' }, { status: 404 });
  const agent = await env.DB.prepare('SELECT phase,intent_json,architecture_json,task_plan_json,model_strategy_json FROM agent_projects WHERE project_id=?')
    .bind(projectId).first<AgentRow>();

  if (!agent || agent.phase !== 'failed' || !agent.intent_json || !agent.architecture_json || !agent.task_plan_json || !project.github_repository) return null;

  const token = await githubToken(env, ownerId);
  const repository = project.github_repository;
  const buildId = crypto.randomUUID();
  const buildToken = await makeBuildToken(project.id, buildId, env.SESSION_SECRET);
  const now = new Date().toISOString();

  const promptRow = await env.DB.prepare('SELECT prompt FROM project_full_prompts WHERE project_id=?').bind(project.id).first<{ prompt?: string }>();
  const requirements = promptRow?.prompt?.trim() || project.prompt;

  let plan: unknown;
  const currentPlan = await githubText(token, repository, '.vela/task-plan.json');
  try { plan = currentPlan ? JSON.parse(currentPlan) : JSON.parse(agent.task_plan_json); }
  catch { plan = JSON.parse(agent.task_plan_json); }
  plan = sanitizePlan(plan);

  let models: unknown;
  const currentModels = await githubText(token, repository, '.vela/models.json');
  try { models = currentModels ? JSON.parse(currentModels) : JSON.parse(agent.model_strategy_json || '{}'); }
  catch { models = {}; }
  models = strengthenModels(models);

  await putGithubFile(token, repository, '.vela/requirements.md', requirements, 'vela: refresh authoritative requirements for engineering retry');
  await putGithubFile(token, repository, '.vela/intent.json', JSON.stringify(JSON.parse(agent.intent_json), null, 2), 'vela: preserve confirmed intent for engineering retry');
  await putGithubFile(token, repository, '.vela/architecture.json', JSON.stringify(JSON.parse(agent.architecture_json), null, 2), 'vela: preserve confirmed architecture for engineering retry');
  await putGithubFile(token, repository, '.vela/task-plan.json', JSON.stringify(plan, null, 2), 'vela: sanitize approved task plan for engineering retry');
  await putGithubFile(token, repository, '.vela/models.json', JSON.stringify(models, null, 2), 'vela: configure explicit free-model failover');
  await putGithubFile(token, repository, '.vela/agent-runner.mjs', AGENT_RUNNER, 'vela: refresh procedural engineering runner');
  await putGithubFile(token, repository, '.vela/ab-project-validate', AGENT_VALIDATOR, 'vela: refresh project validator command');
  await putGithubFile(token, repository, '.vela/validator.mjs', AGENT_VALIDATOR_JS, 'vela: refresh substantive project validator');
  await putGithubFile(token, repository, '.github/workflows/vela-agent-build.yml', AGENT_WORKFLOW, 'vela: refresh procedural agent workflow');

  await env.DB.prepare('INSERT INTO agent_build_runs(id,project_id,repository,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .bind(buildId, project.id, repository, 'dispatching', now, now).run();

  let dispatched = false;
  let last = '';
  for (let attempt = 1; attempt <= 6 && !dispatched; attempt++) {
    const result = await githubRequest(token, `/repos/${repository}/actions/workflows/vela-agent-build.yml/dispatches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'main', inputs: { project_id: project.id, build_id: buildId, build_token: buildToken, control_plane: String(env.APP_ORIGIN || 'https://vela-control-plane.averymiddlebrook2014.workers.dev') } }),
    });
    if (result.status === 204) dispatched = true;
    else {
      last = `GitHub workflow dispatch ${result.status}: ${result.text.slice(0, 900)}`;
      await new Promise(resolve => setTimeout(resolve, attempt * 1200));
    }
  }
  if (!dispatched) {
    await env.DB.prepare('UPDATE agent_build_runs SET status=?,error=?,updated_at=? WHERE id=?').bind('failed', last || 'dispatch failed', new Date().toISOString(), buildId).run();
    throw new Error(last || 'Could not dispatch procedural engineering workflow');
  }

  await env.DB.prepare('UPDATE agent_build_runs SET status=?,updated_at=? WHERE id=?').bind('running', new Date().toISOString(), buildId).run();
  await env.DB.prepare('UPDATE agent_projects SET phase=?,workflow_run_id=?,model_strategy_json=?,last_error=NULL,updated_at=? WHERE project_id=?')
    .bind('agent_running', buildId, JSON.stringify(models), new Date().toISOString(), project.id).run();
  await env.DB.prepare('UPDATE projects SET status=?,updated_at=? WHERE id=?').bind('agent_running', new Date().toISOString(), project.id).run();
  try {
    await env.DB.prepare('INSERT INTO build_events(id,project_id,kind,detail,stage,created_at) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), project.id, 'engineering_retry_dispatched', `Retrying procedural engineering from latest main with sanitized validation commands and explicit free-model failover. Build ${buildId}.`, 'agent_running', new Date().toISOString()).run();
  } catch {}

  return json({ status: 'agent_running', build_id: buildId, repository }, { status: 202 });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const match = request.method === 'POST' ? url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/build$/) : null;
    if (match) {
      try {
        const retried = await retryEngineering(request, env, match[1]);
        if (retried) return retried;
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    }
    const module = await entry;
    return module.default.fetch(request, env as never, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
