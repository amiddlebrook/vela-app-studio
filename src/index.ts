import { DurableObject } from 'cloudflare:workers';

export interface Env {
  DB: D1Database;
  BUILDS: DurableObjectNamespace<BuildCoordinator>;
  BUILD_JOBS: Queue<{ projectId: string; prompt: string }>;
  APP_ORIGIN: string;
  CLOUDFLARE_CLIENT_ID?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: CryptoKey;
}

type Provider = 'github' | 'cloudflare';
type OAuthState = { provider: Provider; session_id: string; code_verifier_ciphertext: string; redirect_uri: string; expires_at: string };
type ProviderToken = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

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
  const id = randomToken();
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
  const provider = pathname.match(new RegExp(`^/auth/(github|cloudflare)/${suffix}$`))?.[1];
  return provider === 'github' || provider === 'cloudflare' ? provider : null;
}

function callbackUrl(env: Env, provider: Provider): string {
  return `${new URL(env.APP_ORIGIN).origin}/auth/${provider}/callback`;
}

function configuredClientId(env: Env, provider: Provider): string | undefined {
  return provider === 'github' ? env.GITHUB_CLIENT_ID : env.CLOUDFLARE_CLIENT_ID;
}

async function exchangeToken(provider: Provider, code: string, verifier: string, redirectUri: string, env: Env): Promise<ProviderToken> {
  const clientId = configuredClientId(env, provider);
  if (!clientId) throw new Error(`${provider} OAuth is not configured`);
  const form = new URLSearchParams({ client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
  if (provider === 'github') {
    if (!env.GITHUB_CLIENT_SECRET) throw new Error('github OAuth is not configured');
    form.set('client_secret', env.GITHUB_CLIENT_SECRET);
  }
  const response = await fetch(provider === 'github' ? 'https://github.com/login/oauth/access_token' : 'https://dash.cloudflare.com/oauth2/token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const token = await response.json<ProviderToken>();
  if (!response.ok || !token.access_token) throw new Error(token.error_description ?? token.error ?? 'OAuth token exchange failed');
  return token;
}

async function externalAccount(provider: Provider, accessToken: string): Promise<string> {
  const response = await fetch(provider === 'github' ? 'https://api.github.com/user' : 'https://dash.cloudflare.com/oauth2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Could not verify provider account');
  const identity = await response.json<{ id?: number | string; sub?: string }>();
  const id = identity.id ?? identity.sub;
  if (!id) throw new Error('Provider did not return an account identifier');
  return String(id);
}

function successPage(provider: Provider): Response {
  const label = provider === 'github' ? 'GitHub' : 'Cloudflare';
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Connection complete</title></head><body><main><h1>${label} connected</h1><p>You can return to the app and continue.</p></main></body></html>`, {
    headers: securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })),
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

async function connectionProviders(env: Env, ownerId: string): Promise<Set<string>> {
  const result = await env.DB.prepare('SELECT provider FROM connections WHERE owner_id = ? AND status = ?').bind(ownerId, 'connected').all<{ provider: string }>();
  return new Set(result.results.map((connection) => connection.provider));
}

async function projectForOwner(env: Env, id: string, ownerId: string) {
  return env.DB.prepare('SELECT id, name, prompt, status, created_at, updated_at FROM projects WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<{ id: string; name: string; prompt: string; status: string; created_at: string; updated_at: string }>();
}

async function recordEvent(env: Env, projectId: string, kind: string, detail: string): Promise<void> {
  await env.DB.prepare('INSERT INTO build_events (id, project_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), projectId, kind, detail, new Date().toISOString()).run();
}

async function projectsWithFeatures(env: Env, ownerId: string) {
  const projects = await env.DB.prepare('SELECT id, name, prompt, github_repository, worker_name, status, created_at, updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC').bind(ownerId).all<Record<string, string | null>>();
  const features = await env.DB.prepare('SELECT project_id, feature, enabled, updated_at FROM project_features WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) ORDER BY feature').bind(ownerId).all<{ project_id: string; feature: string; enabled: number; updated_at: string }>();
  return projects.results.map((project) => ({ ...project, features: features.results.filter((feature) => feature.project_id === project.id).map((feature) => ({ ...feature, enabled: Boolean(feature.enabled) })) }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'vela-control-plane' });
    if (url.pathname === '/' && request.method === 'GET') return dashboardV2();

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
      if (startProvider === 'github') params.set('scope', 'repo workflow read:user');
      if (startProvider === 'cloudflare') params.set('scope', 'workers-platform.read workers-platform.write');
      const endpoint = startProvider === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://dash.cloudflare.com/oauth2/auth';
      const headers = securityHeaders(new Headers({ location: `${endpoint}?${params}` }));
      if (session.cookie) headers.append('set-cookie', session.cookie);
      return new Response(null, { status: 302, headers });
    }

    const callbackProvider = providerFromPath(url.pathname, 'callback');
    if (callbackProvider && request.method === 'GET') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!state || !code || url.searchParams.get('error')) return json({ error: 'Authorization was not completed' }, { status: 400 });
      const stateHash = await sha256(state);
      const stored = await env.DB.prepare('SELECT provider, session_id, code_verifier_ciphertext, redirect_uri, expires_at FROM oauth_states WHERE state_hash = ?').bind(stateHash).first<OAuthState>();
      await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(stateHash).run();
      if (!stored || stored.provider !== callbackProvider || Date.parse(stored.expires_at) <= Date.now()) return json({ error: 'This connection request has expired. Start again.' }, { status: 400 });
      try {
        const token = await exchangeToken(callbackProvider, code, await decrypt(stored.code_verifier_ciphertext, env.TOKEN_ENCRYPTION_KEY), stored.redirect_uri, env);
        const externalId = await externalAccount(callbackProvider, token.access_token!);
        const now = new Date().toISOString();
        const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
        await env.DB.prepare(`INSERT INTO connections (id, owner_id, provider, external_account_id, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?) ON CONFLICT(owner_id, provider) DO UPDATE SET external_account_id = excluded.external_account_id, access_token_ciphertext = excluded.access_token_ciphertext, refresh_token_ciphertext = excluded.refresh_token_ciphertext, token_expires_at = excluded.token_expires_at, status = 'connected', updated_at = excluded.updated_at`)
          .bind(crypto.randomUUID(), stored.session_id, callbackProvider, externalId, await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY), token.refresh_token ? await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY) : null, expiresAt, now, now).run();
        return successPage(callbackProvider);
      } catch (error) {
        console.error(JSON.stringify({ event: 'oauth_callback_failed', provider: callbackProvider, message: error instanceof Error ? error.message : 'unknown' }));
        return json({ error: 'Connection could not be completed. Start again.' }, { status: 502 });
      }
    }

    const sessionId = await readSession(request, env.SESSION_SECRET);
    if (url.pathname === '/connections' && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Connect an account first.' }, { status: 401 });
      const connections = await env.DB.prepare('SELECT provider, external_account_id, status, updated_at FROM connections WHERE owner_id = ? ORDER BY provider').bind(sessionId).all();
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
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('queued', now, message.body.projectId).run();
      await recordEvent(env, message.body.projectId, 'build_queued', 'Queue consumer accepted the build job');
    }
  },
};
