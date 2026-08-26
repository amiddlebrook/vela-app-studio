import { DurableObject } from 'cloudflare:workers';

export interface Env {
  DB: D1Database;
  BUILDS: DurableObjectNamespace<BuildCoordinator>;
  BUILD_JOBS: Queue<{ projectId: string; prompt: string }>;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CLOUDFLARE_CLIENT_ID?: string;
  CLOUDFLARE_CLIENT_SECRET?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  GITHUB_CLIENT_ID?: string;
  OPENROUTER_API_KEY?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: CryptoKey;
}

type Provider = 'google' | 'github' | 'cloudflare';
type OAuthState = { provider: Provider; session_id: string; code_verifier_ciphertext: string; redirect_uri: string; expires_at: string };
type ProviderToken = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
type ProviderIdentity = { id: string; email?: string; name?: string };
type ProjectRecord = { id: string; owner_id: string; name: string; prompt: string; github_repository: string | null; worker_name: string | null };
type ConnectionToken = { accessToken: string; externalAccountId: string | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = 'vela_session';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export class BuildCoordinator extends DurableObject<Env> {
  async plan(id: string, prompt: string): Promise<{ id: string; status: 'planned' }> {
    await this.ctx.storage.put('build', { status: 'planned', prompt, updatedAt: new Date().toISOString() });
    return { id, status: 'planned' };
  }
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
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(base64UrlBytes(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function issueSession(secret: string): Promise<{ id: string; cookie: string }> {
  return issueSessionForId(randomToken(), secret);
}

async function issueSessionForId(id: string, secret: string): Promise<{ id: string; cookie: string }> {
  const signature = await hmac(id, secret);
  return { id, cookie: `${SESSION_COOKIE}=${id}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` };
}

async function readSession(request: Request, secret: string): Promise<string | null> {
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!value) return null;
  const [id, signature] = value.split('.');
  return id && signature && (await hmac(id, secret)) === signature ? id : null;
}

async function encrypt(value: unknown, key: CryptoKey): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, encoder.encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decrypt(value: string, key: CryptoKey): Promise<string> {
  const [iv, ciphertext] = value.split('.');
  if (!iv || !ciphertext) throw new Error('Invalid encrypted value');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(base64UrlBytes(iv)) }, key, toArrayBuffer(base64UrlBytes(ciphertext)));
  return decoder.decode(plaintext);
}

function safeSlug(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 42);
  return slug || fallback;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown build error';
}

// --- Multi-LLM Code Generation ---

async function callOpenRouter(messages: Array<{role: string; content: string}>, model?: string): Promise<string> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OpenRouter API key not configured');
  const targetModel = model || 'anthropic/claude-3.5-sonnet';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: targetModel,
      messages,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices[0]?.message?.content ?? '';
}

type ScaffoldResult = {
  frontend: string;
  backend: string;
  database: string;
  config: string;
  instructions: string;
};

type PlanResult = {
  name: string;
  description: string;
  features: string[];
  techStack: string[];
  estimatedSteps: string[];
  security: {
    rbac: boolean;
    auditLog: boolean;
    fieldLevelSecurity: boolean;
    dataSegmentation: boolean;
  };
};

function buildPlanSystemPrompt(prompt: string): string {
  return `You are Vela, a world-class enterprise full-stack architect. Your mission: generate a complete, production-ready MVP plan from a single natural language prompt. ZERO clarifying questions - the user has already provided their idea, deliver the plan immediately.

Output EXACTLY this JSON format and nothing else:

{
  "name": "App Name",
  "description": "1-2 sentence description of what the app does and who it's for,
  "features": ["feature 1", "feature 2", "feature 3", ...],
  "techStack": ["Cloudflare Workers", "D1 Database", ...],
  "estimatedSteps": ["Step 1 description", "Step 2 description", ...],
  "security": {
    "rbac": true,
    "auditLog": true,
    "fieldLevelSecurity": true,
    "dataSegmentation": true
  }
}

CRITICAL INSTRUCTIONS:
- Output ONLY the JSON object above - no markdown, no explanation, no conversational text
- Features: 4-8 concrete, buildable MVP features for Cloudflare Workers + D1
- TechStack: ALWAYS include "Cloudflare Workers" and "D1 Database". Add others as appropriate (React, Stripe, etc.)
- EstimatedSteps: 3-6 clear build steps the system will follow
- Security: ALWAYS set all four security flags to true (rbac, auditLog, fieldLevelSecurity, dataSegmentation) - enterprise plans MUST have these enabled
- Do NOT ask clarifying questions, do NOT request more input, do NOT output anything besides the JSON
- The user's prompt is: ${prompt}

Rules:
- Features must be specific, buildable Cloudflare Workers + D1 features
- At least 2 features must involve D1 database interactions
- At least 1 feature must involve API route handlers
- Security flags must ALL be true - this is non-negotiable for enterprise plans
- Output ONLY the JSON object enclosed in curly braces - nothing before or after`;
}

async function planAppWithLLM(prompt: string, model?: string): Promise<PlanResult> {
  const systemPrompt = buildPlanSystemPrompt(prompt);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Plan this app: ' + prompt },
  ];

  let content: string;
  if (env.OPENROUTER_API_KEY) {
    content = await callOpenRouter(messages, model);
  } else {
    throw new Error('No LLM provider configured');
  }

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = content.match(/^\s*\{[\s\S]*\}\s*$/m);
  if (!jsonMatch) throw new Error('LLM did not return valid JSON plan');

  const parsed = JSON.parse(jsonMatch[0]) as PlanResult;

  // Enforce enterprise security requirements
  if (parsed.security == null || parsed.security.rbac === undefined) parsed.security.rbac = true;
  if (parsed.security == null || parsed.security.auditLog === undefined) parsed.security.auditLog = true;
  if (parsed.security == null || parsed.security.fieldLevelSecurity === undefined) parsed.security.fieldLevelSecurity = true;
  if (parsed.security == null || parsed.security.dataSegmentation === undefined) parsed.security.dataSegmentation = true;

  // Ensure Cloudflare + D1 are in tech stack
  if (!parsed.techStack?.includes('Cloudflare Workers')) parsed.techStack.push('Cloudflare Workers');
  if (!parsed.techStack?.includes('D1 Database')) parsed.techStack.push('D1 Database');

  return parsed;
}

async function scaffoldAppWithLLM(prompt: string, model?: string): Promise<ScaffoldResult> {
  const systemPrompt = `You are Vela, an agentic full-stack app builder. Given a natural language prompt, generate a complete, production-ready full-stack application.

Generate code in these formats:
- FRONTEND: React/Next.js page component with Tailwind CSS. Include all necessary imports, state management, and a responsive UI.
- BACKEND: Cloudflare Workers API route handlers (app.mjs format). Include request validation, error handling, and D1 database interactions where applicable.
- DATABASE: D1 SQL schema (CREATE TABLE statements) with migrations. Design tables based on the app's needs.
- CONFIG: wrangler.jsonc configuration with D1 bindings, Queue, and DO namespace. Set compatibility_date to "2026-08-25".
- INSTRUCTIONS: A concise guide for the user on how to use the app, what features are included, and any deployment notes.

CRITICAL: Output ONLY the code blocks and configuration. Do not include explanatory text, markdown formatting outside of code blocks, or conversational messages. Each section must be clearly labeled with a header line like "FRONTEND:", "BACKEND:", "DATABASE:", "CONFIG:", "INSTRUCTIONS:". The generated code must be immediately usable - no placeholders, no "TODO" comments, complete functional code.

User prompt: ${prompt}
`
  const userPrompt = `Generate a complete full-stack application. Be thorough and production-ready.`;

  const messages = [
    {role: 'system', content: systemPrompt},
    {role: 'user', content: userPrompt},
  ];

  let content: string;
  if (env.OPENROUTER_API_KEY) {
    try {
      content = await callOpenRouter(messages, model);
    } catch (e) {
      console.warn('OpenRouter failed:', e.message);
      throw e;
    }
  } else {
    throw new Error('No LLM provider configured. Set OPENROUTER_API_KEY environment variable.');
  }

  // Parse the labeled sections
  const result: ScaffoldResult = {
    frontend: '',
    backend: '',
    database: '',
    config: '',
    instructions: '',
  };

  const sections = content.split(/\n(?=^(FRONTEND|BACKEND|DATABASE|CONFIG|INSTRUCTIONS):)/m);
  for (const section of sections) {
    const match = section.match(/^(FRONTEND|BACKEND|DATABASE|CONFIG|INSTRUCTIONS):\s*(.*)$/m);
    if (match) {
      const key = match[1] as keyof ScaffoldResult;
      result[key] = match[2].trim();
    }
  }

  // Validate we have at least frontend + backend
  if (!result.frontend || !result.backend) {
    throw new Error('LLM response missing required sections (frontend/backend)');
  }

  return result;
}

async function connectedToken(env: Env, ownerId: string, provider: Exclude<Provider, 'google'>): Promise<ConnectionToken> {
  const connection = await env.DB.prepare('SELECT access_token_ciphertext, refresh_token_ciphertext, external_account_id, token_expires_at FROM connections WHERE owner_id = ? AND provider = ? AND status = ?')
    .bind(ownerId, provider, 'connected')
    .first<{ access_token_ciphertext: string | null; refresh_token_ciphertext: string | null; external_account_id: string | null; token_expires_at: string | null }>();
  if (!connection?.access_token_ciphertext) throw new Error(`${provider} connection is missing or expired`);
  if (connection.token_expires_at && Date.parse(connection.token_expires_at) <= Date.now() + 60_000) {
    if (provider === 'cloudflare' && connection.refresh_token_ciphertext) {
      return refreshCloudflareToken(env, ownerId, connection);
    }
    throw new Error(`${provider} connection has expired. Reconnect ${provider} to continue.`);
  }
  return {
    accessToken: JSON.parse(await decrypt(connection.access_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string,
    externalAccountId: connection.external_account_id,
  };
}

async function refreshCloudflareToken(env: Env, ownerId: string, connection: { refresh_token_ciphertext: string; external_account_id: string | null }): Promise<ConnectionToken> {
  if (!env.CLOUDFLARE_CLIENT_ID) throw new Error('cloudflare OAuth is not configured');
  const refreshToken = JSON.parse(await decrypt(connection.refresh_token_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string;
  const form = new URLSearchParams({ client_id: env.CLOUDFLARE_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken });
  if (env.CLOUDFLARE_CLIENT_SECRET) form.set('client_secret', env.CLOUDFLARE_CLIENT_SECRET);
  const response = await fetch('https://dash.cloudflare.com/oauth2/token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const token = await response.json<ProviderToken>();
  if (!response.ok || !token.access_token) throw new Error(token.error_description ?? token.error ?? 'Cloudflare token refresh failed. Reconnect Cloudflare to continue.');
  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
  await env.DB.prepare('UPDATE connections SET access_token_ciphertext = ?, refresh_token_ciphertext = ?, token_expires_at = ?, updated_at = ? WHERE owner_id = ? AND provider = ?')
    .bind(await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY), token.refresh_token ? await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY) : connection.refresh_token_ciphertext, expiresAt, new Date().toISOString(), ownerId, 'cloudflare')
    .run();
  return { accessToken: token.access_token, externalAccountId: connection.external_account_id };
}

async function githubRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'Vela-Control-Plane',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    payload = body;
  }
  if (!response.ok) {
    const detail = typeof payload === 'object' && payload && 'message' in payload
      ? String(payload.message)
      : String(payload).slice(0, 300);
    throw new Error(`GitHub request failed (${response.status}): ${detail}`);
  }
  if (typeof payload !== 'object' || !payload) throw new Error('GitHub returned an unexpected response');
  return payload as T;
}

async function putGithubFile(token: string, repository: string, path: string, content: string, message: string): Promise<void> {
  await githubRequest(token, `/repos/${repository}/contents/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, content: base64(encoder.encode(content)) }),
  });
}

function standaloneWorkerSource(name: string, prompt: string): string {
  return `const appName = ${JSON.stringify(name)};
const appPrompt = ${JSON.stringify(prompt)};
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[character]));
export default {
  async fetch() {
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(appName) + '</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a13;color:#f4f5ff;font:16px system-ui}main{max-width:680px;padding:48px}h1{font-size:clamp(40px,8vw,84px);line-height:.9;margin:0 0 24px}p{color:#b7c1e8;line-height:1.65}</style><main><h1>' + escapeHtml(appName) + '</h1><p>' + escapeHtml(appPrompt) + '</p><p><small>Deployed by Vela Control Plane</small></p></main></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
};
`;
}

async function deployStandaloneWorker(token: string, accountId: string, workerName: string, source: string): Promise<void> {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-08-25' }));
  form.set('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 350);
    throw new Error(`Cloudflare Worker deployment failed (${response.status}): ${detail || 'No additional detail returned'}`);
  }
  // Enable workers.dev subdomain so the script is actually served
  const subdomainResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: true, previews_enabled: true }),
    }
  );
  if (!subdomainResponse.ok) {
    const detail = (await subdomainResponse.text()).replace(/\s+/g, ' ').slice(0, 350);
    throw new Error(`Cloudflare subdomain enable failed (${subdomainResponse.status}): ${detail || 'No additional detail returned'}`);
  }
}

function securityHeaders(headers = new Headers()): Headers {
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  return headers;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, { ...init, headers: securityHeaders(new Headers(init.headers)) });
}

function providerFromPath(pathname: string, suffix: 'start' | 'callback'): Provider | null {
  const provider = pathname.match(new RegExp(`^/auth/(google|github|cloudflare)/${suffix}$`))?.[1];
  return provider === 'google' || provider === 'github' || provider === 'cloudflare' ? provider : null;
}

function callbackUrl(env: Env, provider: Provider): string {
  return `${new URL(env.APP_ORIGIN).origin}/auth/${provider}/callback`;
}

function configuredClientId(env: Env, provider: Provider): string | undefined {
  if (provider === 'google') return env.GOOGLE_CLIENT_ID;
  return provider === 'github' ? env.GITHUB_CLIENT_ID : env.CLOUDFLARE_CLIENT_ID;
}

async function exchangeToken(provider: Provider, code: string, verifier: string, redirectUri: string, env: Env): Promise<ProviderToken> {
  const clientId = configuredClientId(env, provider);
  if (!clientId) throw new Error(`${provider} OAuth is not configured`);
  const form = new URLSearchParams({ client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
  if (provider === 'google') {
    if (!env.GOOGLE_CLIENT_SECRET) throw new Error('google OAuth is not configured');
    form.set('client_secret', env.GOOGLE_CLIENT_SECRET);
    form.set('grant_type', 'authorization_code');
  }
  if (provider === 'github') {
    if (!env.GITHUB_CLIENT_SECRET) throw new Error('github OAuth is not configured');
    form.set('client_secret', env.GITHUB_CLIENT_SECRET);
  }
  if (provider === 'cloudflare') {
    form.set('grant_type', 'authorization_code');
    if (env.CLOUDFLARE_CLIENT_SECRET) form.set('client_secret', env.CLOUDFLARE_CLIENT_SECRET);
  }
  const endpoint = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : provider === 'github'
      ? 'https://github.com/login/oauth/access_token'
      : 'https://dash.cloudflare.com/oauth2/token';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const token = await response.json<ProviderToken>();
  if (!response.ok || !token.access_token) throw new Error(token.error_description ?? token.error ?? 'OAuth token exchange failed');
  return token;
}

async function providerIdentity(provider: Provider, accessToken: string): Promise<ProviderIdentity> {
  const endpoint = provider === 'google'
    ? 'https://openidconnect.googleapis.com/v1/userinfo'
    : provider === 'github'
      ? 'https://api.github.com/user'
      : 'https://dash.cloudflare.com/oauth2/userinfo';
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
  if (provider === 'github') {
    headers['user-agent'] = 'Vela-Control-Plane';
    headers['x-github-api-version'] = '2022-11-28';
  }
  const response = await fetch(endpoint, { headers });
  if (!response.ok) throw new Error('Could not verify provider account');
  const identity = await response.json<{ id?: number | string; sub?: string; email?: string; name?: string; login?: string }>();
  const id = identity.id ?? identity.sub;
  if (!id) throw new Error('Provider did not return an account identifier');
  return { id: String(id), email: identity.email, name: identity.name ?? identity.login };
}

function successPage(provider: Provider, cookie?: string): Response {
  const label = provider === 'google' ? 'Google' : provider === 'github' ? 'GitHub' : 'Cloudflare';
  const headers = securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' }));
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Connection complete</title></head><body><main><h1>${label} connected</h1><p>You can return to the app and continue.</p></main></body></html>`, {
    headers,
  });
}

function dashboardPage(): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vela Control Plane</title><style>body{margin:0;background:#090b13;color:#edf0ff;font:16px system-ui,sans-serif}main{max-width:900px;margin:auto;padding:64px 24px}.eyebrow{color:#83a6ff;letter-spacing:.14em;text-transform:uppercase;font-size:12px}h1{font-size:clamp(42px,8vw,86px);line-height:.9;margin:16px 0 26px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.card{border:1px solid #293252;border-radius:20px;padding:24px;background:linear-gradient(135deg,#12182b,#0c0e18)}button{background:#b8c7ff;border:0;border-radius:999px;padding:12px 18px;font-weight:700;cursor:pointer}button.alt{background:#1e2742;color:#edf0ff}textarea,input{box-sizing:border-box;width:100%;background:#090b13;border:1px solid #394567;color:#fff;border-radius:12px;padding:12px;margin:8px 0}small{color:#aeb9d9}.status{min-height:20px;color:#9ee7c6}</style></head><body><main><p class="eyebrow">Cloudflare control plane</p><h1>Build. Ship.<br>Control.</h1><p>This Worker is live. Connect the two accounts below, then create an isolated project from a prompt.</p><section class="grid"><article class="card"><h2>GitHub</h2><p id="github">Checking connection…</p><button onclick="location.href='/auth/github/start'">Connect GitHub</button></article><article class="card"><h2>Cloudflare</h2><p id="cloudflare">Checking connection…</p><button class="alt" onclick="location.href='/auth/cloudflare/start'">Connect Cloudflare</button></article></section><section class="card" style="margin-top:16px"><h2>New project</h2><input id="name" placeholder="Project name"><textarea id="prompt" rows="5" placeholder="Describe what you want to build…"></textarea><button onclick="createProject()">Create project</button><p class="status" id="status"></p><small>Project creation is intentionally locked until both accounts are connected.</small></section></main><script>async function refresh(){let r=await fetch('/connections');if(!r.ok){document.querySelectorAll('#github,#cloudflare').forEach(x=>x.textContent='Not connected');return}let d=await r.json(),p=new Set(d.connections.map(x=>x.provider));document.querySelector('#github').textContent=p.has('github')?'Connected':'Not connected';document.querySelector('#cloudflare').textContent=p.has('cloudflare')?'Connected':'Not connected'}async function createProject(){let s=document.querySelector('#status'),r=await fetch('/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.querySelector('#name').value,prompt:document.querySelector('#prompt').value})}),d=await r.json();s.textContent=r.ok?'Project planned: '+d.id:d.error}refresh()</script></body></html>`;
  return new Response(body, { headers: securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })) });
}

function dashboardV2(): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vela Control Plane</title><style>:root{color-scheme:dark;--ink:#ebedff;--muted:#9da6c8;--line:#262d4b;--card:#11172a;--blue:#91adff;--mint:#92e8c4;--bg:#070914}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -20%,#25356d55,transparent 42%),var(--bg);color:var(--ink);font:15px ui-sans-serif,system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:38px 22px 80px}.eyebrow{font-size:11px;color:var(--blue);letter-spacing:.16em;text-transform:uppercase}header{display:flex;justify-content:space-between;gap:22px;align-items:end;border-bottom:1px solid var(--line);padding-bottom:28px}h1{font-size:clamp(40px,6vw,74px);line-height:.9;margin:12px 0 0}.pill{border:1px solid #405184;border-radius:999px;padding:8px 12px;color:var(--mint);white-space:nowrap}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;margin-top:18px}.card{background:linear-gradient(145deg,#141b31,#0d1020);border:1px solid var(--line);border-radius:20px;padding:22px}.wide{grid-column:1/-1}h2{font-size:18px;margin:0 0 14px}.connect{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-top:1px solid var(--line)}.connect:first-of-type{border-top:0}.state{color:var(--muted)}button{border:0;border-radius:999px;background:var(--blue);color:#0a1025;padding:10px 14px;font-weight:750;cursor:pointer}button.secondary{background:#212a49;color:var(--ink)}button.tiny{padding:6px 10px;font-size:12px}input,textarea{width:100%;color:var(--ink);background:#090c18;border:1px solid #303a5e;border-radius:12px;padding:12px;margin-bottom:9px;font:inherit}textarea{resize:vertical}.project{border-top:1px solid var(--line);padding:16px 0}.project:first-child{border-top:0;padding-top:0}.row{display:flex;gap:10px;justify-content:space-between;align-items:center}.name{font-weight:750}.meta,small{color:var(--muted);font-size:12px}.tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.tag{border:1px solid #3d4971;border-radius:999px;color:#bdc8ef;background:#171d34;padding:5px 8px;font-size:11px}.tag.off{opacity:.4;text-decoration:line-through}.empty{color:var(--muted);padding:14px 0}.status{min-height:20px;color:var(--mint);margin:4px 0 0}@media(max-width:760px){header{align-items:start;flex-direction:column}.grid{grid-template-columns:1fr}}</style></head><body><main><header><div><div class="eyebrow">Cloudflare-native control plane</div><h1>Build. Ship.<br>Control.</h1></div><div class="pill" id="session">Preparing workspace</div></header><section class="grid"><article class="card"><h2>Create a standalone app</h2><input id="name" maxlength="80" placeholder="Project name"><textarea id="prompt" rows="5" maxlength="4000" placeholder="Describe the app, audience, and outcome…"></textarea><button onclick="createProject()">Create project</button><p class="status" id="status"></p><small>You can test planning, portfolio, features, and usage before connections are configured.</small></article><article class="card"><h2>Connections</h2><div class="connect"><div><strong>GitHub</strong><div class="state" id="github">Checking…</div></div><button class="secondary tiny" onclick="location.href='/auth/github/start'">Connect</button></div><div class="connect"><div><strong>Cloudflare</strong><div class="state" id="cloudflare">Checking…</div></div><button class="secondary tiny" onclick="location.href='/auth/cloudflare/start'">Connect</button></div></article><article class="card wide"><div class="row"><h2>Your portfolio</h2><span class="meta" id="usage">$0 tracked</span></div><div id="projects" class="empty">Loading projects…</div></article></section></main><script>let projects=[];const $=s=>document.querySelector(s);const esc=s=>String(s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));async function api(path,options){let r=await fetch(path,options),d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}async function boot(){try{await api('/session',{method:'POST'})}catch(e){$('#status').textContent=e.message}await refresh()}async function refresh(){try{let [c,p,u]=await Promise.all([api('/connections'),api('/projects'),api('/usage')]);let connected=new Set(c.connections.map(x=>x.provider));$('#github').textContent=connected.has('github')?'Connected':'Not connected';$('#cloudflare').textContent=connected.has('cloudflare')?'Connected':'Not connected';$('#session').textContent='Workspace ready';projects=p.projects;$('#usage').textContent='$'+(u.estimated_cost_cents/100).toFixed(2)+' tracked';render()}catch(e){$('#status').textContent=e.message}}function render(){let root=$('#projects');if(!projects.length){root.className='empty';root.textContent='No projects yet. Create one from a prompt.';return}root.className='';root.innerHTML=projects.map(p=>'<article class="project"><div class="row"><div><div class="name">'+esc(p.name)+'</div><div class="meta">'+esc(p.status)+' · '+new Date(p.updated_at).toLocaleString()+'</div></div><button class="secondary tiny" onclick="build(\''+p.id+'\')">Run build</button></div><div class="tags">'+p.features.map(f=>'<button class="tag '+(f.enabled?'':'off')+'" onclick="toggle(\''+p.id+'\',\''+f.feature+'\','+(f.enabled?0:1)+')">'+esc(f.feature)+'</button>').join('')+'</div></article>').join('')}async function createProject(){let status=$('#status');status.textContent='Creating…';try{let d=await api('/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('#name').value,prompt:$('#prompt').value})});status.textContent='Created: '+d.project.name;$('#name').value='';$('#prompt').value='';await refresh()}catch(e){status.textContent=e.message}}async function toggle(id,feature,enabled){try{await api('/projects/'+id+'/features/'+encodeURIComponent(feature),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:!!enabled})});await refresh()}catch(e){$('#status').textContent=e.message}}async function build(id){try{let d=await api('/projects/'+id+'/build',{method:'POST'});$('#status').textContent=d.status==='needs_connections'?'Connect GitHub and Cloudflare to run this build.':'Build queued.';await refresh()}catch(e){$('#status').textContent=e.message}}boot()</script></body></html>`;
  return new Response(body, { headers: securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })) });
}

function dashboardV3(): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vela Control Plane</title><style>body{margin:0;background:#080a13;color:#f1f3ff;font:15px system-ui,sans-serif}main{max-width:1050px;margin:auto;padding:48px 22px}.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8da9ff}h1{font-size:clamp(44px,7vw,78px);line-height:.88;margin:13px 0 35px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{border:1px solid #2d3658;border-radius:20px;background:linear-gradient(145deg,#151b31,#0d101d);padding:20px}.wide{grid-column:1/-1}h2{margin:0 0 9px;font-size:18px}.muted{color:#9da8cc}.state{color:#9ee6c5;min-height:20px}button{border:0;border-radius:999px;background:#b7c8ff;color:#091126;padding:10px 14px;font-weight:750;cursor:pointer}button.alt{background:#232c4b;color:#f1f3ff}input,textarea{width:100%;box-sizing:border-box;border:1px solid #374363;border-radius:12px;background:#090c16;color:#f1f3ff;padding:12px;margin:6px 0;font:inherit}.project{border-top:1px solid #2d3658;padding:13px 0}.project:first-child{border-top:0}.tag{display:inline-block;border:1px solid #42507b;border-radius:99px;padding:4px 8px;margin:8px 6px 0 0;font-size:11px}.off{opacity:.4;text-decoration:line-through}.status{color:#9ee6c5;min-height:20px}@media(max-width:750px){.grid{grid-template-columns:1fr}}</style></head><body><main><div class="eyebrow">Your app operating system</div><h1>Build. Ship.<br>Control.</h1><section class="grid"><article class="card"><h2>Google</h2><p class="muted">Sign in and keep your portfolio attached to you.</p><p class="state" id="google">Checking…</p><button onclick="location.href='/auth/google/start'">Sign in with Google</button></article><article class="card"><h2>GitHub</h2><p class="muted">Create a separate private repository for every app.</p><p class="state" id="github">Checking…</p><button class="alt" onclick="location.href='/auth/github/start'">Connect GitHub</button></article><article class="card"><h2>Cloudflare</h2><p class="muted">Deploy and manage the generated app infrastructure.</p><p class="state" id="cloudflare">Checking…</p><button class="alt" onclick="location.href='/auth/cloudflare/start'">Connect Cloudflare</button></article><article class="card wide"><h2>Create a standalone app</h2><input id="name" placeholder="Project name"><textarea id="prompt" rows="5" placeholder="Describe what you want to create…"></textarea><button onclick="createProject()">Create project</button><p class="status" id="status"></p></article><article class="card wide"><h2>Portfolio</h2><div id="projects" class="muted">Loading…</div></article></section></main><script>const q=s=>document.querySelector(s);const esc=v=>String(v).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));async function api(p,o){let r=await fetch(p,o),d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}async function refresh(){try{await api('/session',{method:'POST'});let[c,p]=await Promise.all([api('/connections'),api('/projects')]);let s=new Set(c.connections.map(x=>x.provider));['google','github','cloudflare'].forEach(x=>q('#'+x).textContent=s.has(x)?'Connected':'Not connected');q('#projects').innerHTML=p.projects.length?p.projects.map(x=>'<div class="project"><b>'+esc(x.name)+'</b> <span class="muted">'+esc(x.status)+'</span><div>'+x.features.map(f=>'<span class="tag '+(f.enabled?'':'off')+'">'+esc(f.feature)+'</span>').join('')+'</div></div>').join(''):'No projects yet.'}catch(e){q('#status').textContent=e.message}}async function createProject(){try{let d=await api('/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:q('#name').value,prompt:q('#prompt').value})});q('#status').textContent='Created '+d.project.name;refresh()}catch(e){q('#status').textContent=e.message}}refresh()</script></body></html>`;
  return new Response(body, { headers: securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })) });
}

function builderDashboard(): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vela Control Plane</title>
<style>
:root{--bg:#070a12;--card:#0f1322;--line:#252d4a;--ink:#eef1ff;--muted:#8892b8;--blue:#8ba4ff;--mint:#6ee8b0;--amber:#ffc46a;--red:#ff6b6b}
*{box-sizing:border-box;margin:0}
body{background:radial-gradient(ellipse at 85% -15%,#1e2e6222,transparent 55%),radial-gradient(ellipse at -10% 20%,#35255c22,transparent 55%),var(--bg);color:var(--ink);font:15px ui-sans-serif,system-ui,sans-serif;min-height:100vh}
main{max-width:1120px;margin:auto;padding:36px 22px 90px}
.top{display:flex;justify-content:space-between;align-items:start;gap:20px}
.eyebrow{font-size:10px;color:var(--blue);letter-spacing:.2em;text-transform:uppercase;margin-bottom:6px}
h1{font-size:clamp(42px,7vw,76px);letter-spacing:-.06em;line-height:.88;margin:10px 0 0}
.desc{color:var(--muted);max-width:480px;line-height:1.5;margin-top:6px}
.signal-box{min-width:190px;border:1px solid #37426a;border-radius:16px;padding:13px 16px;background:#0d121fcc;flex-shrink:0}
.pulse-dot{width:8px;height:8px;background:var(--mint);box-shadow:0 0 14px var(--mint);border-radius:50%;display:inline-block;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.signal-box b{display:block;font-size:18px;margin:5px 0 2px}
.signal-box .sub{color:var(--muted);font-size:11px}
.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:16px;margin-top:26px}
.card{background:linear-gradient(150deg,#13182bee,#0b0d16ee);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 0 40px rgba(139,164,255,.06)}
.wide{grid-column:1/-1}
h2{font-size:17px;margin:0 0 14px;font-weight:750}
input,textarea{width:100%;border:1px solid #333c5f;border-radius:13px;background:#080b15;color:var(--ink);font:inherit;padding:12px 14px;margin:0 0 10px;outline:none;transition:border .2s}
input:focus,textarea:focus{border-color:var(--blue)}
textarea{resize:vertical;min-height:110px}
button{border:0;border-radius:999px;background:var(--blue);color:#090e22;padding:11px 18px;font-weight:800;cursor:pointer;transition:all .18s}
button:hover{filter:brightness(1.1);transform:translateY(-1px)}
button.secondary{background:#1c2440;color:var(--ink)}
button:disabled{opacity:.45;cursor:default;transform:none}
button.green{background:var(--mint);color:#061510}
button.red{background:var(--red);color:#1a0505}
.hint{color:var(--muted);font-size:12px;line-height:1.5;margin-top:8px}
.connections{display:grid;gap:8px}
.connection{display:flex;align-items:center;justify-content:space-between;border:1px solid #2a3252;border-radius:14px;padding:13px 16px;background:#0b0f1a}
.connection strong{font-size:14px}
.state{font-size:12px;margin-top:2px}
.state.ok{color:var(--mint)}
.state.wait{color:var(--amber)}
.project{border-bottom:1px solid var(--line);padding:18px 0}
.project:last-child{border-bottom:0}
.proj-header{display:flex;justify-content:space-between;align-items:start;gap:12px}
.proj-header h3{font-size:16px;margin:0}
.badge{font-size:11px;padding:5px 10px;border-radius:99px;white-space:nowrap;font-weight:700;border:1px solid transparent}
.badge.live{color:var(--mint);border-color:#1a3d2a;background:#0a1a14}
.badge.failed{color:var(--red);border-color:#3d1a1a;background:#1a0a0a}
.badge.active{color:var(--amber);border-color:#3d321a;background:#1a150a;animation:shimmer 2s infinite}
.badge.pending{color:#b8a4ff;border-color:#2a1a3d;background:#120a1a}
@keyframes shimmer{0%,100%{border-color:#3d321a}50%{border-color:#5a4a2a}}
.meta{color:var(--muted);font-size:12px;margin-top:2px}
.steps{display:flex;gap:5px;margin:12px 0 10px;align-items:center}
.step{width:22px;height:4px;border-radius:3px;background:#1c2440;transition:background .3s}
.step.done{background:var(--mint)}
.step.now{background:var(--amber);animation:glow 1.2s infinite alternate}
@keyframes glow{from{box-shadow:0 0 4px var(--amber)}to{box-shadow:0 0 12px var(--amber)}}
.event{color:var(--muted);font-size:12px;line-height:1.6}
.event time{opacity:.5;margin-left:6px}
.links{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.links a{color:var(--blue);text-decoration:none;font-size:13px;border:1px solid #2a3558;border-radius:99px;padding:5px 12px;transition:all .15s}
.links a:hover{background:#1c2440}
.plan-card{border:1px solid #3a457a;border-radius:18px;background:linear-gradient(150deg,#161d38ee,#0e101eee);padding:22px;margin-top:16px;animation:slideIn .35s ease-out}
@keyframes slideIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.plan-title{font-size:20px;font-weight:800;margin-bottom:4px}
.plan-desc{color:var(--muted);line-height:1.55;margin-bottom:16px}
.plan-section{margin-bottom:14px}
.plan-section h4{font-size:11px;color:var(--blue);letter-spacing:.14em;text-transform:uppercase;margin-bottom:7px}
.plan-list{list-style:none;padding:0;margin:0}
.plan-list li{padding:5px 0;font-size:13px;color:var(--ink);display:flex;align-items:start;gap:8px}
.plan-list li::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--mint);margin-top:6px;flex-shrink:0}
.tag{display:inline-block;border:1px solid #333c5f;border-radius:99px;padding:3px 9px;font-size:11px;margin:3px 4px 3px 0;color:var(--muted)}
.plan-actions{display:flex;gap:10px;margin-top:18px}
.prompt-overlay{display:none;position:fixed;inset:0;background:#070a12dd;z-index:100;justify-content:center;align-items:center;backdrop-filter:blur(6px)}
.prompt-overlay.open{display:flex}
.prompt-box{background:#0f1322;border:1px solid var(--line);border-radius:22px;padding:28px;width:90%;max-width:540px;animation:slideIn .25s ease-out}
.prompt-box h2{margin-bottom:14px}
.typing{display:inline-flex;gap:4px;align-items:center;padding:6px 0}
.typing span{width:5px;height:5px;background:var(--blue);border-radius:50%;animation:typing 1.2s infinite}
.typing span:nth-child(2){animation-delay:.2s}
.typing span:nth-child(3){animation-delay:.4s}
@keyframes typing{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
@media(max-width:780px){.grid{grid-template-columns:1fr}.top{flex-direction:column}}
</style></head><body><main>
<header class="top"><div><div class="eyebrow">Vela / app creation control</div><h1>See every build<br>become real.</h1><p class="desc">Every project is a separate GitHub repo and Cloudflare Worker. Describe your app, review the AI plan, approve it, and watch it come to life.</p></div><aside class="signal-box"><span class="pulse-dot"></span><b id="activeCount">Checking…</b><span class="sub" id="signalText">Reading workspace</span></aside></header>
<section class="grid"><article class="card"><h2>Describe the app</h2><input id="name" maxlength="80" placeholder="App name (e.g. Habit Tracker)"><textarea id="prompt" maxlength="4000" placeholder="What should this app do, for whom, and what should it feel like?"></textarea><button id="create" onclick="createProject()">Create this app</button><p id="status" class="hint"></p><p class="hint">You'll review an AI-generated plan before any code is built.</p></article><article class="card"><h2>Launch access</h2><div class="connections"><div class="connection"><div><strong>GitHub</strong><div id="github" class="state">Checking…</div></div><button class="secondary" onclick="location.href='/auth/github/start'">Connect</button></div><div class="connection"><div><strong>Cloudflare</strong><div id="cloudflare" class="state">Checking…</div></div><button class="secondary" onclick="location.href='/auth/cloudflare/start'">Connect</button></div></div><p class="hint">GitHub holds each app's source repo. Cloudflare runs each app independently.</p></article><section class="card wide"><h2>Your build board</h2><div id="projects"><div class="empty">Loading build records…</div></div></section></section>
<div class="prompt-overlay" id="promptOverlay"><div class="prompt-box"><h2>Revise your prompt</h2><p class="hint" style="margin-bottom:12px;margin-top:0">Edit the prompt below to generate a new plan.</p><textarea id="editPrompt" rows="5" maxlength="4000"></textarea><input id="editProjectId" type="hidden"><div style="display:flex;gap:10px;margin-top:14px"><button onclick="submitReject()">Generate new plan</button><button class="secondary" onclick="closeOverlay()">Cancel</button></div></div></div>
<script>
const $=s=>document.querySelector(s);let projects=[],refreshTimer;
const stages=['planning','awaiting_approval','scaffolding','creating_repository','pushing_files','deploying_worker','enabling_subdomain','live'];
const labels={needs_connections:'Waiting for connections',planning:'Planning app structure',awaiting_approval:'Awaiting your approval',scaffolding:'AI generating code',creating_repository:'Creating GitHub repository',pushing_files:'Pushing source files',deploying_worker:'Deploying to Cloudflare',enabling_subdomain:'Enabling workers.dev',live:'Live',failed:'Build failed',building:'Building'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(p,o){const r=await fetch(p,o);const d=await r.json();if(!r.ok)throw Error(d.reason||d.error||'Request failed');return d}
function statusBadge(s){return s==='live'?'live':s==='failed'?'failed':s==='awaiting_approval'?'pending':'active'}
function render(){const active=projects.filter(p=>!['live','failed','needs_connections'].includes(p.status));$('#activeCount').textContent=active.length?active.length+' build'+(active.length===1?'':'s')+' active':'No active builds';$('#signalText').textContent=active.length?'Auto-refreshing every 2 s':'Build events stay attached to each project';const root=$('#projects');if(!projects.length){root.innerHTML='<div class="empty" style="padding:28px 0;color:var(--muted);text-align:center">No builds yet. Describe an app above and its creation timeline will appear here.</div>';return}root.innerHTML=projects.map(p=>{const step=stages.indexOf(p.status);const dots=stages.map((s,i)=>'<i class="step '+(i<step||(s==='live'&&p.status==='live')?'done':i===step&&p.status!=='live'&&p.status!=='failed'?'now':'')+'"></i>').join('');const ev=p.latest_event;const appLink=p.worker_name&&p.status==='live'?'<a target="_blank" rel="noreferrer" href="https://'+esc(p.worker_name)+'.workers.dev">Open app \u2197</a>':'';const repoLink=p.github_repository?'<a target="_blank" rel="noreferrer" href="https://github.com/'+esc(p.github_repository)+'">Repo \u2197</a>':'';const retryBtn=p.status==='failed'?'<button class="secondary" onclick="retryBuild(\&quot;'+p.id+'&\quot;)" style="font-size:12px;padding:6px 12px">Retry</button>':'';const modifyBtn=(p.status==='live'||p.status==='failed')?'<button class="secondary" onclick="openReject(\&quot;'+p.id+'&\quot;)" style="font-size:12px;padding:6px 12px">Modify</button>':'';const resumeBtn=p.status==='failed'?'<button class="secondary" onclick="resumeBuild(\&quot;'+p.id+'&\quot;)" style="font-size:12px;padding:6px 12px">Resume</button>':'';let planCard='';if(p.status==='awaiting_approval'&&p.plan_json){const plan=JSON.parse(p.plan_json);const featureList=(plan.features||[]).map(f=>'<li>'+esc(f)+'</li>').join('');const techTags=(plan.techStack||[]).map(t=>'<span class="tag">'+esc(t)+'</span>').join('');const stepList=(plan.estimatedSteps||[]).map(s=>'<li>'+esc(s)+'</li>').join('');planCard='<div class="plan-card"><div class="plan-title">'+esc(plan.name||p.name)+'</div><div class="plan-desc">'+esc(plan.description||p.prompt)+'</div><div class="plan-section"><h4>Features</h4><ul class="plan-list">'+featureList+'</ul></div><div class="plan-section"><h4>Tech Stack</h4>'+techTags+'</div><div class="plan-section"><h4>Build Steps</h4><ul class="plan-list">'+stepList+'</ul></div><div class="plan-actions"><button class="green" onclick="approvePlan(\&quot;'+p.id+'&\quot;)">\u2713 Approve &amp; build</button><button class="red" onclick="openReject(\&quot;'+p.id+'&\quot;)">\u2715 Reject</button></div></div>'}const typing=(p.status==='planning'||p.status==='building')?'<div class="typing"><span></span><span></span><span></span></div>':'';return '<article class="project"><div class="proj-header"><div><h3>'+esc(p.name)+'</h3><div class="meta">'+esc(labels[p.status]||p.status)+' \u00b7 '+new Date(p.updated_at).toLocaleTimeString()+'</div></div><span class="badge '+statusBadge(p.status)+'">'+esc(labels[p.status]||p.status)+'</span></div><div class="steps">'+dots+'</div>'+typing+planCard+(ev?'<div class="event">'+esc(ev.detail)+'<time>'+new Date(ev.created_at).toLocaleTimeString()+'</time></div>':'')+(appLink||repoLink?'<div class="links">'+repoLink+appLink+'</div>':'')+(retryBtn||modifyBtn||resumeBtn?'<div style="display:flex;gap:8px;margin-top:10px">'+retryBtn+modifyBtn+resumeBtn+'</div>':'')+'</article>'}).join('')}
async function refresh(){try{const[c,p]=await Promise.all([api('/connections'),api('/projects')]);const conns=new Map(c.connections.map(x=>[x.provider,x]));for(const provider of['github','cloudflare']){const node=$('#'+provider),conn=conns.get(provider);const expired=conn?.token_expires_at&&Date.parse(conn.token_expires_at)<=Date.now()+60000;const ok=!!conn&&!expired;node.textContent=ok?'Connected and ready':expired?'Reconnect required':'Not connected';node.className='state '+(ok?'ok':'wait')}projects=p.projects;render()}catch(e){$('#status').textContent=e.message}finally{clearTimeout(refreshTimer);const hasActive=projects.some(p=>!['live','failed','needs_connections'].includes(p.status));refreshTimer=setTimeout(refresh,hasActive?2000:10000)}}
async function createProject(){const status=$('#status'),btn=$('#create');status.textContent='Creating project\u2026';btn.disabled=true;try{const d=await api('/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('#name').value,prompt:$('#prompt').value})});status.textContent='Created '+d.project.name+'. Plan is being generated\u2026';$('#name').value='';$('#prompt').value='';await refresh()}catch(e){status.textContent=e.message}finally{btn.disabled=false}}
async function approvePlan(id){$('#status').textContent='Approving plan and starting build\u2026';try{await api('/projects/'+id+'/approve',{method:'POST'});$('#status').textContent='Build started!';await refresh()}catch(e){$('#status').textContent=e.message}}
function openReject(id){const p=projects.find(x=>x.id===id);if(!p)return;$('#editProjectId').value=id;$('#editPrompt').value=p.prompt;$('#promptOverlay').classList.add('open')}
function closeOverlay(){$('#promptOverlay').classList.remove('open')}
async function submitReject(){const id=$('#editProjectId').value;const prompt=$('#editPrompt').value.trim();if(!prompt)return;closeOverlay();$('#status').textContent='Submitting revised prompt\u2026';try{await api('/projects/'+id+'/reject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt})});$('#status').textContent='New plan being generated\u2026';await refresh()}catch(e){$('#status').textContent=e.message}}
async function retryBuild(id){$('#status').textContent='Re-queuing build\u2026';try{await api('/projects/'+id+'/build',{method:'POST'});$('#status').textContent='Build re-queued.';await refresh()}catch(e){$('#status').textContent=e.message}}
async function resumeBuild(id){$('#status').textContent='Resuming from last good stage\u2026';try{await api('/projects/'+id+'/build',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resumeFrom:'scaffolding'})});$('#status').textContent='Build resumed.';await refresh()}catch(e){$('#status').textContent=e.message}}
(async()=>{try{await api('/session',{method:'POST'})}catch(e){$('#status').textContent=e.message}refresh})();
</script></body></html>`;
  return new Response(body, { headers: securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })) });
}

async function connectionProviders(env: Env, ownerId: string): Promise<Set<string>> {
  const result = await env.DB.prepare('SELECT provider FROM connections WHERE owner_id = ? AND status = ? AND (token_expires_at IS NULL OR token_expires_at > ?)')
    .bind(ownerId, 'connected', new Date(Date.now() + 60_000).toISOString())
    .all<{ provider: string }>();
  return new Set(result.results.map((connection) => connection.provider));
}

async function completeGoogleLogin(env: Env, anonymousOwnerId: string, identity: ProviderIdentity): Promise<{ ownerId: string; cookie: string }> {
  const ownerId = `google:${identity.id}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(google_subject) DO UPDATE SET email = excluded.email, name = excluded.name, updated_at = excluded.updated_at').bind(ownerId, identity.id, identity.email ?? null, identity.name ?? null, now, now),
    env.DB.prepare('UPDATE projects SET owner_id = ? WHERE owner_id = ?').bind(ownerId, anonymousOwnerId),
    env.DB.prepare('UPDATE connections SET owner_id = ? WHERE owner_id = ?').bind(ownerId, anonymousOwnerId),
  ]);
  const session = await issueSessionForId(ownerId, env.SESSION_SECRET);
  return { ownerId, cookie: session.cookie };
}

async function projectForOwner(env: Env, id: string, ownerId: string) {
  return env.DB.prepare('SELECT id, name, prompt, status, created_at, updated_at FROM projects WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<{ id: string; name: string; prompt: string; status: string; created_at: string; updated_at: string }>();
}

async function recordEvent(env: Env, projectId: string, kind: string, detail: string, stage?: string): Promise<void> {
  await env.DB.prepare('INSERT INTO build_events (id, project_id, kind, detail, stage, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), projectId, kind, detail, stage, new Date().toISOString()).run();
}

const BUILD_STAGES = ['planning', 'awaiting_approval', 'scaffolding', 'creating_repository', 'pushing_files', 'deploying_worker', 'enabling_subdomain', 'live'] as const;

async function buildStandaloneApp(env: Env, projectId: string, resumeFrom?: string): Promise<void> {
  const project = await env.DB.prepare('SELECT id, owner_id, name, prompt, github_repository, worker_name FROM projects WHERE id = ?').bind(projectId).first<ProjectRecord>();
  if (!project) throw new Error('Project no longer exists');
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Cloudflare account is not configured on the control plane');

  const [github, cloudflare] = await Promise.all([
    connectedToken(env, project.owner_id, 'github'),
    connectedToken(env, project.owner_id, 'cloudflare'),
  ]);
  const suffix = project.id.replaceAll('-', '').slice(0, 8);
  const repositoryName = `${safeSlug(project.name, 'app')}-${suffix}`;
  const workerName = project.worker_name ?? `vela-${safeSlug(project.name, 'app')}-${suffix}`;
  const now = new Date().toISOString();
  const stageOf = (name: string) => BUILD_STAGES.indexOf(name as typeof BUILD_STAGES[number]);
  const shouldSkip = (name: string) => resumeFrom && stageOf(name) < stageOf(resumeFrom);

  // --- Stage 1: Planning + AI Scaffolding ---
  if (!shouldSkip('planning')) {
    await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('planning', new Date().toISOString(), projectId).run();
    await recordEvent(env, projectId, 'build_started', 'Planning app structure and generating full-stack code', 'planning');
  }

  let plan: PlanResult | null = null;
  let source: string;
  let scaffolding: {frontend: string; backend: string; database: string; config: string; instructions: string} = { frontend: '', backend: '', database: '', config: '', instructions: '' };

  // --- Stage 1: Planning → planAppWithLLM → awaiting_approval ---
  if (!shouldSkip('planning')) {
    await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('planning', new Date().toISOString(), projectId).run();
    await recordEvent(env, projectId, 'plan_started', 'Generating MVP plan with AI…', 'planning');
    try {
      plan = await planAppWithLLM(project.prompt, env.OPENROUTER_MODEL);
      await env.DB.prepare('UPDATE projects SET plan_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(plan), new Date().toISOString(), projectId).run();
      await recordEvent(env, projectId, 'plan_generated', `Plan ready: ${plan.features.length} features, ${plan.techStack.length} tech items`, 'planning');
      // PAUSE: await user approval before scaffolding
      await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('awaiting_approval', new Date().toISOString(), projectId).run();
      await recordEvent(env, projectId, 'awaiting_approval', 'Plan generated — waiting for user approval', 'awaiting_approval');
      return; // stop here; queue consumer will ack, build resumes on approve
    } catch (err) {
      console.warn('Plan generation failed, skipping approval:', (err as Error).message);
      await recordEvent(env, projectId, 'plan_failed', (err as Error).message, 'planning');
      // fall through to scaffolding without a plan
    }
  } else if (!shouldSkip('scaffolding')) {
    // resumed from scaffolding — load saved plan if any
    const existing = await env.DB.prepare('SELECT plan_json FROM projects WHERE id = ?').bind(projectId).first<{ plan_json: string | null }>();
    plan = existing?.plan_json ? JSON.parse(existing.plan_json) : null;
  }

  // --- Stage 2: Scaffolding (AI code generation) ---
  if (!shouldSkip('scaffolding')) {
    await recordEvent(env, projectId, 'scaffolding_started', 'AI agent generating frontend, backend, database schema, and config', 'scaffolding');
    try {
      scaffolding = await scaffoldAppWithLLM(project.prompt, env.OPENROUTER_MODEL);
      source = scaffolding.backend;
      await env.DB.prepare('UPDATE projects SET scaffolding_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(scaffolding), project.id).run();
      await recordEvent(env, projectId, 'scaffolding_complete', `Generated ${scaffolding.backend.length} chars backend, ${scaffolding.frontend.length} chars frontend, ${scaffolding.database.length} chars schema`, 'scaffolding');
    } catch (llmError) {
      console.warn('Agentic LLM scaffolding failed, falling back to standalone worker source:', llmError.message);
      scaffolding = { frontend: '', backend: standaloneWorkerSource(project.name, project.prompt), database: '', config: '', instructions: '' };
      source = scaffolding.backend;
      await env.DB.prepare('UPDATE projects SET scaffolding_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(scaffolding), project.id).run();
      await recordEvent(env, projectId, 'scaffolding_fallback', `LLM failed (${llmError.message.slice(0, 200)}), using standalone worker`, 'scaffolding');
    }
  } else {
    const existing = await env.DB.prepare('SELECT scaffolding_json FROM projects WHERE id = ?').bind(projectId).first<{ scaffolding_json: string | null }>();
    scaffolding = existing?.scaffolding_json ? JSON.parse(existing.scaffolding_json) : scaffolding;
    source = scaffolding.backend || standaloneWorkerSource(project.name, project.prompt);
  }

  if (!project.github_repository) {
    if (!shouldSkip('creating_repository')) {
      await env.DB.prepare('UPDATE projects SET status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind('creating_repository', workerName, new Date().toISOString(), project.id).run();
      await recordEvent(env, projectId, 'repository_started', `Creating private GitHub repository ${repositoryName}`, 'creating_repository');
      const repository = await githubRequest<{ full_name: string }>(github.accessToken, '/user/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: repositoryName, description: project.prompt.slice(0, 160), private: true, has_issues: true, has_projects: true }),
      });
      const wrangler = JSON.stringify({ name: workerName, main: 'src/worker.mjs', compatibility_date: '2026-08-25' }, null, 2) + '\n';
      await recordEvent(env, projectId, 'repository_created', `Private repository ${repository.full_name} created`, 'creating_repository');

      if (!shouldSkip('pushing_files')) {
        await recordEvent(env, projectId, 'pushing_files', `Pushing ${scaffolding.frontend ? 'LLM-generated' : 'standalone'} source files to ${repository.full_name}`, 'pushing_files');
        await putGithubFile(github.accessToken, repository.full_name, 'README.md', `# ${project.name}\n\n${project.prompt}\n\n${scaffolding.instructions || 'Created by Vela Control Plane.'}\n`, 'Add project README');
        await putGithubFile(github.accessToken, repository.full_name, 'src/worker.mjs', source, 'Add Worker source');
        await putGithubFile(github.accessToken, repository.full_name, 'wrangler.json', wrangler, 'Add Worker configuration');
        if (scaffolding.frontend) await putGithubFile(github.accessToken, repository.full_name, 'src/frontend.jsx', scaffolding.frontend, 'Add frontend component');
        if (scaffolding.database) await putGithubFile(github.accessToken, repository.full_name, 'schema.sql', scaffolding.database, 'Add database schema');
        await env.DB.prepare('UPDATE projects SET github_repository = ?, status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind(repository.full_name, 'deploying_worker', workerName, new Date().toISOString(), project.id).run();
        await recordEvent(env, projectId, 'files_pushed', `All source files pushed to ${repository.full_name}`, 'pushing_files');
      }
    } else {
      await env.DB.prepare('UPDATE projects SET status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind('deploying_worker', workerName, new Date().toISOString(), project.id).run();
    }
  } else {
    if (!shouldSkip('pushing_files')) {
      await env.DB.prepare('UPDATE projects SET status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind('pushing_files', workerName, now, project.id).run();
      await recordEvent(env, projectId, 'repository_reused', `Reusing existing repository ${project.github_repository}`, 'pushing_files');
      await putGithubFile(github.accessToken, project.github_repository, 'src/worker.mjs', source, 'Update Worker source');
      if (scaffolding.frontend) await putGithubFile(github.accessToken, project.github_repository, 'src/frontend.jsx', scaffolding.frontend, 'Update frontend component');
      if (scaffolding.database) await putGithubFile(github.accessToken, project.github_repository, 'schema.sql', scaffolding.database, 'Update database schema');
      await recordEvent(env, projectId, 'files_pushed', `Source files updated in ${project.github_repository}`, 'pushing_files');
    }
  }

  if (!shouldSkip('deploying_worker')) {
    await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('deploying_worker', new Date().toISOString(), project.id).run();
    await recordEvent(env, projectId, 'deployment_started', `Deploying worker ${workerName} to Cloudflare`, 'deploying_worker');
    await deployStandaloneWorker(cloudflare.accessToken, env.CLOUDFLARE_ACCOUNT_ID, workerName, source);
    await recordEvent(env, projectId, 'deployment_complete', `Worker ${workerName} uploaded and subdomain enabled`, 'deploying_worker');
  }

  await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('live', new Date().toISOString(), project.id).run();
  await recordEvent(env, projectId, 'live', `App is live at https://${workerName}.workers.dev`, 'live');
}

async function projectsWithFeatures(env: Env, ownerId: string) {
  const projects = await env.DB.prepare('SELECT id, name, prompt, github_repository, worker_name, status, scaffolding_json, plan_json, created_at, updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC').bind(ownerId).all<Record<string, string | null>>();
  const features = await env.DB.prepare('SELECT project_id, feature, enabled, updated_at FROM project_features WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) ORDER BY feature').bind(ownerId).all<{ project_id: string; feature: string; enabled: number; updated_at: string }>();
  const events = await env.DB.prepare('SELECT project_id, kind, detail, created_at FROM build_events WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) ORDER BY created_at DESC').bind(ownerId).all<{ project_id: string; kind: string; detail: string; created_at: string }>();
  return projects.results.map((project) => ({
    ...project,
    features: features.results.filter((feature) => feature.project_id === project.id).map((feature) => ({ ...feature, enabled: Boolean(feature.enabled) })),
    latest_event: events.results.find((event) => event.project_id === project.id) ?? null,
  }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'vela-control-plane' });
    if (url.pathname === '/' && request.method === 'GET') return builderDashboard();

    if (url.pathname === '/session' && request.method === 'POST') {
      const existing = await readSession(request, env.SESSION_SECRET);
      if (existing) return json({ ready: true });
      const session = await issueSession(env.SESSION_SECRET);
      return json({ ready: true }, { headers: { 'set-cookie': session.cookie } });
    }

    const startProvider = providerFromPath(url.pathname, 'start');
    if (startProvider && request.method === 'GET') {
      const clientId = configuredClientId(env, startProvider);
      if (!clientId) return json({ error: `${startProvider} connection is not configured yet` }, { status: 503 });
      const existingSession = await readSession(request, env.SESSION_SECRET);
      const session = existingSession ? { id: existingSession, cookie: null } : await issueSession(env.SESSION_SECRET);
      const state = randomToken();
      const verifier = randomToken(48);
      const redirectUri = callbackUrl(env, startProvider);
      const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
      await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(new Date().toISOString()).run();
      await env.DB.prepare('INSERT INTO oauth_states (state_hash, provider, session_id, code_verifier_ciphertext, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(await sha256(state), startProvider, session.id, await encrypt(verifier, env.TOKEN_ENCRYPTION_KEY), redirectUri, expiresAt, new Date().toISOString()).run();
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge: await sha256(verifier), code_challenge_method: 'S256' });
      if (startProvider === 'google') params.set('scope', 'openid email profile');
      if (startProvider === 'github') params.set('scope', 'repo workflow read:user');
      if (startProvider === 'cloudflare') params.set('scope', 'workers-scripts.read workers-scripts.write offline_access');
      const endpoint = startProvider === 'google'
        ? 'https://accounts.google.com/o/oauth2/v2/auth'
        : startProvider === 'github'
          ? 'https://github.com/login/oauth/authorize'
          : 'https://dash.cloudflare.com/oauth2/auth';
      const headers = securityHeaders(new Headers({ location: `${endpoint}?${params}` }));
      if (session.cookie) headers.append('set-cookie', session.cookie);
      return new Response(null, { status: 302, headers });
    }

    const callbackProvider = providerFromPath(url.pathname, 'callback');
    if (callbackProvider && request.method === 'GET') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const authorizationError = url.searchParams.get('error');
      if (!state || !code || authorizationError) return json({
        error: 'Authorization was not completed',
        reason: url.searchParams.get('error_description') ?? authorizationError ?? 'Missing authorization code or state',
      }, { status: 400 });
      const stateHash = await sha256(state);
      const stored = await env.DB.prepare('SELECT provider, session_id, code_verifier_ciphertext, redirect_uri, expires_at FROM oauth_states WHERE state_hash = ?').bind(stateHash).first<OAuthState>();
      await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(stateHash).run();
      if (!stored || stored.provider !== callbackProvider || Date.parse(stored.expires_at) <= Date.now()) return json({ error: 'This connection request has expired. Start again.' }, { status: 400 });
      try {
        const verifier = JSON.parse(await decrypt(stored.code_verifier_ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string;
        const token = await exchangeToken(callbackProvider, code, verifier, stored.redirect_uri, env);
        const identity = callbackProvider === 'cloudflare'
          ? { id: env.CLOUDFLARE_ACCOUNT_ID }
          : await providerIdentity(callbackProvider, token.access_token!);
        const login = callbackProvider === 'google' ? await completeGoogleLogin(env, stored.session_id, identity) : null;
        const ownerId = login?.ownerId ?? stored.session_id;
        const now = new Date().toISOString();
        const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
        await env.DB.prepare(`INSERT INTO connections (id, owner_id, provider, external_account_id, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?) ON CONFLICT(owner_id, provider) DO UPDATE SET external_account_id = excluded.external_account_id, access_token_ciphertext = excluded.access_token_ciphertext, refresh_token_ciphertext = excluded.refresh_token_ciphertext, token_expires_at = excluded.token_expires_at, status = 'connected', updated_at = excluded.updated_at`)
          .bind(crypto.randomUUID(), ownerId, callbackProvider, identity.id, await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY), token.refresh_token ? await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY) : null, expiresAt, now, now).run();
        return successPage(callbackProvider, login?.cookie);
      } catch (error) {
        const reason = messageFromError(error);
        console.error(JSON.stringify({ event: 'oauth_callback_failed', provider: callbackProvider, message: reason }));
        return json({ error: 'Connection could not be completed. Start again.', reason }, { status: 502 });
      }
    }

    const sessionId = await readSession(request, env.SESSION_SECRET);
    if (url.pathname === '/connections' && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Connect an account first.' }, { status: 401 });
      const connections = await env.DB.prepare('SELECT provider, external_account_id, status, token_expires_at, updated_at FROM connections WHERE owner_id = ? ORDER BY provider').bind(sessionId).all();
      return json({ connections: connections.results });
    }

    if (url.pathname === '/projects' && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      return json({ projects: await projectsWithFeatures(env, sessionId) });
    }

    if (url.pathname === '/usage' && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const total = await env.DB.prepare('SELECT COALESCE(SUM(estimated_cost_cents), 0) AS estimated_cost_cents FROM usage_events WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?)').bind(sessionId).first<{ estimated_cost_cents: number }>();
      return json({ estimated_cost_cents: total?.estimated_cost_cents ?? 0 });
    }

    if (url.pathname === '/projects' && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const body = await request.json<{ name?: string; prompt?: string }>();
      if (!body.name || !body.prompt) return json({ error: 'name and prompt are required' }, { status: 400 });
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const providers = await connectionProviders(env, sessionId);
      const canBuild = providers.has('github') && providers.has('cloudflare');
      const status = canBuild ? 'planning' : 'needs_connections';
      await env.DB.prepare('INSERT INTO projects (id, owner_id, name, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, sessionId, body.name.trim().slice(0, 80), body.prompt.trim().slice(0, 4000), status, now, now).run();
      await env.DB.batch(['workers', 'd1', 'r2', 'queues'].map((feature) => env.DB.prepare('INSERT INTO project_features (project_id, feature, enabled, updated_at) VALUES (?, ?, 1, ?)').bind(id, feature, now)));
      await env.DB.prepare('INSERT INTO usage_events (id, project_id, metric, quantity, estimated_cost_cents, occurred_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), id, 'project_created', 1, 0, now).run();
      await recordEvent(env, id, 'project_created', canBuild ? 'Ready to queue' : 'Waiting for GitHub and Cloudflare connections');
      if (canBuild) {
        await env.BUILD_JOBS.send({ projectId: id, prompt: body.prompt });
        await env.BUILDS.getByName(id).plan(id, body.prompt);
        await recordEvent(env, id, 'build_queued', 'Build queued — both GitHub and Cloudflare connected', 'planning');
      }
      return json({ project: await projectForOwner(env, id, sessionId) }, { status: 201 });
    }

    const eventsMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/events$/);
    if (eventsMatch && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, eventsMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const events = await env.DB.prepare('SELECT kind, detail, created_at FROM build_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 40').bind(project.id).all();
      return json({ events: events.results });
    }

    const featureMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/features\/([a-z0-9_-]{1,64})$/);
    if (featureMatch && request.method === 'PATCH') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, featureMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const body = await request.json<{ enabled?: boolean }>();
      if (typeof body.enabled !== 'boolean') return json({ error: 'enabled must be a boolean' }, { status: 400 });
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO project_features (project_id, feature, enabled, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, feature) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at').bind(project.id, featureMatch[2], Number(body.enabled), now).run();
      await recordEvent(env, project.id, 'feature_updated', `${featureMatch[2]} ${body.enabled ? 'enabled' : 'disabled'}`);
      return json({ feature: featureMatch[2], enabled: body.enabled });
    }

    const approveMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/approve$/);
    if (approveMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, approveMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      if (project.status !== 'awaiting_approval') return json({ error: 'Project is not awaiting approval', currentStatus: project.status }, { status: 409 });
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('planning', now, project.id).run();
      await recordEvent(env, project.id, 'approved', 'User approved the MVP plan — build continuing', 'planning');
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: project.prompt, resumeFrom: 'scaffolding' });
      await recordEvent(env, project.id, 'build_queued', 'Build queued after approval', 'planning');
      return json({ status: 'planning' }, { status: 202 });
    }

    const rejectMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/reject$/);
    if (rejectMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, rejectMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      if (project.status !== 'awaiting_approval') return json({ error: 'Project is not awaiting approval', currentStatus: project.status }, { status: 409 });
      const body = await request.json<{ prompt?: string }>().catch(() => ({}));
      const now = new Date().toISOString();
      const newPrompt = body.prompt?.trim() || project.prompt;
      // Update prompt if changed
      if (body.prompt?.trim()) {
        await env.DB.prepare('UPDATE projects SET prompt = ?, status = ?, updated_at = ? WHERE id = ?').bind(newPrompt.slice(0, 4000), 'planning', now, project.id).run();
      } else {
        await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('planning', now, project.id).run();
      }
      await recordEvent(env, project.id, 'rejected', body.prompt?.trim() ? 'User revised prompt and rejected plan — regenerating' : 'User rejected plan — regenerating', 'planning');
      // Re-run from scratch (planning stage)
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: newPrompt });
      await env.BUILDS.getByName(project.id).plan(project.id, newPrompt);
      return json({ status: 'planning' }, { status: 202 });
    }

    const buildMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/build$/);
    if (buildMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, buildMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const providers = await connectionProviders(env, sessionId);
      if (!providers.has('github') || !providers.has('cloudflare')) return json({ status: 'needs_connections' }, { status: 409 });
      const body = await request.json<{ prompt?: string; resumeFrom?: string }>().catch(() => ({}));
      const now = new Date().toISOString();
      const buildPrompt = body.prompt?.trim() || project.prompt;
      if (body.prompt?.trim()) {
        await env.DB.prepare('UPDATE projects SET prompt = ?, updated_at = ? WHERE id = ?').bind(body.prompt.trim().slice(0, 4000), now, project.id).run();
      }
      await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('planning', now, project.id).run();
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: buildPrompt, resumeFrom: body.resumeFrom });
      await env.BUILDS.getByName(project.id).plan(project.id, buildPrompt);
      await recordEvent(env, project.id, 'build_queued', body.resumeFrom ? `Build resumed from stage: ${body.resumeFrom}` : 'Build queued', 'planning');
      return json({ status: 'planning' }, { status: 202 });
    }

    const updateMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})$/);
    if (updateMatch && request.method === 'PATCH') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, updateMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const body = await request.json<{ name?: string; prompt?: string }>().catch(() => ({}));
      const updates: string[] = [];
      const binds: unknown[] = [];
      if (body.name?.trim()) { updates.push('name = ?'); binds.push(body.name.trim().slice(0, 80)); }
      if (body.prompt?.trim()) { updates.push('prompt = ?'); binds.push(body.prompt.trim().slice(0, 4000)); }
      if (updates.length === 0) return json({ error: 'No fields to update' }, { status: 400 });
      updates.push('updated_at = ?');
      binds.push(new Date().toISOString(), project.id);
      await env.DB.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
      return json({ updated: true });
    }

    return json({ error: 'Not found' }, { status: 404 });
  },

  async queue(batch: MessageBatch<{ projectId: string; prompt: string; resumeFrom?: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        // Check if project is already awaiting approval (plan was generated, build paused)
        const project = await env.DB.prepare('SELECT status FROM projects WHERE id = ?').bind(message.body.projectId).first<{ status: string }>();
        if (project?.status === 'awaiting_approval') {
          await recordEvent(env, message.body.projectId, 'build_paused', 'Build paused — awaiting user approval', 'awaiting_approval');
          message.ack();
          continue;
        }
        await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('building', new Date().toISOString(), message.body.projectId).run();
        await recordEvent(env, message.body.projectId, 'build_queued', message.body.resumeFrom ? `Resuming build from stage: ${message.body.resumeFrom}` : 'Fresh build started', 'building');
        await buildStandaloneApp(env, message.body.projectId, message.body.resumeFrom);
        message.ack();
      } catch (error) {
        const detail = messageFromError(error);
        await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('failed', new Date().toISOString(), message.body.projectId).run();
        await recordEvent(env, message.body.projectId, 'build_failed', detail, 'failed');
        console.error(JSON.stringify({ event: 'build_failed', projectId: message.body.projectId, message: detail }));
        message.ack();
      }
    }
  },
};
