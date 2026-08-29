import { BuildCoordinator } from './index';
import { AGENT_RUNNER, AGENT_VALIDATOR, AGENT_VALIDATOR_JS, AGENT_WORKFLOW } from './agent-template';

export { BuildCoordinator };

type RuntimeEnv = {
  DB: D1Database;
  APP_ORIGIN?: string;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string | CryptoKey;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  WORKERS_DEV_SUBDOMAIN?: string;
};

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  prompt: string;
  github_repository: string | null;
  worker_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
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
  workflow_run_id: string | null;
  d1_database_id: string | null;
  d1_database_name: string | null;
  live_url: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ModelStrategy = {
  provider: 'openrouter';
  architect: string;
  coder: string;
  debugger: string;
  reviewer: string;
  research: string;
  fallbacks: string[];
  policy: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = 'vela_session';
const DEFAULT_MODEL = 'z-ai/glm-5.2:free';
const DEFAULT_MODELS: ModelStrategy = {
  provider: 'openrouter',
  architect: DEFAULT_MODEL,
  coder: DEFAULT_MODEL,
  debugger: DEFAULT_MODEL,
  reviewer: DEFAULT_MODEL,
  research: DEFAULT_MODEL,
  fallbacks: [],
  policy: 'Only explicit OpenRouter models ending in :free may execute engineering work. Cloudflare Workers AI and generic deterministic scaffolds are forbidden as coding fallbacks.',
};

const legacyEntry = import('./entry-failsafe');

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
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out.buffer;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function normalizedSessionSecret(raw: string): Promise<string> {
  return base64Url(await sha256Bytes(raw));
}

async function sessionHmac(value: string, rawSecret: string): Promise<string> {
  const normalized = await normalizedSessionSecret(rawSecret);
  const key = await crypto.subtle.importKey('raw', toBuffer(base64UrlBytes(normalized)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function readSession(request: Request, rawSecret: string): Promise<string | null> {
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!value) return null;
  const [id, signature] = value.split('.');
  if (!id || !signature) return null;
  return (await sessionHmac(id, rawSecret)) === signature ? id : null;
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
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function makeBuildToken(projectId: string, buildId: string, secret: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify({ project_id: projectId, build_id: buildId, exp: Date.now() + 6 * 60 * 60 * 1000 })));
  return `${payload}.${await scopedHmac(payload, secret)}`;
}

async function verifyBuildToken(request: Request, env: RuntimeEnv): Promise<{ project_id: string; build_id: string } | null> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature || await scopedHmac(payload, env.SESSION_SECRET) !== signature) return null;
  try {
    const parsed = JSON.parse(decoder.decode(base64UrlBytes(payload))) as { project_id?: string; build_id?: string; exp?: number };
    if (!parsed.project_id || !parsed.build_id || !parsed.exp || parsed.exp < Date.now()) return null;
    return { project_id: parsed.project_id, build_id: parsed.build_id };
  } catch {
    return null;
  }
}

function safeSlug(value: string, fallback = 'app'): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 42);
  return slug || fallback;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

async function ensureAgentSchema(env: RuntimeEnv): Promise<void> {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS agent_projects (
      project_id TEXT PRIMARY KEY, phase TEXT NOT NULL, intent_json TEXT, architecture_json TEXT,
      task_plan_json TEXT, model_strategy_json TEXT, validation_json TEXT, build_commit_sha TEXT,
      workflow_run_id TEXT, d1_database_id TEXT, d1_database_name TEXT, live_url TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_build_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, repository TEXT NOT NULL, status TEXT NOT NULL,
      workflow_run_id TEXT, commit_sha TEXT, validation_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_llm_calls (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, build_id TEXT, role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, status TEXT NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0,
      prompt_chars INTEGER NOT NULL DEFAULT 0, response_chars INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_full_prompts (project_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
}

async function fullPrompt(env: RuntimeEnv, project: ProjectRow): Promise<string> {
  const stored = await env.DB.prepare('SELECT prompt FROM project_full_prompts WHERE project_id = ?').bind(project.id).first<{ prompt?: string }>();
  return stored?.prompt?.trim() || project.prompt;
}

async function setFullPrompt(env: RuntimeEnv, projectId: string, prompt: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO project_full_prompts(project_id,prompt,updated_at) VALUES(?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET prompt=excluded.prompt, updated_at=excluded.updated_at`).bind(projectId, prompt, now).run();
  await env.DB.prepare('UPDATE projects SET prompt = ?, updated_at = ? WHERE id = ?').bind(prompt, now, projectId).run();
}

async function recordEvent(env: RuntimeEnv, projectId: string, kind: string, detail: string, stage: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO build_events(id,project_id,kind,detail,stage,created_at) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), projectId, kind, detail.slice(0, 4000), stage, new Date().toISOString()).run();
  } catch {}
}

async function projectForOwner(env: RuntimeEnv, projectId: string, ownerId: string): Promise<ProjectRow | null> {
  return env.DB.prepare('SELECT id,owner_id,name,prompt,github_repository,worker_name,status,created_at,updated_at FROM projects WHERE id=? AND owner_id=?')
    .bind(projectId, ownerId).first<ProjectRow>();
}

async function agentForProject(env: RuntimeEnv, projectId: string): Promise<AgentRow | null> {
  return env.DB.prepare('SELECT * FROM agent_projects WHERE project_id=?').bind(projectId).first<AgentRow>();
}

async function upsertAgent(env: RuntimeEnv, projectId: string, phase: string, fields: Record<string, string | null> = {}): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO agent_projects(project_id,phase,created_at,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET phase=excluded.phase, updated_at=excluded.updated_at`).bind(projectId, phase, now, now).run();
  const allowed = ['intent_json','architecture_json','task_plan_json','model_strategy_json','validation_json','build_commit_sha','workflow_run_id','d1_database_id','d1_database_name','live_url','last_error'];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    await env.DB.prepare(`UPDATE agent_projects SET ${key}=?, updated_at=? WHERE project_id=?`).bind(value, now, projectId).run();
  }
  await env.DB.prepare('UPDATE projects SET status=?, updated_at=? WHERE id=?').bind(phase, now, projectId).run();
}

async function ownerOpenRouterKey(env: RuntimeEnv, ownerId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT openrouter_key_ciphertext FROM workspace_settings WHERE owner_id=?').bind(ownerId).first<{ openrouter_key_ciphertext?: string | null }>();
  if (row?.openrouter_key_ciphertext) {
    try { return JSON.parse(await decryptStored(row.openrouter_key_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string; } catch {}
  }
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  throw new Error('OpenRouter API key is required for procedural engineering. Configure it in Vela AI Toolbox or GitHub Actions runtime secret.');
}

function freeModel(model: string): string {
  const normalized = model.trim();
  if (!normalized.endsWith(':free')) throw new Error(`Paid/non-explicit model refused: ${normalized}. Vela agentic builds are restricted to explicit OpenRouter :free models.`);
  return normalized;
}

async function logLLM(env: RuntimeEnv, args: { projectId: string; buildId?: string; role: string; model: string; status: string; latency: number; promptChars: number; responseChars: number; error?: string }): Promise<void> {
  try {
    await env.DB.prepare(`INSERT INTO agent_llm_calls(id,project_id,build_id,role,provider,model,status,latency_ms,prompt_chars,response_chars,error,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), args.projectId, args.buildId || null, args.role, 'openrouter', args.model, args.status, args.latency, args.promptChars, args.responseChars, args.error || null, new Date().toISOString()).run();
  } catch {}
}

async function callOpenRouter(env: RuntimeEnv, ownerId: string, projectId: string, buildId: string | undefined, role: string, model: string, messages: Array<{ role: string; content: string }>, maxTokens = 9000): Promise<string> {
  const key = await ownerOpenRouterKey(env, ownerId);
  const selected = freeModel(model);
  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const start = Date.now();
  let lastError = 'OpenRouter request failed';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'Vela Procedural Engineering Agent' },
        body: JSON.stringify({ model: selected, messages, temperature: 0.1, max_tokens: maxTokens }),
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `OpenRouter ${response.status}: ${text.slice(0, 900)}`;
        if ((response.status === 429 || response.status >= 500) && attempt < 4) {
          await new Promise(resolve => setTimeout(resolve, 600 * 2 ** (attempt - 1)));
          continue;
        }
        throw new Error(lastError);
      }
      const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content || '';
      if (!content.trim()) throw new Error('OpenRouter returned empty content');
      await logLLM(env, { projectId, buildId, role, model: selected, status: 'success', latency: Date.now() - start, promptChars, responseChars: content.length });
      return content;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 600 * 2 ** (attempt - 1)));
        continue;
      }
    }
  }
  await logLLM(env, { projectId, buildId, role, model: selected, status: 'failed', latency: Date.now() - start, promptChars, responseChars: 0, error: lastError });
  throw new Error(lastError);
}

function extractObject<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned) as T; } catch {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1)) as T;
  throw new Error('Model did not return valid JSON');
}

async function generateIntent(env: RuntimeEnv, project: ProjectRow, feedback = ''): Promise<void> {
  const requirements = await fullPrompt(env, project);
  await upsertAgent(env, project.id, 'analyzing_intent', { last_error: null });
  await recordEvent(env, project.id, 'intent_analysis_started', 'Reading the complete untruncated requirements before any architecture decision', 'analyzing_intent');
  try {
    const content = await callOpenRouter(env, project.owner_id, project.id, undefined, 'architect', DEFAULT_MODELS.architect, [
      { role: 'system', content: `You are Vela's product-intent analyst. Do not design architecture yet. Extract what the user actually wants and identify decisions that must be confirmed rather than guessed. Return ONLY JSON with: summary, primary_outcome, intended_users, in_scope[], out_of_scope[], hard_constraints[], non_negotiables[], assumptions_to_confirm[], questions_for_user[], success_definition[]. Do not shrink the requested scope because it is difficult.` },
      { role: 'user', content: `AUTHORITATIVE FULL REQUIREMENTS:\n${requirements}\n\n${feedback ? `USER REVISION FEEDBACK:\n${feedback}` : ''}` },
    ], 7000);
    const intent = extractObject<Record<string, unknown>>(content);
    await upsertAgent(env, project.id, 'awaiting_intent_confirmation', { intent_json: JSON.stringify(intent), model_strategy_json: JSON.stringify(DEFAULT_MODELS) });
    await recordEvent(env, project.id, 'intent_ready', 'Intent extracted. User confirmation is required before Vela is allowed to choose architecture.', 'awaiting_intent_confirmation');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await upsertAgent(env, project.id, 'failed', { last_error: detail });
    await recordEvent(env, project.id, 'intent_failed', detail, 'failed');
  }
}

async function generateArchitecture(env: RuntimeEnv, project: ProjectRow, feedback = ''): Promise<void> {
  const requirements = await fullPrompt(env, project);
  const agent = await agentForProject(env, project.id);
  const intent = parseJson(agent?.intent_json || null, {});
  await upsertAgent(env, project.id, 'designing_architecture', { last_error: null });
  await recordEvent(env, project.id, 'architecture_started', 'Designing architecture only after confirmed product intent', 'designing_architecture');
  try {
    const content = await callOpenRouter(env, project.owner_id, project.id, undefined, 'architect', DEFAULT_MODELS.architect, [
      { role: 'system', content: `You are Vela's principal software architect. Design a production architecture for the confirmed intent. The actual coding execution plane is GitHub Actions with a real writable checkout and shell. Source of truth is GitHub. Deployment target is Cloudflare free-tier services. Engineering LLM calls must use explicit OpenRouter :free models only. Do not invent capabilities, paid services, or external data sources. Surface material product/architecture decisions for the user instead of silently deciding them. Return ONLY JSON with: recommended_architecture, execution_plane, components[], persistence, data_ingestion, external_sources_strategy, frontend, backend, testing, deployment, security, free_tier_constraints[], user_decisions[{id,decision,recommendation,alternatives[],why_it_matters}], risks[], rejected_shortcuts[].` },
      { role: 'user', content: `FULL REQUIREMENTS:\n${requirements}\n\nCONFIRMED INTENT:\n${JSON.stringify(intent, null, 2)}\n\n${feedback ? `USER ARCHITECTURE FEEDBACK:\n${feedback}` : ''}` },
    ], 9000);
    const architecture = extractObject<Record<string, unknown>>(content);
    await upsertAgent(env, project.id, 'awaiting_architecture_confirmation', { architecture_json: JSON.stringify(architecture) });
    await recordEvent(env, project.id, 'architecture_ready', 'Architecture proposal is ready. User confirmation is required before engineering tasks are created.', 'awaiting_architecture_confirmation');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await upsertAgent(env, project.id, 'failed', { last_error: detail });
    await recordEvent(env, project.id, 'architecture_failed', detail, 'failed');
  }
}

async function generateTaskPlan(env: RuntimeEnv, project: ProjectRow, feedback = ''): Promise<void> {
  const requirements = await fullPrompt(env, project);
  const agent = await agentForProject(env, project.id);
  const intent = parseJson(agent?.intent_json || null, {});
  const architecture = parseJson(agent?.architecture_json || null, {});
  await upsertAgent(env, project.id, 'planning_engineering', { last_error: null });
  await recordEvent(env, project.id, 'engineering_plan_started', 'Decomposing the confirmed architecture into procedural engineering tasks with executable acceptance checks', 'planning_engineering');
  try {
    const content = await callOpenRouter(env, project.owner_id, project.id, undefined, 'architect', DEFAULT_MODELS.architect, [
      { role: 'system', content: `You are the engineering manager for an autonomous procedural coding system. Decompose the confirmed application into a dependency-aware task DAG. Tasks must be small enough for an engineer to implement, test, review, and checkpoint independently. Do not ask one model to generate the whole app. Include architecture foundation, data/schema, backend/domain modules, ingestion/integrations, deterministic calculations, AI qualitative layers where requested, frontend, tests, integration, and deployment-readiness as appropriate. Return ONLY JSON with: milestones[], tasks[]. Each task must contain id, title, agent_role, depends_on[], scope[], acceptance[], validation_commands[], files_expected[]. Validation commands must be executable in an Ubuntu GitHub Actions checkout. Do not include actual deployment; deployment is a later user-approved gate.` },
      { role: 'user', content: `FULL REQUIREMENTS:\n${requirements}\n\nCONFIRMED INTENT:\n${JSON.stringify(intent, null, 2)}\n\nCONFIRMED ARCHITECTURE:\n${JSON.stringify(architecture, null, 2)}\n\nMODEL POLICY:\n${JSON.stringify(DEFAULT_MODELS, null, 2)}\n\n${feedback ? `USER PLAN FEEDBACK:\n${feedback}` : ''}` },
    ], 11000);
    const plan = extractObject<{ milestones?: unknown[]; tasks?: unknown[] }>(content);
    if (!Array.isArray(plan.tasks) || plan.tasks.length < 3) throw new Error('Engineering planner returned an implausibly small task graph');
    await upsertAgent(env, project.id, 'awaiting_build_plan_confirmation', { task_plan_json: JSON.stringify(plan), model_strategy_json: JSON.stringify(DEFAULT_MODELS) });
    await recordEvent(env, project.id, 'engineering_plan_ready', `${plan.tasks.length} procedural engineering tasks are ready. User approval is required before a GitHub Actions agent workspace starts.`, 'awaiting_build_plan_confirmation');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await upsertAgent(env, project.id, 'failed', { last_error: detail });
    await recordEvent(env, project.id, 'engineering_plan_failed', detail, 'failed');
  }
}

async function connectedGithubToken(env: RuntimeEnv, ownerId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT access_token_ciphertext FROM connections WHERE owner_id=? AND provider='github' AND status='connected'`).bind(ownerId).first<{ access_token_ciphertext?: string | null }>();
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

async function githubJson<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const result = await githubRequest(token, path, init);
  if (result.status < 200 || result.status >= 300) throw new Error(`GitHub ${result.status}: ${result.text.slice(0, 1200)}`);
  return result.text ? JSON.parse(result.text) as T : {} as T;
}

async function putGithubFile(token: string, repository: string, path: string, content: string, message: string): Promise<void> {
  let sha: string | undefined;
  const existing = await githubRequest(token, `/repos/${repository}/contents/${encodeURIComponent(path).replaceAll('%2F','/')}`);
  if (existing.status === 200) {
    try { sha = (JSON.parse(existing.text) as { sha?: string }).sha; } catch {}
  } else if (existing.status !== 404) {
    throw new Error(`GitHub read ${path} failed (${existing.status}): ${existing.text.slice(0, 800)}`);
  }
  const body: Record<string, unknown> = { message, content: base64(encoder.encode(content)), branch: 'main' };
  if (sha) body.sha = sha;
  await githubJson(token, `/repos/${repository}/contents/${encodeURIComponent(path).replaceAll('%2F','/')}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function ensureRepository(env: RuntimeEnv, project: ProjectRow): Promise<{ repository: string; token: string }> {
  const token = await connectedGithubToken(env, project.owner_id);
  if (project.github_repository) return { repository: project.github_repository, token };
  const name = `${safeSlug(project.name)}-${project.id.replaceAll('-','').slice(0,8)}`;
  const created = await githubJson<{ full_name: string }>(token, '/user/repos', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, private: true, auto_init: true, has_issues: true, description: `Vela procedural engineering project: ${project.name}` }),
  });
  await env.DB.prepare('UPDATE projects SET github_repository=?, updated_at=? WHERE id=?').bind(created.full_name, new Date().toISOString(), project.id).run();
  return { repository: created.full_name, token };
}

async function bootstrapAgentWorkflow(env: RuntimeEnv, project: ProjectRow): Promise<void> {
  const requirements = await fullPrompt(env, project);
  const agent = await agentForProject(env, project.id);
  if (!agent?.intent_json || !agent.architecture_json || !agent.task_plan_json) throw new Error('Confirmed intent, architecture, and engineering plan are required');
  const { repository, token } = await ensureRepository(env, project);
  const buildId = crypto.randomUUID();
  const buildToken = await makeBuildToken(project.id, buildId, env.SESSION_SECRET);
  const now = new Date().toISOString();

  await upsertAgent(env, project.id, 'bootstrapping_agent', { last_error: null });
  await recordEvent(env, project.id, 'agent_bootstrap_started', `Installing procedural engineering runner into ${repository}. No new application repository will be created for retries.`, 'bootstrapping_agent');

  await putGithubFile(token, repository, '.vela/requirements.md', requirements, 'vela: persist authoritative requirements');
  await putGithubFile(token, repository, '.vela/intent.json', JSON.stringify(parseJson(agent.intent_json, {}), null, 2), 'vela: persist confirmed intent');
  await putGithubFile(token, repository, '.vela/architecture.json', JSON.stringify(parseJson(agent.architecture_json, {}), null, 2), 'vela: persist confirmed architecture');
  await putGithubFile(token, repository, '.vela/task-plan.json', JSON.stringify(parseJson(agent.task_plan_json, {}), null, 2), 'vela: persist approved engineering plan');
  await putGithubFile(token, repository, '.vela/models.json', JSON.stringify(parseJson<ModelStrategy>(agent.model_strategy_json, DEFAULT_MODELS), null, 2), 'vela: persist approved free-model strategy');
  await putGithubFile(token, repository, '.vela/agent-runner.mjs', AGENT_RUNNER, 'vela: install procedural engineering agent');
  await putGithubFile(token, repository, '.vela/ab-project-validate', AGENT_VALIDATOR, 'vela: install project validator command');
  await putGithubFile(token, repository, '.vela/validator.mjs', AGENT_VALIDATOR_JS, 'vela: install substantive project validator');
  await putGithubFile(token, repository, '.github/workflows/vela-agent-build.yml', AGENT_WORKFLOW, 'vela: install procedural agent workflow');

  await env.DB.prepare('INSERT INTO agent_build_runs(id,project_id,repository,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .bind(buildId, project.id, repository, 'dispatching', now, now).run();

  let dispatched = false;
  let last = '';
  for (let attempt = 1; attempt <= 5 && !dispatched; attempt++) {
    const result = await githubRequest(token, `/repos/${repository}/actions/workflows/vela-agent-build.yml/dispatches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'main', inputs: { project_id: project.id, build_id: buildId, build_token: buildToken, control_plane: env.APP_ORIGIN || 'https://vela-control-plane.averymiddlebrook2014.workers.dev' } }),
    });
    if (result.status === 204) dispatched = true;
    else {
      last = `GitHub workflow dispatch ${result.status}: ${result.text.slice(0, 900)}`;
      await new Promise(resolve => setTimeout(resolve, attempt * 1200));
    }
  }
  if (!dispatched) throw new Error(last || 'Could not dispatch procedural engineering workflow');

  await env.DB.prepare('UPDATE agent_build_runs SET status=?,updated_at=? WHERE id=?').bind('running', new Date().toISOString(), buildId).run();
  await upsertAgent(env, project.id, 'agent_running', { workflow_run_id: buildId });
  await recordEvent(env, project.id, 'agent_dispatched', `Procedural GitHub Actions engineering workspace started. Build ID ${buildId}.`, 'agent_running');
}

async function githubTextFile(token: string, repository: string, filePath: string): Promise<string | null> {
  const result = await githubRequest(token, `/repos/${repository}/contents/${encodeURIComponent(filePath).replaceAll('%2F','/')}?ref=main`);
  if (result.status === 404) return null;
  if (result.status !== 200) throw new Error(`GitHub file read ${filePath} failed (${result.status}): ${result.text.slice(0, 900)}`);
  const payload = JSON.parse(result.text) as { content?: string; encoding?: string };
  if (!payload.content) return null;
  return decoder.decode(Uint8Array.from(atob(payload.content.replace(/\s/g, '')), c => c.charCodeAt(0)));
}

async function cloudflareToken(env: RuntimeEnv, ownerId: string): Promise<string> {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const row = await env.DB.prepare(`SELECT access_token_ciphertext FROM connections WHERE owner_id=? AND provider='cloudflare' AND status='connected'`).bind(ownerId).first<{ access_token_ciphertext?: string | null }>();
  if (!row?.access_token_ciphertext) throw new Error('Cloudflare is not connected');
  return JSON.parse(await decryptStored(row.access_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string;
}

async function cfJson<T>(env: RuntimeEnv, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as { success?: boolean; result?: T; errors?: Array<{ message?: string; code?: number }> } : {};
  if (!response.ok || payload.success === false) throw new Error(`Cloudflare ${response.status}: ${payload.errors?.map(e => `${e.code || ''} ${e.message || ''}`).join('; ') || text.slice(0, 1200)}`);
  return (payload.result ?? payload) as T;
}

function splitSql(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote && sql[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';') { if (current.trim()) out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

async function deployValidatedBuild(env: RuntimeEnv, project: ProjectRow): Promise<void> {
  const agent = await agentForProject(env, project.id);
  if (!agent?.build_commit_sha || !project.github_repository) throw new Error('No validated engineering commit is available to deploy');
  const validation = parseJson<{ pass?: boolean }>(agent.validation_json, {});
  if (validation.pass === false) throw new Error('Deployment blocked because procedural validator did not pass');

  await upsertAgent(env, project.id, 'deploying_worker', { last_error: null });
  await recordEvent(env, project.id, 'deployment_started', `Deploying validated commit ${agent.build_commit_sha.slice(0, 12)} after explicit user approval`, 'deploying_worker');

  const gh = await connectedGithubToken(env, project.owner_id);
  const cf = await cloudflareToken(env, project.owner_id);
  const workerSource = await githubTextFile(gh, project.github_repository, 'src/worker.mjs');
  if (!workerSource) throw new Error('Validated repository does not contain src/worker.mjs');
  const schema = await githubTextFile(gh, project.github_repository, 'schema.sql');
  const suffix = project.id.replaceAll('-', '').slice(0, 8);
  const workerName = project.worker_name || `vela-${safeSlug(project.name)}-${suffix}`;
  let databaseId = agent.d1_database_id;
  let databaseName = agent.d1_database_name;

  if ((schema && schema.trim()) || /\benv\.DB\b/.test(workerSource)) {
    if (!databaseId) {
      databaseName = `vela-${safeSlug(project.name)}-${suffix}`.slice(0, 60);
      const created = await cfJson<{ uuid: string; name: string }>(env, cf, `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database`, { method: 'POST', body: JSON.stringify({ name: databaseName }) });
      databaseId = created.uuid;
      await upsertAgent(env, project.id, 'deploying_worker', { d1_database_id: databaseId, d1_database_name: databaseName });
      await recordEvent(env, project.id, 'd1_created', `Provisioned D1 database ${databaseName}`, 'deploying_worker');
    }
    if (schema?.trim()) {
      for (const statement of splitSql(schema)) {
        if (!statement || /^--/.test(statement) && !statement.includes('\n')) continue;
        await cfJson(env, cf, `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(databaseId)}/query`, { method: 'POST', body: JSON.stringify({ sql: statement }) });
      }
      await recordEvent(env, project.id, 'd1_schema_applied', 'Applied validated repository schema to provisioned D1 database', 'deploying_worker');
    }
  }

  const metadata: Record<string, unknown> = { main_module: 'worker.mjs', compatibility_date: '2026-08-25', compatibility_flags: ['nodejs_compat'], bindings: [] as unknown[] };
  if (databaseId) (metadata.bindings as unknown[]).push({ type: 'd1', name: 'DB', id: databaseId });
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.set('worker.mjs', new Blob([workerSource], { type: 'application/javascript+module' }), 'worker.mjs');
  const upload = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(workerName)}`, { method: 'PUT', headers: { authorization: `Bearer ${cf}` }, body: form });
  const uploadText = await upload.text();
  if (!upload.ok) throw new Error(`Cloudflare Worker deployment failed (${upload.status}): ${uploadText.slice(0, 1800)}`);

  await cfJson(env, cf, `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, { method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: true }) });
  const subdomain = env.WORKERS_DEV_SUBDOMAIN || 'averymiddlebrook2014';
  const liveUrl = `https://${workerName}.${subdomain}.workers.dev`;

  let rootStatus = 0;
  let healthStatus = 0;
  let selfTestStatus = 0;
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      rootStatus = (await fetch(liveUrl, { redirect: 'follow' })).status;
      healthStatus = (await fetch(`${liveUrl}/api/health`, { redirect: 'follow' })).status;
      selfTestStatus = (await fetch(`${liveUrl}/api/self-test`, { redirect: 'follow' })).status;
      if (rootStatus >= 200 && rootStatus < 500 && healthStatus >= 200 && healthStatus < 300 && selfTestStatus >= 200 && selfTestStatus < 300) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
  }
  if (!(rootStatus >= 200 && rootStatus < 500 && healthStatus >= 200 && healthStatus < 300 && selfTestStatus >= 200 && selfTestStatus < 300)) {
    throw new Error(`Live QA failed: root=${rootStatus || 'unreachable'}, /api/health=${healthStatus || 'unreachable'}, /api/self-test=${selfTestStatus || 'unreachable'}`);
  }

  await env.DB.prepare('UPDATE projects SET worker_name=?, status=?, updated_at=? WHERE id=?').bind(workerName, 'awaiting_user_acceptance', new Date().toISOString(), project.id).run();
  await upsertAgent(env, project.id, 'awaiting_user_acceptance', { live_url: liveUrl });
  await recordEvent(env, project.id, 'live_qa_passed', `Validated commit is live and passed root, health, and self-test probes at ${liveUrl}. Final user acceptance is required before COMPLETE.`, 'awaiting_user_acceptance');
}

function agentData(row: AgentRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    phase: row.phase,
    intent: parseJson(row.intent_json, null),
    architecture: parseJson(row.architecture_json, null),
    task_plan: parseJson(row.task_plan_json, null),
    models: parseJson(row.model_strategy_json, DEFAULT_MODELS),
    validation: parseJson(row.validation_json, null),
    commit_sha: row.build_commit_sha,
    live_url: row.live_url,
    last_error: row.last_error,
  };
}

function gateScript(): string {
  return String.raw`
<style>
.agent-gate{margin:14px 0;padding:16px;border:1px solid #334575;border-radius:14px;background:#090d1c}.agent-gate h4{color:#46d0f7;margin:0 0 8px}.agent-gate pre{max-height:340px;white-space:pre-wrap}.agent-note{font-size:12px;color:#aab5d8;line-height:1.5}.agent-status{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#53e5a5}.agent-feedback{width:100%;min-height:78px;margin-top:10px}.agent-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
</style>
<script>
const legacyRenderProjectsV1 = renderProjects;
function prettyAgent(value){try{return JSON.stringify(value,null,2)}catch{return String(value||'')}}
async function agentAction(id,action){
  const feedback=(document.getElementById('agent-feedback-'+id)||{}).value||'';
  const map={
    confirm_intent:'/projects/'+id+'/agent/intent/confirm', revise_intent:'/projects/'+id+'/agent/intent/revise',
    confirm_architecture:'/projects/'+id+'/agent/architecture/confirm', revise_architecture:'/projects/'+id+'/agent/architecture/revise',
    confirm_plan:'/projects/'+id+'/agent/plan/confirm', revise_plan:'/projects/'+id+'/agent/plan/revise',
    deploy:'/projects/'+id+'/agent/deploy/approve', accept:'/projects/'+id+'/agent/accept', continue:'/projects/'+id+'/agent/continue'
  };
  try{await api(map[action],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({feedback})});await loadWorkspace()}catch(e){alert(e.message)}
}
function agentGate(p){
  const a=p.agent;if(!a)return '';
  const f='<textarea class="agent-feedback" id="agent-feedback-'+p.id+'" placeholder="Add corrections, decisions, constraints, or revisions before continuing..."></textarea>';
  const btn=(label,act,cls='primary')=>'<button class="'+cls+'" onclick="agentAction(\\''+p.id+'\\',\\''+act+'\\')">'+label+'</button>';
  if(a.phase==='awaiting_intent_confirmation')return '<div class="agent-gate"><h4>1 / 5 — Confirm Product Intent</h4><div class="agent-note">Vela is not allowed to choose architecture until you confirm what it believes you are asking for.</div><pre>'+esc(prettyAgent(a.intent))+'</pre>'+f+'<div class="agent-actions">'+btn('Confirm Intent','confirm_intent')+btn('Revise Intent','revise_intent','secondary')+'</div></div>';
  if(a.phase==='awaiting_architecture_confirmation')return '<div class="agent-gate"><h4>2 / 5 — Confirm Architecture</h4><div class="agent-note">Review the actual execution plane, Cloudflare components, data strategy, and decisions. Material choices are surfaced instead of guessed.</div><pre>'+esc(prettyAgent(a.architecture))+'</pre>'+f+'<div class="agent-actions">'+btn('Confirm Architecture','confirm_architecture')+btn('Revise Architecture','revise_architecture','secondary')+'</div></div>';
  if(a.phase==='awaiting_build_plan_confirmation')return '<div class="agent-gate"><h4>3 / 5 — Confirm Engineering Plan + Free Models</h4><div class="agent-note">The build will execute task-by-task in GitHub Actions. Every task is implemented, command-tested, independently reviewed, and checkpoint-committed.</div><pre>'+esc(prettyAgent({models:a.models,task_plan:a.task_plan}))+'</pre>'+f+'<div class="agent-actions">'+btn('Approve Procedural Build','confirm_plan')+btn('Revise Plan','revise_plan','secondary')+'</div></div>';
  if(a.phase==='agent_running'||a.phase==='bootstrapping_agent')return '<div class="agent-gate"><h4>Engineering Agents Running</h4><div class="agent-note">Real GitHub Actions workspace: read repo → edit files → run commands → inspect failures → debug → independent review → checkpoint → integrate → ab-project-validate.</div><pre>'+esc(prettyAgent({models:a.models,commit:a.commit_sha,validation:a.validation}))+'</pre></div>';
  if(a.phase==='awaiting_deploy_approval')return '<div class="agent-gate"><h4>4 / 5 — Engineering Passed; Confirm Deployment</h4><div class="agent-note">No deployment occurs until you approve this validated commit.</div><pre>'+esc(prettyAgent({commit:a.commit_sha,validation:a.validation}))+'</pre>'+f+'<div class="agent-actions">'+btn('Approve Cloudflare Deployment','deploy')+btn('Send Back for Changes','continue','secondary')+'</div></div>';
  if(a.phase==='awaiting_user_acceptance')return '<div class="agent-gate"><h4>5 / 5 — Final User Acceptance</h4><div class="agent-note">The deployed app passed live root, health, and self-test probes. You decide whether the project is actually complete.</div><div class="agent-actions"><a class="secondary" style="text-decoration:none" target="_blank" href="'+esc(a.live_url||'#')+'">Open Live App ↗</a>'+btn('Accept as Complete','accept')+btn('Continue Engineering','continue','secondary')+'</div>'+f+'</div>';
  if(a.phase==='complete')return '<div class="agent-gate"><h4>COMPLETE — User Accepted</h4><div class="agent-note">This state means procedural engineering, validation, deployment QA, and explicit user acceptance all occurred.</div></div>';
  if(a.phase==='failed')return '<div class="agent-gate"><h4>Agentic Build Failed</h4><pre>'+esc(a.last_error||'Unknown failure')+'</pre><div class="agent-note">Retry restarts at intent confirmation instead of regenerating a whole app blindly.</div></div>';
  return '<div class="agent-gate"><h4>'+esc(String(a.phase||'working').replaceAll('_',' '))+'</h4><div class="agent-note">Vela is performing the current procedural stage. It will stop at the next decision gate.</div></div>';
}
renderProjects=function(){
  const root=document.getElementById('project-list');if(!projects.length){root.innerHTML='<div style="padding:48px 0;text-align:center;color:var(--muted)">No applications built yet.</div>';return}
  root.innerHTML=projects.map(p=>{
    const a=p.agent;const status=a?.phase||p.status;const repo=p.github_repository?'<a href="https://github.com/'+esc(p.github_repository)+'" target="_blank" class="secondary" style="text-decoration:none">GitHub Repo ↗</a>':'';
    const live=a?.live_url?'<a href="'+esc(a.live_url)+'" target="_blank" class="secondary" style="text-decoration:none;color:var(--cyan)">Open Live App ↗</a>':'';
    const retry=(status==='failed'||status==='complete')?'<button class="secondary" onclick="retryBuild(\\''+p.id+'\\')">'+(status==='complete'?'Start Change Request':'Restart Procedural Build')+'</button>':'';
    return '<article class="project-card"><div class="p-head"><div><h3>'+esc(p.name)+'</h3><div style="font-size:11px;color:var(--muted);margin-top:3px">ID: '+p.id.slice(0,8)+' · Updated '+new Date(p.updated_at).toLocaleTimeString()+'</div></div><span class="badge"><span class="agent-status">● '+esc(String(status).replaceAll('_',' '))+'</span></span></div><p class="p-desc">'+esc(p.prompt)+'</p>'+(p.latest_event?'<div style="font-size:12px;color:var(--muted);margin-bottom:12px"><b>'+esc(p.latest_event.kind)+'</b>: '+esc(p.latest_event.detail)+'</div>':'')+agentGate(p)+'<div class="action-row">'+live+repo+retry+'<button class="danger" onclick="deleteProject(\\''+p.id+'\\',\\''+esc(p.name)+'\\')">Delete Build 🗑</button></div></article>'
  }).join('')
};
loadWorkspace();
</script>`;
}

async function patchDashboard(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let html = await response.text();
  html = html.replace('Autonomous App Engineering', 'Procedural Autonomous App Engineering');
  html = html.replace('Describe your vision. Vela architectures the system, designs enterprise schemas, generates full-stack code, and deploys it to Cloudflare Edge with dedicated GitHub repos.', 'Describe the product. Vela confirms intent, asks you to approve architecture and engineering decisions, then runs a real task-by-task coding agent inside GitHub Actions before deployment.');
  html = html.replace('</body>', `${gateScript()}</body>`);
  return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function augmentProjects(response: Response, env: RuntimeEnv): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.clone().json() as { projects?: Array<Record<string, unknown> & { id: string }> };
  if (!body.projects?.length) return response;
  const rows = await env.DB.prepare('SELECT * FROM agent_projects WHERE project_id IN (' + body.projects.map(() => '?').join(',') + ')').bind(...body.projects.map(p => p.id)).all<AgentRow>();
  const byId = new Map((rows.results || []).map(row => [row.project_id, row]));
  body.projects = body.projects.map(project => ({ ...project, agent: agentData(byId.get(project.id) || null) }));
  return json(body);
}

async function createAgentProject(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return json({ error: 'Start a workspace first.' }, { status: 401 });
  const body = await request.json<{ name?: string; prompt?: string }>().catch(() => ({}));
  if (!body.name?.trim() || !body.prompt?.trim()) return json({ error: 'name and prompt are required' }, { status: 400 });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const prompt = body.prompt.trim();
  await env.DB.prepare('INSERT INTO projects(id,owner_id,name,prompt,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, ownerId, body.name.trim().slice(0, 80), prompt, 'analyzing_intent', now, now).run();
  await setFullPrompt(env, id, prompt);
  await upsertAgent(env, id, 'analyzing_intent', { model_strategy_json: JSON.stringify(DEFAULT_MODELS) });
  await recordEvent(env, id, 'project_created', 'Full requirements stored without truncation. Intent analysis started; architecture will not be chosen until the user confirms intent.', 'analyzing_intent');
  const project = await projectForOwner(env, id, ownerId);
  if (project) ctx.waitUntil(generateIntent(env, project));
  return json({ project: { ...project, agent: agentData(await agentForProject(env, id)) } }, { status: 201 });
}

async function restartAgentProject(request: Request, env: RuntimeEnv, ctx: ExecutionContext, projectId: string): Promise<Response> {
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return json({ error: 'Start a workspace first.' }, { status: 401 });
  const project = await projectForOwner(env, projectId, ownerId);
  if (!project) return json({ error: 'Project not found' }, { status: 404 });
  const body = await request.json<{ prompt?: string }>().catch(() => ({}));
  if (body.prompt?.trim()) await setFullPrompt(env, project.id, body.prompt.trim());
  const refreshed = await projectForOwner(env, project.id, ownerId);
  if (!refreshed) return json({ error: 'Project disappeared' }, { status: 404 });
  await upsertAgent(env, project.id, 'analyzing_intent', { intent_json: null, architecture_json: null, task_plan_json: null, validation_json: null, build_commit_sha: null, last_error: null });
  ctx.waitUntil(generateIntent(env, refreshed));
  return json({ status: 'analyzing_intent' }, { status: 202 });
}

async function handleUserGate(request: Request, env: RuntimeEnv, ctx: ExecutionContext, projectId: string, gate: string, action: string): Promise<Response> {
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return json({ error: 'Start a workspace first.' }, { status: 401 });
  const project = await projectForOwner(env, projectId, ownerId);
  if (!project) return json({ error: 'Project not found' }, { status: 404 });
  const body = await request.json<{ feedback?: string }>().catch(() => ({}));
  const feedback = body.feedback?.trim() || '';
  const agent = await agentForProject(env, project.id);
  if (!agent) return json({ error: 'Agentic build state is missing' }, { status: 409 });

  if (gate === 'intent') {
    if (action === 'revise') { ctx.waitUntil(generateIntent(env, project, feedback)); return json({ status: 'analyzing_intent' }, { status: 202 }); }
    if (agent.phase !== 'awaiting_intent_confirmation') return json({ error: 'Intent is not awaiting confirmation', currentStatus: agent.phase }, { status: 409 });
    await recordEvent(env, project.id, 'intent_confirmed', feedback ? `Intent confirmed with user note: ${feedback}` : 'User confirmed extracted product intent', 'designing_architecture');
    ctx.waitUntil(generateArchitecture(env, project, feedback));
    return json({ status: 'designing_architecture' }, { status: 202 });
  }

  if (gate === 'architecture') {
    if (action === 'revise') { ctx.waitUntil(generateArchitecture(env, project, feedback)); return json({ status: 'designing_architecture' }, { status: 202 }); }
    if (agent.phase !== 'awaiting_architecture_confirmation') return json({ error: 'Architecture is not awaiting confirmation', currentStatus: agent.phase }, { status: 409 });
    await recordEvent(env, project.id, 'architecture_confirmed', feedback ? `Architecture confirmed with user note: ${feedback}` : 'User confirmed architecture and material decisions', 'planning_engineering');
    ctx.waitUntil(generateTaskPlan(env, project, feedback));
    return json({ status: 'planning_engineering' }, { status: 202 });
  }

  if (gate === 'plan') {
    if (action === 'revise') { ctx.waitUntil(generateTaskPlan(env, project, feedback)); return json({ status: 'planning_engineering' }, { status: 202 }); }
    if (agent.phase !== 'awaiting_build_plan_confirmation') return json({ error: 'Engineering plan is not awaiting confirmation', currentStatus: agent.phase }, { status: 409 });
    await recordEvent(env, project.id, 'engineering_plan_confirmed', 'User approved the procedural task graph and explicit OpenRouter :free model policy', 'bootstrapping_agent');
    ctx.waitUntil((async () => {
      try { await bootstrapAgentWorkflow(env, project); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await upsertAgent(env, project.id, 'failed', { last_error: detail });
        await recordEvent(env, project.id, 'agent_bootstrap_failed', detail, 'failed');
      }
    })());
    return json({ status: 'bootstrapping_agent' }, { status: 202 });
  }

  return json({ error: 'Unknown confirmation gate' }, { status: 404 });
}

async function internalAgent(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/internal/agent/')) return null;
  const auth = await verifyBuildToken(request, env);
  if (!auth) return json({ error: 'Invalid or expired scoped build token' }, { status: 401 });
  const project = await env.DB.prepare('SELECT id,owner_id,name,prompt,github_repository,worker_name,status,created_at,updated_at FROM projects WHERE id=?').bind(auth.project_id).first<ProjectRow>();
  if (!project) return json({ error: 'Project not found' }, { status: 404 });
  const body = await request.json<Record<string, unknown>>().catch(() => ({}));
  if (body.project_id && body.project_id !== auth.project_id) return json({ error: 'Token project mismatch' }, { status: 403 });
  if (body.build_id && body.build_id !== auth.build_id) return json({ error: 'Token build mismatch' }, { status: 403 });

  if (url.pathname === '/internal/agent/event') {
    const kind = String(body.kind || 'agent_event').slice(0, 120);
    const detail = String(body.detail || '').slice(0, 4000);
    const stage = String(body.stage || 'agent_running').slice(0, 120);
    await recordEvent(env, project.id, kind, detail, stage);
    return json({ ok: true });
  }

  if (url.pathname === '/internal/agent/llm') {
    const role = String(body.role || 'coder');
    const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
    if (!messages.length) return json({ error: 'messages are required' }, { status: 400 });
    const agent = await agentForProject(env, project.id);
    const strategy = parseJson<ModelStrategy>(agent?.model_strategy_json || null, DEFAULT_MODELS);
    const roleModel = role === 'architect' ? strategy.architect : role === 'debugger' ? strategy.debugger : role === 'reviewer' ? strategy.reviewer : role === 'research' ? strategy.research : strategy.coder;
    const candidates = [roleModel, ...(strategy.fallbacks || [])].filter((value, index, list) => value && list.indexOf(value) === index).map(freeModel);
    let last = '';
    for (const model of candidates) {
      try {
        const content = await callOpenRouter(env, project.owner_id, project.id, auth.build_id, role, model, messages, 14000);
        return json({ provider: 'openrouter', model, role, content });
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
    }
    return json({ error: last || 'No approved free model succeeded' }, { status: 502 });
  }

  if (url.pathname === '/internal/agent/complete') {
    const commitSha = String(body.commit_sha || '');
    const validation = body.validation || {};
    const review = body.review || {};
    await env.DB.prepare('UPDATE agent_build_runs SET status=?,commit_sha=?,validation_json=?,updated_at=? WHERE id=?')
      .bind('awaiting_deploy_approval', commitSha, JSON.stringify({ validator: validation, review }), new Date().toISOString(), auth.build_id).run();
    await upsertAgent(env, project.id, 'awaiting_deploy_approval', { build_commit_sha: commitSha, validation_json: JSON.stringify({ pass: true, validator: validation, review }), last_error: null });
    await recordEvent(env, project.id, 'procedural_build_passed', `Engineering build ${auth.build_id} passed task reviews, integration checks, ab-project-validate, and final independent QA. Deployment requires explicit user approval.`, 'awaiting_deploy_approval');
    return json({ ok: true, status: 'awaiting_deploy_approval' });
  }

  if (url.pathname === '/internal/agent/fail') {
    const error = String(body.error || 'Procedural engineering job failed').slice(0, 4000);
    await env.DB.prepare('UPDATE agent_build_runs SET status=?,error=?,updated_at=? WHERE id=?').bind('failed', error, new Date().toISOString(), auth.build_id).run();
    await upsertAgent(env, project.id, 'failed', { last_error: error });
    await recordEvent(env, project.id, 'procedural_build_failed', error, 'failed');
    return json({ ok: true });
  }

  return json({ error: 'Unknown internal agent endpoint' }, { status: 404 });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    await ensureAgentSchema(env);
    const internal = await internalAgent(request, env, ctx);
    if (internal) return internal;
    const url = new URL(request.url);

    if (url.pathname === '/projects' && request.method === 'POST') return createAgentProject(request, env, ctx);

    const build = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/build$/);
    if (build && request.method === 'POST') return restartAgentProject(request, env, ctx, build[1]);

    const gate = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/agent\/(intent|architecture|plan)\/(confirm|revise)$/);
    if (gate && request.method === 'POST') return handleUserGate(request, env, ctx, gate[1], gate[2], gate[3]);

    const deploy = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/agent\/deploy\/approve$/);
    if (deploy && request.method === 'POST') {
      const ownerId = await readSession(request, env.SESSION_SECRET);
      if (!ownerId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, deploy[1], ownerId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const agent = await agentForProject(env, project.id);
      if (agent?.phase !== 'awaiting_deploy_approval') return json({ error: 'Validated build is not awaiting deployment approval', currentStatus: agent?.phase }, { status: 409 });
      ctx.waitUntil((async () => {
        try { await deployValidatedBuild(env, project); }
        catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await upsertAgent(env, project.id, 'failed', { last_error: detail });
          await recordEvent(env, project.id, 'deployment_failed', detail, 'failed');
        }
      })());
      return json({ status: 'deploying_worker' }, { status: 202 });
    }

    const accept = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/agent\/accept$/);
    if (accept && request.method === 'POST') {
      const ownerId = await readSession(request, env.SESSION_SECRET);
      if (!ownerId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, accept[1], ownerId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const agent = await agentForProject(env, project.id);
      if (agent?.phase !== 'awaiting_user_acceptance') return json({ error: 'Project is not awaiting final user acceptance', currentStatus: agent?.phase }, { status: 409 });
      await upsertAgent(env, project.id, 'complete');
      await recordEvent(env, project.id, 'user_accepted', 'User explicitly accepted the live application as complete', 'complete');
      return json({ status: 'complete' });
    }

    const cont = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/agent\/continue$/);
    if (cont && request.method === 'POST') {
      const ownerId = await readSession(request, env.SESSION_SECRET);
      if (!ownerId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, cont[1], ownerId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const body = await request.json<{ feedback?: string }>().catch(() => ({}));
      const feedback = body.feedback?.trim();
      if (feedback) {
        const current = await fullPrompt(env, project);
        await setFullPrompt(env, project.id, `${current}\n\nUSER CHANGE REQUEST / CORRECTION:\n${feedback}`);
      }
      const refreshed = await projectForOwner(env, project.id, ownerId);
      if (refreshed) ctx.waitUntil(generateIntent(env, refreshed!));
      return json({ status: 'analyzing_intent' }, { status: 202 });
    }

    const module = await legacyEntry;
    let response = await module.default.fetch(request, env as never);
    if (url.pathname === '/' && request.method === 'GET') response = await patchDashboard(response);
    if (url.pathname === '/projects' && request.method === 'GET') response = await augmentProjects(response, env);
    return response;
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    // Legacy queued scaffold jobs are intentionally not allowed to create new one-shot apps.
    // Existing queue traffic is delegated only for compatibility with already-running legacy operations.
    const module = await legacyEntry;
    return module.default.queue(batch as never, env as never);
  },
};
