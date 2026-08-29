export { BuildCoordinator } from './index';

const agentic = import('./entry-agentic');

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = 'vela_session';
const OPENROUTER_MODEL = 'z-ai/glm-5.2:free';

type RuntimeEnv = {
  DB: D1Database;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string | CryptoKey;
  OPENROUTER_API_KEY?: string;
  APP_ORIGIN?: string;
} & Record<PropertyKey, unknown>;

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

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function randomToken(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function sha256Text(value: string): Promise<string> {
  return base64Url(await sha256(value));
}

async function normalizedSessionSecret(raw: string): Promise<string> {
  return base64Url(await sha256(raw));
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

async function storageKey(value: string | CryptoKey): Promise<CryptoKey> {
  if (typeof value !== 'string') return value;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptStored(value: string, keyValue: string | CryptoKey): Promise<string> {
  const key = await storageKey(keyValue);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(iv) }, key, encoder.encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptStored(value: string, keyValue: string | CryptoKey): Promise<string> {
  const [iv, ciphertext] = value.split('.');
  if (!iv || !ciphertext) throw new Error('Invalid encrypted value');
  const key = await storageKey(keyValue);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(base64UrlBytes(iv)) }, key, toBuffer(base64UrlBytes(ciphertext)));
  return decoder.decode(plaintext);
}

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

function guardedEnv(env: RuntimeEnv): RuntimeEnv {
  if (!env?.DB) return env;
  const db = guardedDatabase(env.DB);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return db;
      return Reflect.get(target, property, receiver);
    },
  });
}

async function ensureOpenRouterSchema(env: RuntimeEnv): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_settings (
    owner_id TEXT PRIMARY KEY,
    active_provider TEXT DEFAULT 'openrouter',
    openrouter_key_ciphertext TEXT,
    openrouter_model TEXT DEFAULT '${OPENROUTER_MODEL}',
    openai_key_ciphertext TEXT,
    openai_model TEXT,
    gemini_key_ciphertext TEXT,
    gemini_model TEXT,
    anthropic_key_ciphertext TEXT,
    anthropic_model TEXT,
    cf_ai_model TEXT,
    custom_endpoint TEXT,
    custom_key_ciphertext TEXT,
    custom_model TEXT,
    updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS openrouter_oauth_states (
    state_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    code_verifier_ciphertext TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`).run();
}

async function workspaceOpenRouterKey(env: RuntimeEnv, ownerId: string): Promise<string | null> {
  if (env.OPENROUTER_API_KEY?.trim()) return env.OPENROUTER_API_KEY.trim();
  await ensureOpenRouterSchema(env);
  const row = await env.DB.prepare('SELECT openrouter_key_ciphertext FROM workspace_settings WHERE owner_id=?')
    .bind(ownerId).first<{ openrouter_key_ciphertext?: string | null }>();
  if (!row?.openrouter_key_ciphertext) return null;
  try {
    const parsed = JSON.parse(await decryptStored(row.openrouter_key_ciphertext, env.TOKEN_ENCRYPTION_KEY));
    return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
  } catch {
    return null;
  }
}

async function saveOpenRouterKey(env: RuntimeEnv, ownerId: string, key: string): Promise<void> {
  await ensureOpenRouterSchema(env);
  const ciphertext = await encryptStored(key, env.TOKEN_ENCRYPTION_KEY);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO workspace_settings(owner_id,active_provider,openrouter_key_ciphertext,openrouter_model,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET
      active_provider=excluded.active_provider,
      openrouter_key_ciphertext=excluded.openrouter_key_ciphertext,
      openrouter_model=excluded.openrouter_model,
      updated_at=excluded.updated_at`)
    .bind(ownerId, 'openrouter', ciphertext, OPENROUTER_MODEL, now).run();
}

async function validateOpenRouterKey(key: string): Promise<void> {
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${key}`, 'user-agent': 'Vela-Procedural-Agent' },
  });
  if (!response.ok) throw new Error(`OpenRouter key validation failed (${response.status})`);
}

async function openRouterStart(request: Request, env: RuntimeEnv): Promise<Response> {
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return Response.redirect(new URL('/', request.url).href, 302);
  await ensureOpenRouterSchema(env);

  const verifier = randomToken(48);
  const challenge = await sha256Text(verifier);
  const state = randomToken(24);
  const stateHash = await sha256Text(state);
  const origin = env.APP_ORIGIN || new URL(request.url).origin;
  const callback = `${origin}/auth/openrouter/callback?state=${encodeURIComponent(state)}`;
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const encryptedVerifier = await encryptStored(verifier, env.TOKEN_ENCRYPTION_KEY);

  await env.DB.prepare('DELETE FROM openrouter_oauth_states WHERE expires_at < ?').bind(new Date().toISOString()).run();
  await env.DB.prepare('INSERT INTO openrouter_oauth_states(state_hash,owner_id,code_verifier_ciphertext,expires_at,created_at) VALUES(?,?,?,?,?)')
    .bind(stateHash, ownerId, encryptedVerifier, expires, new Date().toISOString()).run();

  const authorize = new URL('https://openrouter.ai/auth');
  authorize.searchParams.set('callback_url', callback);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  return Response.redirect(authorize.href, 302);
}

async function resumeMostRecentOpenRouterFailure(request: Request, env: RuntimeEnv, ownerId: string, ctx: ExecutionContext): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT p.id
    FROM projects p
    JOIN agent_projects a ON a.project_id=p.id
    WHERE p.owner_id=? AND a.phase='failed' AND a.last_error LIKE 'OpenRouter API key is required%'
    ORDER BY p.updated_at DESC LIMIT 1`).bind(ownerId).first<{ id?: string }>();
  if (!row?.id) return null;

  const module = await agentic;
  const cookie = request.headers.get('cookie') || '';
  const synthetic = new Request(`${env.APP_ORIGIN || new URL(request.url).origin}/projects/${row.id}/build`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const response = await module.default.fetch(synthetic, guardedEnv(env) as never, ctx);
  return response.ok ? row.id : null;
}

async function openRouterCallback(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId || !code || !state) return Response.redirect(`${url.origin}/?openrouter=error`, 302);

  await ensureOpenRouterSchema(env);
  const stateHash = await sha256Text(state);
  const saved = await env.DB.prepare('SELECT owner_id,code_verifier_ciphertext,expires_at FROM openrouter_oauth_states WHERE state_hash=?')
    .bind(stateHash).first<{ owner_id?: string; code_verifier_ciphertext?: string; expires_at?: string }>();
  if (!saved?.code_verifier_ciphertext || saved.owner_id !== ownerId || !saved.expires_at || saved.expires_at < new Date().toISOString()) {
    return Response.redirect(`${url.origin}/?openrouter=error`, 302);
  }

  const verifier = JSON.parse(await decryptStored(saved.code_verifier_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string;
  const exchange = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  const body = await exchange.text();
  if (!exchange.ok) {
    console.error(JSON.stringify({ event: 'openrouter_oauth_exchange_failed', status: exchange.status, detail: body.slice(0, 500) }));
    return Response.redirect(`${url.origin}/?openrouter=error`, 302);
  }
  const payload = JSON.parse(body) as { key?: string };
  if (!payload.key) return Response.redirect(`${url.origin}/?openrouter=error`, 302);

  await validateOpenRouterKey(payload.key);
  await saveOpenRouterKey(env, ownerId, payload.key);
  await env.DB.prepare('DELETE FROM openrouter_oauth_states WHERE state_hash=?').bind(stateHash).run();
  const resumed = await resumeMostRecentOpenRouterFailure(request, env, ownerId, ctx).catch(() => null);
  return Response.redirect(`${url.origin}/?openrouter=connected${resumed ? `&resumed=${encodeURIComponent(resumed)}` : ''}`, 302);
}

function buildNeedsOpenRouter(url: URL, method: string): boolean {
  if (method !== 'POST') return false;
  if (url.pathname === '/projects') return true;
  if (/^\/projects\/[0-9a-f-]{36}\/build$/.test(url.pathname)) return true;
  if (/^\/projects\/[0-9a-f-]{36}\/agent\/(intent|architecture|plan)\/(confirm|revise)$/.test(url.pathname)) return true;
  return false;
}

async function blockUntilOpenRouterConnected(request: Request, env: RuntimeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!buildNeedsOpenRouter(url, request.method)) return null;
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return null;
  if (await workspaceOpenRouterKey(env, ownerId)) return null;
  return Response.json({
    error: 'OpenRouter connection required before procedural engineering can start.',
    code: 'OPENROUTER_CONNECTION_REQUIRED',
    status: 'awaiting_openrouter_connection',
    connect_url: '/auth/openrouter/start',
    model_policy: 'explicit OpenRouter :free models only',
  }, { status: 428, headers: { 'cache-control': 'no-store' } });
}

async function patchOpenRouterBanner(request: Request, response: Response, env: RuntimeEnv): Promise<Response> {
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/') return response;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return response;
  const connected = Boolean(await workspaceOpenRouterKey(env, ownerId));
  const query = new URL(request.url).searchParams.get('openrouter');
  const html = await response.text();
  const banner = connected
    ? `<div style="position:sticky;top:0;z-index:9999;padding:9px 18px;background:#082f1f;color:#a7f3d0;border-bottom:1px solid #166534;font:600 13px system-ui">● OpenRouter connected — procedural engineering uses explicit <code>:free</code> models only${query === 'connected' ? ' — connection saved securely' : ''}</div>`
    : `<div style="position:sticky;top:0;z-index:9999;padding:11px 18px;background:#3b1717;color:#fecaca;border-bottom:1px solid #7f1d1d;font:600 13px system-ui">OpenRouter is required before Vela can run an engineering agent. <a href="/auth/openrouter/start" style="margin-left:12px;color:white;background:#dc2626;padding:6px 10px;border-radius:7px;text-decoration:none">Connect OpenRouter</a></div>`;
  const patched = html.includes('<body') ? html.replace(/(<body[^>]*>)/i, `$1${banner}`) : `${banner}${html}`;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
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
  async fetch(request: Request, envInput: unknown, ctx: ExecutionContext): Promise<Response> {
    const env = envInput as RuntimeEnv;
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        mode: 'procedural-agentic',
        execution_plane: 'github-actions',
        llm_provider: 'openrouter',
        model_policy: 'explicit-:free-only',
        openrouter_auth: 'oauth-pkce-or-encrypted-workspace-key',
        confirmation_gates: ['intent', 'architecture', 'engineering_plan', 'deployment', 'final_user_acceptance'],
        timestamp: new Date().toISOString(),
      }, { headers: { 'cache-control': 'no-store' } });
    }

    try {
      if (url.pathname === '/auth/openrouter/start') return openRouterStart(request, env);
      if (url.pathname === '/auth/openrouter/callback') return openRouterCallback(request, env, ctx);

      const blocked = await blockUntilOpenRouterConnected(request, env);
      if (blocked) return blocked;

      const module = await agentic;
      const response = await module.default.fetch(request, guardedEnv(env) as never, ctx);
      return patchOpenRouterBanner(request, response, env);
    } catch (error) {
      return diagnostic(error);
    }
  },

  async queue(batch: MessageBatch<unknown>, envInput: unknown): Promise<void> {
    const env = envInput as RuntimeEnv;
    const module = await agentic;
    return module.default.queue(batch as never, guardedEnv(env) as never);
  },
};
