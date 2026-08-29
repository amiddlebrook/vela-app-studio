export { BuildCoordinator } from './index';

const entry = import('./entry-restart-force');
const SESSION_COOKIE = 'vela_session';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type RuntimeEnv = {
  DB?: D1Database;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string | CryptoKey;
};

type StaleRow = {
  id: string;
  github_repository: string;
  updated_at: string;
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
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

async function sessionHmac(value: string, rawSecret: string): Promise<string> {
  const normalized = base64Url(await sha256Bytes(rawSecret));
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

async function githubToken(env: RuntimeEnv, ownerId: string): Promise<string | null> {
  if (!env.DB || !env.TOKEN_ENCRYPTION_KEY) return null;
  const row = await env.DB.prepare(`SELECT access_token_ciphertext FROM connections WHERE owner_id=? AND provider='github' AND status='connected'`)
    .bind(ownerId).first<{ access_token_ciphertext?: string | null }>();
  if (!row?.access_token_ciphertext) return null;
  try { return JSON.parse(await decryptStored(row.access_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string; }
  catch { return null; }
}

async function latestWorkflowState(repository: string, token: string): Promise<'active' | 'completed' | 'missing' | 'unknown'> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/vela-agent-build.yml/runs?per_page=1`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'Vela-Self-Heal',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (response.status === 404) return 'missing';
    if (!response.ok) return 'unknown';
    const body = await response.json() as { workflow_runs?: Array<{ status?: string }> };
    const run = body.workflow_runs?.[0];
    if (!run) return 'missing';
    return run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting' || run.status === 'requested' || run.status === 'pending'
      ? 'active'
      : 'completed';
  } catch {
    return 'unknown';
  }
}

function olderThan(updatedAt: string, milliseconds: number): boolean {
  const time = Date.parse(updatedAt);
  return Number.isFinite(time) && Date.now() - time > milliseconds;
}

async function selfHealStaleRuns(request: Request, env: RuntimeEnv, downstream: { fetch(request: Request, env: never, ctx: ExecutionContext): Promise<Response> }, ctx: ExecutionContext): Promise<void> {
  if (!env.DB || !env.SESSION_SECRET) return;
  const url = new URL(request.url);
  if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/projects')) return;

  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return;
  const token = await githubToken(env, ownerId);
  if (!token) return;

  const rows = await env.DB.prepare(`SELECT p.id,p.github_repository,a.updated_at
    FROM projects p JOIN agent_projects a ON a.project_id=p.id
    WHERE p.owner_id=? AND a.phase='agent_running' AND p.github_repository IS NOT NULL
    ORDER BY a.updated_at ASC LIMIT 5`).bind(ownerId).all<StaleRow>();

  for (const row of rows.results || []) {
    if (!olderThan(row.updated_at, 3 * 60 * 1000)) continue;
    const state = await latestWorkflowState(row.github_repository, token);
    if (state === 'active' || state === 'unknown') continue;

    const now = new Date().toISOString();
    const claimed = await env.DB.prepare(`UPDATE agent_projects
      SET phase='failed',last_error=?,updated_at=?
      WHERE project_id=? AND phase='agent_running' AND updated_at=?`)
      .bind(`Self-heal detected stale agent_running state with GitHub workflow state: ${state}. Dispatching a fresh procedural build from current main.`, now, row.id, row.updated_at).run();
    if (!claimed.meta?.changes) continue;
    await env.DB.prepare("UPDATE projects SET status='failed',updated_at=? WHERE id=?").bind(now, row.id).run();
    try {
      await env.DB.prepare('INSERT INTO build_events(id,project_id,kind,detail,stage,created_at) VALUES(?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), row.id, 'stale_agent_run_detected', `No active GitHub engineering workflow remained (${state}); Vela automatically dispatched a fresh procedural build.`, 'failed', now).run();
    } catch {}

    const headers = new Headers();
    const cookie = request.headers.get('cookie');
    if (cookie) headers.set('cookie', cookie);
    headers.set('content-type', 'application/json');
    const restart = new Request(`${url.origin}/projects/${row.id}/build`, { method: 'POST', headers, body: '{}' });
    const response = await downstream.fetch(restart, env as never, ctx);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1500);
      await env.DB.prepare('UPDATE agent_projects SET last_error=?,updated_at=? WHERE project_id=?')
        .bind(`Automatic restart dispatch failed: ${detail}`, new Date().toISOString(), row.id).run();
    }
  }
}

async function touchAgentHeartbeat(request: Request, response: Response, env: RuntimeEnv): Promise<void> {
  if (!response.ok || !env.DB || request.method !== 'POST' || new URL(request.url).pathname !== '/internal/agent/event') return;
  try {
    const body = await request.clone().json() as { project_id?: string };
    if (body.project_id) await env.DB.prepare('UPDATE agent_projects SET updated_at=? WHERE project_id=? AND phase=?')
      .bind(new Date().toISOString(), body.project_id, 'agent_running').run();
  } catch {}
}

function autoRefreshScript(): string {
  return String.raw`<script>(function(){if(typeof loadWorkspace==='function'){setInterval(function(){loadWorkspace().catch(function(){})},15000)}})();</script>`;
}

async function patchRoot(response: Response): Promise<Response> {
  if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) return response;
  const html = (await response.text()).replace('</body>', `${autoRefreshScript()}</body>`);
  const headers = new Headers(response.headers); headers.delete('content-length');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const module = await entry;
    await selfHealStaleRuns(request, env, module.default as never, ctx);
    const eventCopy = request.clone();
    let response = await module.default.fetch(request, env as never, ctx);
    await touchAgentHeartbeat(eventCopy, response, env);
    if (request.method === 'GET' && new URL(request.url).pathname === '/') response = await patchRoot(response);
    return response;
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
