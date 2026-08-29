import { BuildCoordinator } from './index';
import { AGENT_VALIDATOR, AGENT_VALIDATOR_JS, AGENT_WORKFLOW } from './agent-template';
import { AGENT_RUNNER_V3 } from './agent-runner-v3';

export { BuildCoordinator };

const entry = import('./entry-self-heal');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FREE_FALLBACKS = ['nvidia/nemotron-3-ultra-550b-a55b:free', 'inclusionai/ring-2.6-1t:free'];

type RuntimeEnv = {
  DB?: D1Database;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string | CryptoKey;
  APP_ORIGIN?: string;
};

type WatchRow = {
  id: string;
  owner_id: string;
  prompt: string;
  github_repository: string;
  updated_at: string;
  intent_json: string | null;
  architecture_json: string | null;
  task_plan_json: string | null;
  model_strategy_json: string | null;
};

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
  if (!env.DB || !env.TOKEN_ENCRYPTION_KEY) throw new Error('GitHub credential storage is unavailable');
  const row = await env.DB.prepare(`SELECT access_token_ciphertext FROM connections WHERE owner_id=? AND provider='github' AND status='connected'`)
    .bind(ownerId).first<{ access_token_ciphertext?: string | null }>();
  if (!row?.access_token_ciphertext) throw new Error('GitHub is not connected');
  return JSON.parse(await decryptStored(row.access_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string;
}

async function githubRequest(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'Vela-Procedural-Watchdog',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  return { status: response.status, text: await response.text() };
}

async function latestWorkflowState(repository: string, token: string): Promise<'active' | 'completed' | 'missing' | 'unknown'> {
  try {
    const result = await githubRequest(token, `/repos/${repository}/actions/workflows/vela-agent-build.yml/runs?per_page=1`);
    if (result.status === 404) return 'missing';
    if (result.status < 200 || result.status >= 300) return 'unknown';
    const body = JSON.parse(result.text) as { workflow_runs?: Array<{ status?: string }> };
    const status = body.workflow_runs?.[0]?.status;
    if (!status) return 'missing';
    return ['queued','in_progress','waiting','requested','pending'].includes(status) ? 'active' : 'completed';
  } catch {
    return 'unknown';
  }
}

async function putGithubFile(token: string, repository: string, path: string, content: string, message: string): Promise<void> {
  const apiPath = `/repos/${repository}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}`;
  const existing = await githubRequest(token, apiPath);
  let sha: string | undefined;
  if (existing.status === 200) {
    try { sha = (JSON.parse(existing.text) as { sha?: string }).sha; } catch {}
  } else if (existing.status !== 404) throw new Error(`GitHub read ${path} failed (${existing.status})`);
  const body: Record<string, unknown> = { message, content: base64(encoder.encode(content)), branch: 'main' };
  if (sha) body.sha = sha;
  const written = await githubRequest(token, apiPath, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (written.status < 200 || written.status >= 300) throw new Error(`GitHub write ${path} failed (${written.status}): ${written.text.slice(0, 700)}`);
}

async function githubText(token: string, repository: string, path: string): Promise<string | null> {
  const result = await githubRequest(token, `/repos/${repository}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}?ref=main`);
  if (result.status === 404) return null;
  if (result.status !== 200) throw new Error(`GitHub read ${path} failed (${result.status})`);
  const payload = JSON.parse(result.text) as { content?: string };
  if (!payload.content) return null;
  return decoder.decode(Uint8Array.from(atob(payload.content.replace(/\s/g, '')), c => c.charCodeAt(0)));
}

function allowedValidationCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/^wrangler\s+db\s+(migrate|seed)\b/i.test(cmd)) return false;
  if (/^github\s+actions\b/i.test(cmd)) return false;
  if (/^npm\s+run\s+(start|dev|serve)\b/i.test(cmd)) return false;
  if (/^wrangler\s+deploy\b/i.test(cmd)) return /--dry-run\b/i.test(cmd);
  if (/^npx\b.*\bwrangler\b.*\bdeploy\b/i.test(cmd) && !/--dry-run\b/i.test(cmd)) return false;
  if (/^git\s+(add|commit|push|pull|checkout|switch|reset|clean|rm|merge|rebase|tag)\b/i.test(cmd)) return false;
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
  copy.architect = typeof copy.architect === 'string' && copy.architect.endsWith(':free') ? copy.architect : primary;
  copy.coder = primary;
  copy.debugger = typeof copy.debugger === 'string' && copy.debugger.endsWith(':free') ? copy.debugger : primary;
  copy.reviewer = typeof copy.reviewer === 'string' && copy.reviewer.endsWith(':free') ? copy.reviewer : primary;
  copy.research = typeof copy.research === 'string' && copy.research.endsWith(':free') ? copy.research : primary;
  copy.fallbacks = FREE_FALLBACKS;
  copy.policy = 'Only explicit OpenRouter :free models may execute engineering work. Rotate through approved explicit free fallbacks on rate limits/outages.';
  return copy;
}

function olderThan(value: string, ms: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && Date.now() - time > ms;
}

async function recordEvent(env: RuntimeEnv, projectId: string, kind: string, detail: string, stage: string): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO build_events(id,project_id,kind,detail,stage,created_at) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), projectId, kind, detail.slice(0, 4000), stage, new Date().toISOString()).run();
  } catch {}
}

async function dispatchFreshBuild(env: RuntimeEnv, row: WatchRow, token: string): Promise<void> {
  if (!env.DB || !env.SESSION_SECRET) throw new Error('Control-plane build credentials unavailable');
  const buildId = crypto.randomUUID();
  const buildToken = await makeBuildToken(row.id, buildId, env.SESSION_SECRET);
  const now = new Date().toISOString();

  const promptRow = await env.DB.prepare('SELECT prompt FROM project_full_prompts WHERE project_id=?').bind(row.id).first<{ prompt?: string }>();
  const requirements = promptRow?.prompt?.trim() || row.prompt;

  let plan: unknown;
  const currentPlan = await githubText(token, row.github_repository, '.vela/task-plan.json');
  try { plan = currentPlan ? JSON.parse(currentPlan) : JSON.parse(row.task_plan_json || '{}'); }
  catch { plan = JSON.parse(row.task_plan_json || '{}'); }
  plan = sanitizePlan(plan);

  let models: unknown;
  const currentModels = await githubText(token, row.github_repository, '.vela/models.json');
  try { models = currentModels ? JSON.parse(currentModels) : JSON.parse(row.model_strategy_json || '{}'); }
  catch { models = {}; }
  models = strengthenModels(models);

  await putGithubFile(token, row.github_repository, '.vela/requirements.md', requirements, 'vela: watchdog refresh authoritative requirements');
  if (row.intent_json) await putGithubFile(token, row.github_repository, '.vela/intent.json', JSON.stringify(JSON.parse(row.intent_json), null, 2), 'vela: watchdog preserve confirmed intent');
  if (row.architecture_json) await putGithubFile(token, row.github_repository, '.vela/architecture.json', JSON.stringify(JSON.parse(row.architecture_json), null, 2), 'vela: watchdog preserve confirmed architecture');
  await putGithubFile(token, row.github_repository, '.vela/task-plan.json', JSON.stringify(plan, null, 2), 'vela: watchdog refresh approved engineering plan');
  await putGithubFile(token, row.github_repository, '.vela/models.json', JSON.stringify(models, null, 2), 'vela: watchdog refresh free model failover');
  await putGithubFile(token, row.github_repository, '.vela/agent-runner.mjs', AGENT_RUNNER_V3, 'vela: watchdog install procedural runner v3');
  await putGithubFile(token, row.github_repository, '.vela/ab-project-validate', AGENT_VALIDATOR, 'vela: watchdog refresh project validator command');
  await putGithubFile(token, row.github_repository, '.vela/validator.mjs', AGENT_VALIDATOR_JS, 'vela: watchdog refresh substantive validator');
  await putGithubFile(token, row.github_repository, '.github/workflows/vela-agent-build.yml', AGENT_WORKFLOW, 'vela: watchdog refresh procedural workflow');

  await env.DB.prepare('INSERT INTO agent_build_runs(id,project_id,repository,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .bind(buildId, row.id, row.github_repository, 'dispatching', now, now).run();

  let dispatched = false;
  let last = '';
  for (let attempt = 1; attempt <= 5 && !dispatched; attempt++) {
    const result = await githubRequest(token, `/repos/${row.github_repository}/actions/workflows/vela-agent-build.yml/dispatches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { project_id: row.id, build_id: buildId, build_token: buildToken, control_plane: String(env.APP_ORIGIN || 'https://vela-control-plane.averymiddlebrook2014.workers.dev') } }),
    });
    if (result.status === 204) dispatched = true;
    else {
      last = `GitHub workflow dispatch ${result.status}: ${result.text.slice(0, 700)}`;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  if (!dispatched) throw new Error(last || 'Could not dispatch procedural workflow');

  await env.DB.prepare('UPDATE agent_build_runs SET status=?,updated_at=? WHERE id=?').bind('running', new Date().toISOString(), buildId).run();
  await env.DB.prepare('UPDATE agent_projects SET phase=?,workflow_run_id=?,model_strategy_json=?,last_error=NULL,updated_at=? WHERE project_id=?')
    .bind('agent_running', buildId, JSON.stringify(models), new Date().toISOString(), row.id).run();
  await env.DB.prepare('UPDATE projects SET status=?,updated_at=? WHERE id=?').bind('agent_running', new Date().toISOString(), row.id).run();
  await recordEvent(env, row.id, 'watchdog_engineering_dispatched', `Autonomous watchdog dispatched fresh procedural build ${buildId} from current main.`, 'agent_running');
}

async function runWatchdog(env: RuntimeEnv): Promise<void> {
  if (!env.DB || !env.SESSION_SECRET || !env.TOKEN_ENCRYPTION_KEY) return;
  const result = await env.DB.prepare(`SELECT p.id,p.owner_id,p.prompt,p.github_repository,a.updated_at,a.intent_json,a.architecture_json,a.task_plan_json,a.model_strategy_json
    FROM projects p JOIN agent_projects a ON a.project_id=p.id
    WHERE a.phase='agent_running' AND p.github_repository IS NOT NULL
    ORDER BY a.updated_at ASC LIMIT 10`).all<WatchRow>();

  for (const row of result.results || []) {
    if (!olderThan(row.updated_at, 4 * 60 * 1000)) continue;
    let token: string;
    try { token = await githubToken(env, row.owner_id); } catch { continue; }
    const state = await latestWorkflowState(row.github_repository, token);
    if (state === 'active' || state === 'unknown') continue;

    const claimTime = new Date().toISOString();
    const claimed = await env.DB.prepare(`UPDATE agent_projects SET phase='watchdog_restarting',last_error=?,updated_at=?
      WHERE project_id=? AND phase='agent_running' AND updated_at=?`)
      .bind(`Watchdog detected no active GitHub engineering workflow (${state}); restarting automatically.`, claimTime, row.id, row.updated_at).run();
    if (!claimed.meta?.changes) continue;
    await env.DB.prepare("UPDATE projects SET status='watchdog_restarting',updated_at=? WHERE id=?").bind(claimTime, row.id).run();
    await recordEvent(env, row.id, 'watchdog_stale_run_detected', `GitHub workflow state=${state}; starting autonomous recovery.`, 'watchdog_restarting');

    try {
      await dispatchFreshBuild(env, row, token);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await env.DB.prepare("UPDATE agent_projects SET phase='failed',last_error=?,updated_at=? WHERE project_id=?").bind(detail.slice(0, 4000), new Date().toISOString(), row.id).run();
      await env.DB.prepare("UPDATE projects SET status='failed',updated_at=? WHERE id=?").bind(new Date().toISOString(), row.id).run();
      await recordEvent(env, row.id, 'watchdog_restart_failed', detail, 'failed');
    }
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const module = await entry;
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/projects')) ctx.waitUntil(runWatchdog(env));
    return module.default.fetch(request, env as never, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
  async scheduled(_controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runWatchdog(env));
  },
};
