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
:root{--bg:#080910;--card:#111522;--line:#2a3150;--ink:#f0f3ff;--muted:#99a2c4;--blue:#9cadff;--mint:#90ebc1;--amber:#ffc978}*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 500px at 88% -10%,#2a3f8255,transparent 65%),radial-gradient(680px 460px at -8% 24%,#493a7855,transparent 68%),var(--bg);color:var(--ink);font:15px ui-sans-serif,system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:36px 22px 90px}.top{display:flex;justify-content:space-between;gap:18px;align-items:start}.eyebrow{color:#aebcff;font-size:11px;letter-spacing:.18em;text-transform:uppercase}.top h1{font-size:clamp(42px,7vw,78px);letter-spacing:-.07em;line-height:.88;margin:12px 0}.top p{max-width:560px;color:var(--muted);line-height:1.55}.signal{min-width:215px;border:1px solid #42588b;border-radius:18px;padding:14px 16px;background:#121a31cc}.signal b{display:block;font-size:20px;margin:5px 0}.live-dot{display:inline-block;width:8px;height:8px;background:var(--mint);box-shadow:0 0 16px var(--mint);border-radius:50%;margin-right:7px}.grid{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(300px,.88fr);gap:16px;margin-top:26px}.card{background:linear-gradient(145deg,#151a2aee,#0c0e17ee);border:1px solid var(--line);border-radius:22px;padding:21px;box-shadow:0 24px 70px #0003}.wide{grid-column:1/-1}.card h2{font-size:17px;margin:0 0 14px}.prompt{font-size:17px;min-height:130px;resize:vertical}input,textarea{width:100%;border:1px solid #363e61;border-radius:13px;background:#090b14;color:var(--ink);font:inherit;padding:13px;margin:0 0 10px}button{border:0;border-radius:999px;background:var(--blue);color:#11172b;padding:11px 16px;font-weight:800;cursor:pointer}button.secondary{background:#202844;color:var(--ink)}button:disabled{opacity:.52;cursor:default}.hint,.meta{color:var(--muted);font-size:12px;line-height:1.5}.connections{display:grid;gap:8px}.connection{display:flex;align-items:center;justify-content:space-between;border:1px solid #2b3353;border-radius:14px;padding:12px}.state{font-size:12px;color:var(--muted)}.state.ok{color:var(--mint)}.state.wait{color:var(--amber)}.build-list{display:grid;gap:12px}.empty{border:1px dashed #34405f;border-radius:16px;padding:32px;color:var(--muted);text-align:center}.project{border:1px solid #2c3453;border-radius:18px;padding:17px;background:#0c0f1b}.project-top{display:flex;justify-content:space-between;gap:16px}.project h3{font-size:18px;margin:0 0 5px}.badge{font-size:11px;padding:6px 9px;border-radius:99px;background:#1e2744;color:#bec9f6;white-space:nowrap}.badge.active{background:#233c55;color:#9decc8}.badge.live{background:#214435;color:#a6f3cc}.badge.failed{background:#512c38;color:#ffc0cc}.steps{display:flex;gap:3px;margin:16px 0 10px}.step{height:5px;border-radius:9px;flex:1;background:#242b43}.step.done{background:var(--mint)}.step.now{background:var(--amber);box-shadow:0 0 12px #ffc97899}.activity{border-top:1px solid #27304d;padding-top:11px;color:#cbd3ef;font-size:13px}.activity time{color:var(--muted);margin-left:6px}.project-links{display:flex;gap:12px;margin-top:10px}.project-links a{color:#b8c7ff;font-size:12px}.pulse{animation:pulse 1.55s ease-in-out infinite}@keyframes pulse{50%{opacity:.48;transform:scale(.82)}}@media(max-width:760px){.top{flex-direction:column}.signal{width:100%}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.project-top{flex-direction:column}}
</style></head><body><main>
<header class="top"><div><div class="eyebrow">Vela / app creation control</div><h1>See every build<br>become real.</h1><p>Every project is a separate GitHub repository and Cloudflare Worker. This screen reports the actual records written as each step happens.</p></div><aside class="signal"><span class="live-dot"></span>Live build signals<b id="activeCount">Checking…</b><span class="meta" id="signalText">Reading your workspace</span></aside></header>
<section class="grid"><article class="card"><h2>Describe the app</h2><input id="name" maxlength="80" placeholder="App name"><textarea id="prompt" class="prompt" maxlength="4000" placeholder="What should this app do, for whom, and what should it feel like?"></textarea><button id="create" onclick="createProject()">Create this app</button><p id="status" class="hint"></p><p class="hint">Once both connections are live, this queues a real build automatically.</p></article><article class="card"><h2>Launch access</h2><div class="connections"><div class="connection"><div><strong>GitHub</strong><div id="github" class="state">Checking…</div></div><button class="secondary" onclick="location.href='/auth/github/start'">Connect</button></div><div class="connection"><div><strong>Cloudflare</strong><div id="cloudflare" class="state">Checking…</div></div><button class="secondary" onclick="location.href='/auth/cloudflare/start'">Connect</button></div></div><p class="hint">GitHub holds each app’s isolated source repository. Cloudflare runs each app independently.</p></article><section class="card wide"><h2>Your build board</h2><div class="build-list" id="projects"><div class="empty">Loading build records…</div></div></section></section></main>
<script>
const $=s=>document.querySelector(s);let projects=[];let refreshTimer;
const stages=['planning','building','creating_repository','deploying','live'];
const labels={needs_connections:'Waiting for connections',planning:'Queued for planning',building:'Preparing app files',creating_repository:'Creating GitHub repository',deploying:'Deploying to Cloudflare',live:'Live',failed:'Build failed'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,options){const r=await fetch(path,options);const d=await r.json();if(!r.ok)throw Error(d.reason||d.error||'Request failed');return d}
function statusClass(status){return status==='live'?'live':status==='failed'?'failed':status==='needs_connections'?'':'active'}
function render(){const active=projects.filter(p=>!['live','failed','needs_connections'].includes(p.status));$('#activeCount').textContent=active.length?active.length+' build'+(active.length===1?'':'s')+' active':'No active builds';$('#signalText').textContent=active.length?'Auto-refreshing every 2 seconds':'Build events stay attached to each project';const root=$('#projects');if(!projects.length){root.innerHTML='<div class="empty">No builds yet. Describe an app above and its creation timeline will appear here.</div>';return}root.innerHTML=projects.map(p=>{const step=stages.indexOf(p.status);const dots=stages.map((stage,i)=>'<i class="step '+(i<step?'done':i===step&&step>=0&&p.status!=='live'?'now pulse':i===step&&p.status==='live'?'done':'')+'"></i>').join('');const event=p.latest_event;const repo=p.github_repository?'<a target="_blank" rel="noreferrer" href="https://github.com/'+esc(p.github_repository)+'">Open repository ↗</a>':'';const retry=p.status==='failed'?'<button class="secondary" onclick="retryBuild(&quot;'+p.id+'&quot;)">Retry build</button>':'';return '<article class="project"><div class="project-top"><div><h3>'+esc(p.name)+'</h3><div class="meta">'+esc(labels[p.status]||p.status)+' · updated '+new Date(p.updated_at).toLocaleTimeString()+'</div></div><span class="badge '+statusClass(p.status)+'">'+esc(labels[p.status]||p.status)+'</span></div><div class="steps" title="Planning → files → GitHub → Cloudflare → live">'+dots+'</div><div class="activity">'+(event?esc(event.detail)+'<time>'+new Date(event.created_at).toLocaleTimeString()+'</time>':'Project created — waiting for its first build event.')+'</div><div class="project-links">'+repo+(p.worker_name?'<a target="_blank" rel="noreferrer" href="https://'+esc(p.worker_name)+'.workers.dev">Open app ↗</a>':'')+retry+'</div></article>'}).join('')}
async function refresh(){try{const [c,p]=await Promise.all([api('/connections'),api('/projects')]);const connections=new Map(c.connections.map(x=>[x.provider,x]));for(const provider of ['github','cloudflare']){const node=$('#'+provider),connection=connections.get(provider),expired=connection?.token_expires_at&&Date.parse(connection.token_expires_at)<=Date.now()+60000,yes=!!connection&&!expired;node.textContent=yes?'Connected and ready':expired?'Reconnect required (token expired)':'Not connected';node.className='state '+(yes?'ok':'wait')}projects=p.projects;render()}catch(e){$('#status').textContent=e.message}finally{clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,projects.some(p=>!['live','failed','needs_connections'].includes(p.status))?2000:12000)}}
async function createProject(){const status=$('#status'),button=$('#create');status.textContent='Creating project record…';button.disabled=true;try{const d=await api('/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:$('#name').value,prompt:$('#prompt').value})});status.textContent='Created '+d.project.name+'. Watch its build board below.';$('#name').value='';$('#prompt').value='';await refresh()}catch(e){status.textContent=e.message}finally{button.disabled=false}}
async function retryBuild(id){$('#status').textContent='Re-queuing build…';try{await api('/projects/'+id+'/build',{method:'POST'});$('#status').textContent='Build re-queued. Watching its progress below.';await refresh()}catch(e){$('#status').textContent=e.message}}
(async()=>{try{await api('/session',{method:'POST'})}catch(e){$('#status').textContent=e.message}refresh()})();
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

async function recordEvent(env: Env, projectId: string, kind: string, detail: string): Promise<void> {
  await env.DB.prepare('INSERT INTO build_events (id, project_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), projectId, kind, detail, new Date().toISOString()).run();
}

async function buildStandaloneApp(env: Env, projectId: string): Promise<void> {
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
  const source = standaloneWorkerSource(project.name, project.prompt);

  if (!project.github_repository) {
    await env.DB.prepare('UPDATE projects SET status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind('creating_repository', workerName, now, project.id).run();
    await recordEvent(env, project.id, 'repository_started', `Creating private GitHub repository ${repositoryName}`);
    const repository = await githubRequest<{ full_name: string }>(github.accessToken, '/user/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: repositoryName, description: project.prompt.slice(0, 160), private: true, has_issues: true, has_projects: true }),
    });
    const wrangler = JSON.stringify({ name: workerName, main: 'src/worker.mjs', compatibility_date: '2026-08-25' }, null, 2) + '\n';
    await putGithubFile(github.accessToken, repository.full_name, 'README.md', `# ${project.name}\n\n${project.prompt}\n\nThis is a standalone Cloudflare Worker created by Vela.\n`, 'Add project README');
    await putGithubFile(github.accessToken, repository.full_name, 'src/worker.mjs', source, 'Add standalone Worker');
    await putGithubFile(github.accessToken, repository.full_name, 'wrangler.json', wrangler, 'Add Worker configuration');
    await env.DB.prepare('UPDATE projects SET github_repository = ?, status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind(repository.full_name, 'deploying', workerName, new Date().toISOString(), project.id).run();
    await recordEvent(env, project.id, 'repository_created', `Private repository ${repository.full_name} created`);
  } else {
    await env.DB.prepare('UPDATE projects SET status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind('deploying', workerName, now, project.id).run();
    await recordEvent(env, project.id, 'repository_reused', `Reusing existing repository ${project.github_repository} for this deployment retry`);
  }

  await deployStandaloneWorker(cloudflare.accessToken, env.CLOUDFLARE_ACCOUNT_ID, workerName, source);
  await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('live', new Date().toISOString(), project.id).run();
  await recordEvent(env, project.id, 'deployment_complete', `Worker deployed as ${workerName}`);
}

async function projectsWithFeatures(env: Env, ownerId: string) {
  const projects = await env.DB.prepare('SELECT id, name, prompt, github_repository, worker_name, status, created_at, updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC').bind(ownerId).all<Record<string, string | null>>();
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

    const buildMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/build$/);
    if (buildMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, buildMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const providers = await connectionProviders(env, sessionId);
      if (!providers.has('github') || !providers.has('cloudflare')) return json({ status: 'needs_connections' }, { status: 409 });
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('planning', now, project.id).run();
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: project.prompt });
      await env.BUILDS.getByName(project.id).plan(project.id, project.prompt);
      await recordEvent(env, project.id, 'build_queued', 'Build queued after both provider connections were confirmed');
      return json({ status: 'planning' }, { status: 202 });
    }

    return json({ error: 'Not found' }, { status: 404 });
  },

  async queue(batch: MessageBatch<{ projectId: string; prompt: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('building', new Date().toISOString(), message.body.projectId).run();
        await recordEvent(env, message.body.projectId, 'build_started', 'Queue consumer started the standalone app build');
        await buildStandaloneApp(env, message.body.projectId);
        message.ack();
      } catch (error) {
        const detail = messageFromError(error);
        await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('failed', new Date().toISOString(), message.body.projectId).run();
        await recordEvent(env, message.body.projectId, 'build_failed', detail);
        console.error(JSON.stringify({ event: 'build_failed', projectId: message.body.projectId, message: detail }));
        message.ack();
      }
    }
  },
};
