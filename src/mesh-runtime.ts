type MeshEnv = {
  DB?: D1Database;
  AI?: Ai;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string | CryptoKey;
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
};

type MeshLink = {
  id: string;
  owner_id: string;
  from_node: string;
  to_node: string;
  capabilities_json: string;
  config_json: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type CredentialRow = {
  node_id: string;
  secret_ciphertext: string | null;
  public_config_json: string | null;
  status: string;
  last_tested_at: string | null;
};

type NodeMode = 'oauth' | 'google' | 'ai' | 'credential' | 'native';
type NodeDef = { id: string; name: string; group: string; icon: string; mode: NodeMode; description: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = 'vela_session';
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const NODES: NodeDef[] = [
  { id: 'github', name: 'GitHub', group: 'Build', icon: 'GH', mode: 'oauth', description: 'Repositories, issues, files and Actions' },
  { id: 'cloudflare', name: 'Cloudflare', group: 'Build', icon: 'CF', mode: 'oauth', description: 'Workers, D1 and edge deployment' },
  { id: 'google', name: 'Google', group: 'Google', icon: 'G', mode: 'oauth', description: 'Google identity and shared authorization' },
  { id: 'gmail', name: 'Gmail', group: 'Google', icon: 'M', mode: 'google', description: 'Read mail, create drafts and send when allowed' },
  { id: 'drive', name: 'Drive', group: 'Google', icon: 'D', mode: 'google', description: 'Read files and create generated files' },
  { id: 'sheets', name: 'Sheets', group: 'Google', icon: 'SH', mode: 'google', description: 'Read and append spreadsheet values' },
  { id: 'youtube', name: 'YouTube', group: 'Content', icon: 'YT', mode: 'google', description: 'Channel, video and analytics access' },
  { id: 'stripe', name: 'Stripe', group: 'Commerce', icon: '$', mode: 'credential', description: 'Payments, account and balance data' },
  { id: 'shopify', name: 'Shopify', group: 'Commerce', icon: 'S', mode: 'credential', description: 'Store catalog, inventory and orders' },
  { id: 'amazon', name: 'Amazon', group: 'Commerce', icon: 'A', mode: 'credential', description: 'Marketplace and seller API adapter' },
  { id: 'ebay', name: 'eBay', group: 'Commerce', icon: 'E', mode: 'credential', description: 'Seller and marketplace API adapter' },
  { id: 'walmart', name: 'Walmart', group: 'Commerce', icon: 'W', mode: 'credential', description: 'Marketplace API adapter' },
  { id: 'reddit', name: 'Reddit', group: 'Content', icon: 'R', mode: 'credential', description: 'Research communities and content' },
  { id: 'tiktok', name: 'TikTok', group: 'Content', icon: 'T', mode: 'credential', description: 'Content and commerce API adapter' },
  { id: 'instagram', name: 'Instagram', group: 'Content', icon: 'IG', mode: 'credential', description: 'Instagram Graph adapter' },
  { id: 'crawler', name: 'Web Crawler', group: 'Internet', icon: '◎', mode: 'native', description: 'Fetch and analyze public web pages' },
  { id: 'webhook', name: 'Webhook / API', group: 'Internet', icon: '↗', mode: 'credential', description: 'Connect any HTTP API or webhook' },
  { id: 'openrouter', name: 'OpenRouter', group: 'AI', icon: 'OR', mode: 'ai', description: 'OpenRouter model connection' },
  { id: 'openai', name: 'OpenAI', group: 'AI', icon: 'AI', mode: 'ai', description: 'OpenAI model connection' },
  { id: 'anthropic', name: 'Anthropic', group: 'AI', icon: 'AN', mode: 'ai', description: 'Anthropic model connection' },
  { id: 'gemini', name: 'Gemini', group: 'AI', icon: 'GM', mode: 'ai', description: 'Google Gemini model connection' },
  { id: 'workers-ai', name: 'Workers AI', group: 'AI', icon: 'CF', mode: 'ai', description: 'Cloudflare Workers AI binding' },
  { id: 'custom-ai', name: 'Custom AI', group: 'AI', icon: '+', mode: 'ai', description: 'OpenAI-compatible custom endpoint' },
];

function securityHeaders(headers = new Headers()): Headers {
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  headers.set('x-frame-options', 'DENY');
  return headers;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers: securityHeaders(new Headers(headers)) });
}

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
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function normalizedSessionKey(secret: string): Promise<Uint8Array> {
  return sha256(secret);
}

async function sessionSignature(id: string, rawSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', toBuffer(await normalizedSessionKey(rawSecret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(id))));
}

async function readOwner(request: Request, env: MeshEnv): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!value) return null;
  const [id, signature] = value.split('.');
  if (!id || !signature) return null;
  return (await sessionSignature(id, env.SESSION_SECRET)) === signature ? id : null;
}

async function issueSession(env: MeshEnv): Promise<{ id: string; cookie: string }> {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  const id = randomToken();
  const signature = await sessionSignature(id, env.SESSION_SECRET);
  return { id, cookie: `${SESSION_COOKIE}=${id}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` };
}

async function encryptionKey(value: string | CryptoKey): Promise<CryptoKey> {
  if (typeof value !== 'string') return value;
  const digest = await sha256(value);
  return crypto.subtle.importKey('raw', toBuffer(digest), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecret(value: string, env: MeshEnv): Promise<string> {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(iv) }, await encryptionKey(env.TOKEN_ENCRYPTION_KEY), encoder.encode(value));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptSecret(value: string, env: MeshEnv): Promise<string> {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  const [iv, ciphertext] = value.split('.');
  if (!iv || !ciphertext) throw new Error('Invalid encrypted secret');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(base64UrlBytes(iv)) }, await encryptionKey(env.TOKEN_ENCRYPTION_KEY), toBuffer(base64UrlBytes(ciphertext)));
  return decoder.decode(plaintext);
}

async function ensureSchema(env: MeshEnv): Promise<void> {
  if (!env.DB) throw new Error('D1 binding DB is missing');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mesh_workspaces (owner_id TEXT PRIMARY KEY, goal TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mesh_links (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, from_node TEXT NOT NULL, to_node TEXT NOT NULL, capabilities_json TEXT NOT NULL, config_json TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mesh_credentials (owner_id TEXT NOT NULL, node_id TEXT NOT NULL, secret_ciphertext TEXT, public_config_json TEXT, status TEXT NOT NULL DEFAULT 'configured', last_tested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id,node_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mesh_runs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, summary_json TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mesh_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner_id TEXT NOT NULL, node_id TEXT, kind TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL, code_verifier_ciphertext TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`),
  ]);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

async function connectionSet(env: MeshEnv, ownerId: string): Promise<Set<string>> {
  if (!env.DB) return new Set();
  const result = await env.DB.prepare(`SELECT provider FROM connections WHERE owner_id=? AND status='connected'`).bind(ownerId).all<{ provider: string }>();
  return new Set((result.results || []).map(row => row.provider));
}

async function credentialRows(env: MeshEnv, ownerId: string): Promise<Map<string, CredentialRow>> {
  if (!env.DB) return new Map();
  const result = await env.DB.prepare('SELECT node_id,secret_ciphertext,public_config_json,status,last_tested_at FROM mesh_credentials WHERE owner_id=?').bind(ownerId).all<CredentialRow>();
  return new Map((result.results || []).map(row => [row.node_id, row]));
}

async function aiStatus(env: MeshEnv, ownerId: string): Promise<Record<string, boolean>> {
  if (!env.DB) return { 'workers-ai': Boolean(env.AI) };
  const row = await env.DB.prepare(`SELECT active_provider,openrouter_key_ciphertext,openai_key_ciphertext,gemini_key_ciphertext,anthropic_key_ciphertext,custom_endpoint,custom_key_ciphertext FROM workspace_settings WHERE owner_id=?`).bind(ownerId).first<Record<string, unknown>>();
  return {
    openrouter: Boolean(row?.openrouter_key_ciphertext || env.OPENROUTER_API_KEY),
    openai: Boolean(row?.openai_key_ciphertext || env.OPENAI_API_KEY),
    anthropic: Boolean(row?.anthropic_key_ciphertext || env.ANTHROPIC_API_KEY),
    gemini: Boolean(row?.gemini_key_ciphertext || env.GEMINI_API_KEY),
    'workers-ai': Boolean(env.AI),
    'custom-ai': Boolean(row?.custom_endpoint && row?.custom_key_ciphertext),
  };
}

async function stateFor(env: MeshEnv, ownerId: string): Promise<unknown> {
  await ensureSchema(env);
  const [connections, creds, ai, workspace, links, runs] = await Promise.all([
    connectionSet(env, ownerId),
    credentialRows(env, ownerId),
    aiStatus(env, ownerId),
    env.DB!.prepare('SELECT goal,updated_at FROM mesh_workspaces WHERE owner_id=?').bind(ownerId).first<{ goal: string; updated_at: string }>(),
    env.DB!.prepare('SELECT * FROM mesh_links WHERE owner_id=? ORDER BY created_at ASC').bind(ownerId).all<MeshLink>(),
    env.DB!.prepare('SELECT id,status,goal,summary_json,error,started_at,finished_at FROM mesh_runs WHERE owner_id=? ORDER BY started_at DESC LIMIT 12').bind(ownerId).all(),
  ]);
  const googleReady = connections.has('google');
  const catalog = NODES.map(node => ({
    ...node,
    ready: node.mode === 'native' || (node.mode === 'oauth' && connections.has(node.id)) || (node.mode === 'google' && googleReady) || (node.mode === 'ai' && Boolean(ai[node.id])) || (node.mode === 'credential' && creds.get(node.id)?.status === 'connected'),
    configured: node.mode === 'credential' ? creds.has(node.id) : undefined,
    lastTestedAt: creds.get(node.id)?.last_tested_at || undefined,
    config: parseJson(creds.get(node.id)?.public_config_json, {} as Record<string, unknown>),
  }));
  return {
    goal: workspace?.goal || '',
    catalog,
    links: (links.results || []).map(link => ({ id: link.id, from: link.from_node, to: link.to_node, capabilities: parseJson<string[]>(link.capabilities_json, []), enabled: Boolean(link.enabled), config: parseJson(link.config_json, {}) })),
    runs: (runs.results || []).map((run: any) => ({ ...run, summary: parseJson(run.summary_json, null) })),
  };
}

async function existingProviderToken(env: MeshEnv, ownerId: string, provider: string): Promise<string> {
  if (!env.DB) throw new Error('D1 unavailable');
  const row = await env.DB.prepare(`SELECT access_token_ciphertext FROM connections WHERE owner_id=? AND provider=? AND status='connected'`).bind(ownerId, provider).first<{ access_token_ciphertext: string | null }>();
  if (!row?.access_token_ciphertext) throw new Error(`${provider} is not connected`);
  return JSON.parse(await decryptSecret(row.access_token_ciphertext, env)) as string;
}

async function meshCredential(env: MeshEnv, ownerId: string, nodeId: string): Promise<{ secret: string; config: Record<string, any> }> {
  if (!env.DB) throw new Error('D1 unavailable');
  const row = await env.DB.prepare('SELECT secret_ciphertext,public_config_json,status FROM mesh_credentials WHERE owner_id=? AND node_id=?').bind(ownerId, nodeId).first<CredentialRow>();
  if (!row || row.status !== 'connected') throw new Error(`${nodeId} is not connected`);
  return { secret: row.secret_ciphertext ? await decryptSecret(row.secret_ciphertext, env) : '', config: parseJson(row.public_config_json, {}) };
}

async function testCredential(nodeId: string, secret: string, config: Record<string, any>): Promise<{ ok: boolean; detail: string }> {
  let response: Response | null = null;
  if (nodeId === 'stripe') response = await fetch('https://api.stripe.com/v1/account', { headers: { authorization: `Bearer ${secret}` } });
  else if (nodeId === 'shopify') {
    const shop = String(config.shop || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!shop) throw new Error('Shopify shop domain is required');
    response = await fetch(`https://${shop}/admin/api/2026-07/shop.json`, { headers: { 'x-shopify-access-token': secret } });
  } else if (nodeId === 'reddit') response = await fetch('https://oauth.reddit.com/api/v1/me', { headers: { authorization: `Bearer ${secret}`, 'user-agent': 'VelaMesh/1.0' } });
  else if (nodeId === 'instagram') response = await fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${encodeURIComponent(secret)}`);
  else if (nodeId === 'ebay') response = await fetch('https://api.ebay.com/sell/account/v1/privilege', { headers: { authorization: `Bearer ${secret}` } });
  else if (nodeId === 'webhook') {
    const url = String(config.url || '');
    if (!/^https:\/\//i.test(url)) throw new Error('A HTTPS API URL is required');
    response = await fetch(url, { method: 'GET', headers: secret ? { authorization: `Bearer ${secret}` } : undefined });
  } else if (config.testUrl && /^https:\/\//i.test(String(config.testUrl))) {
    response = await fetch(String(config.testUrl), { headers: secret ? { authorization: `Bearer ${secret}` } : undefined });
  }
  if (!response) return { ok: true, detail: 'Credential stored. Provider-specific live test is not available; this connector can use its configured API endpoint.' };
  const text = await response.text();
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  return { ok: true, detail: `Provider responded HTTP ${response.status}` };
}

async function recordEvent(env: MeshEnv, ownerId: string, runId: string, nodeId: string | null, kind: string, detail: unknown): Promise<void> {
  await env.DB!.prepare('INSERT INTO mesh_events(id,run_id,owner_id,node_id,kind,detail_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), runId, ownerId, nodeId, kind, JSON.stringify(detail), new Date().toISOString()).run();
}

async function requestJson(url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function observeNode(env: MeshEnv, ownerId: string, nodeId: string, goal: string): Promise<any> {
  if (nodeId === 'crawler') {
    const found = goal.match(/https:\/\/[^\s<>"']+/i);
    if (!found) throw new Error('Web Crawler needs a public HTTPS URL in the workspace goal.');
    const target = new URL(found[0].replace(/[.,;!?]+$/, ''));
    if (target.username || target.password || target.port || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target.hostname) || /(^|\.)localhost$|(^|\.)local$|(^|\.)internal$|(^|\.)example$|(^|\.)test$|(^|\.)invalid$|\.workers\.dev$/i.test(target.hostname)) throw new Error('Crawler only supports public HTTPS websites without custom ports.');
    const response = await fetch(target.toString(), { redirect: 'error', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Crawler received HTTP ' + response.status);
    if (!String(response.headers.get('content-type') || '').includes('text/html')) throw new Error('Crawler expects a public HTML page');
    if (Number(response.headers.get('content-length') || '0') > 300000) throw new Error('Page exceeds the crawler size limit');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Page has no readable response body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < 180000) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.slice(0, 180000 - size);
        chunks.push(chunk); size += chunk.byteLength;
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const page = decoder.decode(bytes);
    const title = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || null;
    const description = page.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i)?.[1] || null;
    const excerpt = page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 7500);
    return { url: target.toString(), fetchedAt: new Date().toISOString(), title, description, excerpt, truncated: size >= 180000 };
  }
  if (nodeId === 'github') {
    const token = await existingProviderToken(env, ownerId, 'github');
    return requestJson('https://api.github.com/user/repos?per_page=20&sort=updated', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Vela-Mesh', 'x-github-api-version': '2022-11-28' } });
  }
  if (nodeId === 'cloudflare') {
    const token = await existingProviderToken(env, ownerId, 'cloudflare');
    if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Cloudflare account ID is missing');
    return requestJson(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`, { headers: { authorization: `Bearer ${token}` } });
  }
  if (['gmail','drive','sheets','youtube'].includes(nodeId)) {
    const token = await existingProviderToken(env, ownerId, 'google');
    const headers = { authorization: `Bearer ${token}` };
    if (nodeId === 'gmail') {
      const list = await requestJson('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=8', { headers });
      const ids = (list.messages || []).slice(0, 8).map((x: any) => x.id);
      const messages = await Promise.all(ids.map((id: string) => requestJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers }).catch(() => null)));
      return messages.filter(Boolean);
    }
    if (nodeId === 'drive') return requestJson('https://www.googleapis.com/drive/v3/files?pageSize=20&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime,webViewLink)', { headers });
    if (nodeId === 'youtube') return requestJson('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers });
    return { goal, note: 'Sheets source requires a spreadsheetId and range in connector configuration.' };
  }
  if (['openrouter','openai','anthropic','gemini','workers-ai','custom-ai'].includes(nodeId)) return { goal, instruction: 'Use the connected AI provider as a reasoning node.' };
  if (nodeId === 'stripe') {
    const { secret } = await meshCredential(env, ownerId, nodeId);
    const headers = { authorization: `Bearer ${secret}` };
    const [account, balance] = await Promise.all([requestJson('https://api.stripe.com/v1/account', { headers }), requestJson('https://api.stripe.com/v1/balance', { headers })]);
    return { account, balance };
  }
  if (nodeId === 'shopify') {
    const { secret, config } = await meshCredential(env, ownerId, nodeId);
    const shop = String(config.shop || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return requestJson(`https://${shop}/admin/api/2026-07/products.json?limit=20`, { headers: { 'x-shopify-access-token': secret } });
  }
  if (nodeId === 'reddit') {
    const { secret } = await meshCredential(env, ownerId, nodeId);
    return requestJson('https://oauth.reddit.com/best?limit=20', { headers: { authorization: `Bearer ${secret}`, 'user-agent': 'VelaMesh/1.0' } });
  }
  if (nodeId === 'webhook') {
    const { secret, config } = await meshCredential(env, ownerId, nodeId);
    const url = String(config.url || '');
    return requestJson(url, { headers: secret ? { authorization: `Bearer ${secret}` } : undefined });
  }
  const cred = await meshCredential(env, ownerId, nodeId).catch(() => null);
  if (cred?.config?.readUrl && /^https:\/\//i.test(String(cred.config.readUrl))) return requestJson(String(cred.config.readUrl), { headers: cred.secret ? { authorization: `Bearer ${cred.secret}` } : undefined });
  return { node: nodeId, goal, status: cred ? 'connected' : 'available' };
}

async function workspaceAI(env: MeshEnv, ownerId: string, prompt: string): Promise<string> {
  let settings: any = null;
  if (env.DB) settings = await env.DB.prepare('SELECT * FROM workspace_settings WHERE owner_id=?').bind(ownerId).first<any>();
  const tryDecrypt = async (value: string | null | undefined) => value ? await decryptSecret(value, env).catch(() => '') : '';
  const active = String(settings?.active_provider || 'auto');
  const order = active !== 'auto' ? [active, 'openrouter', 'workers-ai'] : ['openrouter', 'workers-ai', 'openai', 'anthropic', 'gemini'];
  const seen = new Set<string>();
  for (const provider of order) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    try {
      if (provider === 'openrouter') {
        const key = await tryDecrypt(settings?.openrouter_key_ciphertext) || env.OPENROUTER_API_KEY || '';
        if (!key) continue;
        const model = settings?.openrouter_model || env.OPENROUTER_MODEL || 'openai/gpt-oss-120b';
        const body = await requestJson('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }) });
        return String(body.choices?.[0]?.message?.content || '');
      }
      if (provider === 'workers-ai' && env.AI) {
        const result = await env.AI.run((settings?.cf_ai_model || '@cf/meta/llama-3.1-8b-instruct-fast') as any, { messages: [{ role: 'user', content: prompt }], max_tokens: 1800 } as any) as any;
        return String(result?.response || result || '');
      }
      if (provider === 'openai') {
        const key = await tryDecrypt(settings?.openai_key_ciphertext) || env.OPENAI_API_KEY || '';
        if (!key) continue;
        const body = await requestJson('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: settings?.openai_model || env.OPENAI_MODEL || 'gpt-5', messages: [{ role: 'user', content: prompt }] }) });
        return String(body.choices?.[0]?.message?.content || '');
      }
      if (provider === 'anthropic') {
        const key = await tryDecrypt(settings?.anthropic_key_ciphertext) || env.ANTHROPIC_API_KEY || '';
        if (!key) continue;
        const body = await requestJson('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: settings?.anthropic_model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514', max_tokens: 1800, messages: [{ role: 'user', content: prompt }] }) });
        return String(body.content?.[0]?.text || '');
      }
      if (provider === 'gemini') {
        const key = await tryDecrypt(settings?.gemini_key_ciphertext) || env.GEMINI_API_KEY || '';
        if (!key) continue;
        const model = settings?.gemini_model || env.GEMINI_MODEL || 'gemini-2.5-flash';
        const body = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
        return String(body.candidates?.[0]?.content?.parts?.[0]?.text || '');
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'mesh_ai_provider_failed', provider, reason: error instanceof Error ? error.message : String(error) }));
    }
  }
  return JSON.stringify({ note: 'No AI provider was available; source data passed through unchanged.', prompt: prompt.slice(0, 1200) });
}

async function deliverNode(env: MeshEnv, ownerId: string, nodeId: string, payload: string, capabilities: string[]): Promise<any> {
  if (['openrouter','openai','anthropic','gemini','workers-ai','custom-ai'].includes(nodeId)) return { delivered: true, type: 'ai-result', preview: payload.slice(0, 800) };
  const canCreate = capabilities.includes('Create') || capabilities.includes('Modify') || capabilities.includes('Execute');
  const canExecute = capabilities.includes('Execute');
  if (!canCreate) return { delivered: false, prepared: true, reason: 'Link is observe/analyze only', preview: payload.slice(0, 800) };
  if (nodeId === 'webhook') {
    const { secret, config } = await meshCredential(env, ownerId, nodeId);
    const url = String(config.url || '');
    if (!/^https:\/\//i.test(url)) throw new Error('Webhook destination requires HTTPS URL');
    if (!canExecute) return { delivered: false, prepared: true, reason: 'Enable Execute to POST to webhook', preview: payload.slice(0, 800) };
    return requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ source: 'vela-mesh', payload }) });
  }
  if (['gmail','drive','sheets'].includes(nodeId)) {
    const token = await existingProviderToken(env, ownerId, 'google');
    const configRow = await env.DB!.prepare('SELECT public_config_json FROM mesh_credentials WHERE owner_id=? AND node_id=?').bind(ownerId, nodeId).first<{ public_config_json: string | null }>();
    const config = parseJson<Record<string, any>>(configRow?.public_config_json, {});
    if (nodeId === 'drive') {
      const metadata = { name: String(config.filename || `vela-${new Date().toISOString().slice(0,10)}.txt`), mimeType: 'text/plain' };
      const boundary = `vela-${crypto.randomUUID()}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${payload}\r\n--${boundary}--`;
      return requestJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body });
    }
    if (nodeId === 'gmail') {
      const to = String(config.to || '');
      if (!to) return { delivered: false, prepared: true, reason: 'Set a Gmail recipient in connector configuration', preview: payload.slice(0, 800) };
      const subject = String(config.subject || 'Vela automation result');
      const mime = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${payload}`;
      const raw = base64Url(encoder.encode(mime));
      if (canExecute && config.send === true) return requestJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw }) });
      return requestJson('https://gmail.googleapis.com/gmail/v1/users/me/drafts', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw } }) });
    }
    const spreadsheetId = String(config.spreadsheetId || '');
    const range = String(config.range || 'Sheet1!A:A');
    if (!spreadsheetId) return { delivered: false, prepared: true, reason: 'Set spreadsheetId in Sheets connector configuration', preview: payload.slice(0, 800) };
    return requestJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: [[payload]] }) });
  }
  if (nodeId === 'github') {
    const token = await existingProviderToken(env, ownerId, 'github');
    const configRow = await env.DB!.prepare('SELECT public_config_json FROM mesh_credentials WHERE owner_id=? AND node_id=?').bind(ownerId, nodeId).first<{ public_config_json: string | null }>();
    const config = parseJson<Record<string, any>>(configRow?.public_config_json, {});
    if (!config.repo) return { delivered: false, prepared: true, reason: 'Set repo (owner/name) in GitHub connector configuration', preview: payload.slice(0, 800) };
    return requestJson(`https://api.github.com/repos/${config.repo}/issues`, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'Vela-Mesh', 'x-github-api-version': '2022-11-28' }, body: JSON.stringify({ title: String(config.issueTitle || 'Vela automation result'), body: payload }) });
  }
  const cred = await meshCredential(env, ownerId, nodeId).catch(() => null);
  if (cred?.config?.writeUrl && /^https:\/\//i.test(String(cred.config.writeUrl))) {
    if (!canExecute) return { delivered: false, prepared: true, reason: 'Enable Execute to call configured write endpoint', preview: payload.slice(0, 800) };
    return requestJson(String(cred.config.writeUrl), { method: String(cred.config.writeMethod || 'POST'), headers: { 'content-type': 'application/json', ...(cred.secret ? { authorization: `Bearer ${cred.secret}` } : {}) }, body: JSON.stringify({ payload }) });
  }
  return { delivered: false, prepared: true, reason: `${nodeId} has no configured write target yet`, preview: payload.slice(0, 800) };
}

async function runMesh(env: MeshEnv, ownerId: string): Promise<any> {
  await ensureSchema(env);
  const workspace = await env.DB!.prepare('SELECT goal FROM mesh_workspaces WHERE owner_id=?').bind(ownerId).first<{ goal: string }>();
  const goal = workspace?.goal || 'Move useful information through the connected services.';
  const linkRows = await env.DB!.prepare('SELECT * FROM mesh_links WHERE owner_id=? AND enabled=1 ORDER BY created_at ASC').bind(ownerId).all<MeshLink>();
  const links = linkRows.results || [];
  if (!links.length) throw new Error('Connect at least two services first');
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.DB!.prepare('INSERT INTO mesh_runs(id,owner_id,goal,status,started_at) VALUES(?,?,?,?,?)').bind(runId, ownerId, goal, 'running', startedAt).run();
  const results: any[] = [];
  try {
    for (const link of links) {
      const capabilities = parseJson<string[]>(link.capabilities_json, ['Observe','Analyze']);
      await recordEvent(env, ownerId, runId, link.from_node, 'link_started', { linkId: link.id, from: link.from_node, to: link.to_node, capabilities });
      const observed = await observeNode(env, ownerId, link.from_node, goal);
      await recordEvent(env, ownerId, runId, link.from_node, 'observed', { preview: JSON.stringify(observed).slice(0, 1600) });
      const shouldReason = capabilities.some(x => ['Analyze','Create','Modify','Execute'].includes(x));
      const transformed = shouldReason ? await workspaceAI(env, ownerId, `You are the orchestration brain for a universal internet automation mesh.\nGoal: ${goal}\nConnection: ${link.from_node} -> ${link.to_node}\nAuthority: ${capabilities.join(', ')}\nSource data:\n${JSON.stringify(observed).slice(0, 12000)}\nReturn the most useful destination-ready output. Do not invent facts.`) : JSON.stringify(observed, null, 2);
      await recordEvent(env, ownerId, runId, link.to_node, 'transformed', { preview: transformed.slice(0, 1600) });
      const delivery = await deliverNode(env, ownerId, link.to_node, transformed, capabilities);
      await recordEvent(env, ownerId, runId, link.to_node, 'delivered', delivery);
      results.push({ linkId: link.id, from: link.from_node, to: link.to_node, delivery });
    }
    const summary = { linksProcessed: results.length, results };
    await env.DB!.prepare('UPDATE mesh_runs SET status=?,summary_json=?,finished_at=? WHERE id=?').bind('complete', JSON.stringify(summary), new Date().toISOString(), runId).run();
    return { id: runId, status: 'complete', summary };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await env.DB!.prepare('UPDATE mesh_runs SET status=?,error=?,finished_at=? WHERE id=?').bind('failed', detail.slice(0, 3000), new Date().toISOString(), runId).run();
    await recordEvent(env, ownerId, runId, null, 'run_failed', { error: detail });
    throw new Error(`Mesh run failed: ${detail}`);
  }
}

async function startGoogleAuthorization(request: Request, env: MeshEnv): Promise<Response> {
  if (!env.DB || !env.GOOGLE_CLIENT_ID || !env.TOKEN_ENCRYPTION_KEY) return json({ error: 'Google OAuth is not configured' }, 503);
  await ensureSchema(env);
  let owner = await readOwner(request, env);
  let cookie: string | undefined;
  if (!owner) {
    const session = await issueSession(env);
    owner = session.id;
    cookie = session.cookie;
  }
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = base64Url(await sha256(verifier));
  const origin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).origin : new URL(request.url).origin;
  const redirectUri = `${origin}/auth/google/callback`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<=?').bind(new Date().toISOString()).run();
  await env.DB.prepare('INSERT INTO oauth_states(state_hash,provider,session_id,code_verifier_ciphertext,redirect_uri,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(base64Url(await sha256(state)), 'google', owner, await encryptSecret(JSON.stringify(verifier), env), redirectUri, expiresAt, new Date().toISOString()).run();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  const headers = securityHeaders(new Headers({ location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }));
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function html(): string {
  const nodes = JSON.stringify(NODES);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Vela Mesh</title><style>
*{box-sizing:border-box}body{margin:0;background:#07090d;color:#f5f7fb;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer}.top{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #222834;background:#07090df2;backdrop-filter:blur(14px)}.brand{font-weight:950;font-size:20px;letter-spacing:-.05em}.sub{color:#8994a7;font-size:10px;letter-spacing:.1em}.wrap{max-width:1280px;margin:auto;padding:20px}.hero{border:1px solid #222834;background:#0d1118;border-radius:18px;padding:20px}.hero h1{font-size:clamp(32px,7vw,66px);letter-spacing:-.065em;line-height:.95;margin:8px 0 12px}.hero p{color:#9aa5b8;max-width:760px;line-height:1.55}.goal{width:100%;min-height:72px;margin-top:14px;resize:vertical;background:#080b10;color:white;border:1px solid #2a3240;border-radius:12px;padding:12px}.notice{display:none;margin:14px 0;padding:11px 13px;border:1px solid #304055;background:#0d1721;color:#b9e8ff;border-radius:12px;font-size:13px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 10px}.search,.select,.field{min-height:44px;background:#080b10;color:white;border:1px solid #29313e;border-radius:10px;padding:0 12px}.search{flex:1 1 220px}.nodes{display:grid;grid-template-columns:repeat(auto-fill,minmax(142px,1fr));gap:9px}.node{min-height:98px;text-align:left;padding:12px;border:1px solid #29313e;border-radius:14px;background:#0c1016;color:white}.node.ready{border-color:#2f5b4a;background:#0d1915}.node.chosen{border-color:#69d5ff;background:#102330}.node-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.ico{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#161c26;font-size:11px;font-weight:900}.state{font-size:9px;color:#7f8998}.ready .state{color:#77ddb1}.node-name{font-weight:800;margin-top:9px}.node-desc{font-size:10px;color:#7f8998;margin-top:3px;line-height:1.25}.panel{margin-top:16px;display:grid;grid-template-columns:minmax(0,1fr);gap:14px}.card{border:1px solid #222834;border-radius:18px;background:#0b0e14;padding:15px}.card h2{font-size:16px;margin:0 0 10px}.links{display:grid;gap:8px}.link{border:1px solid #26303c;background:#0c1118;border-radius:12px;padding:12px}.link-head{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.chip{font-size:10px;border:1px solid #344153;border-radius:999px;padding:4px 7px;color:#aab5c8}.actions{display:flex;gap:7px;flex-wrap:wrap}.btn{min-height:40px;border:1px solid #344153;border-radius:10px;background:#111823;color:#eaf1fb;padding:0 12px}.btn.primary{background:#dff7ff;color:#061117;border-color:#dff7ff;font-weight:850}.btn.danger{color:#ffb8bd}.status{font-size:12px;color:#8e9bad}.activity{max-height:320px;overflow:auto;display:grid;gap:7px}.event{border-left:2px solid #344153;padding:7px 10px;background:#0a0e14;border-radius:0 8px 8px 0;font-size:12px;color:#aeb8c8}.modal{position:fixed;inset:0;background:#000b;display:none;place-items:center;padding:18px;z-index:50}.modal.open{display:grid}.modal-box{width:min(560px,100%);border:1px solid #354153;background:#0c1118;border-radius:18px;padding:18px}.modal-box h3{margin:0 0 7px}.form{display:grid;gap:9px;margin-top:12px}.field{width:100%}.hint{font-size:11px;color:#7f8998;line-height:1.4}.row{display:flex;gap:8px;flex-wrap:wrap}@media(min-width:850px){.panel{grid-template-columns:1.1fr .9fr}.wrap{padding:24px}.hero{padding:26px}}
</style></head><body><header class="top"><div><div class="brand">VELA</div><div class="sub">UNIVERSAL INTERNET MESH</div></div><div class="actions"><button class="btn" id="googleServices">Google services</button><button class="btn primary" id="run">Run mesh</button></div></header><main class="wrap"><section class="hero"><div class="sub" style="color:#70d7ff">THE WHOLE INTERFACE</div><h1>Click things together.</h1><p>Click a service. Click another service. Vela saves the connection, figures out the useful work between them, and runs it. Nothing else is required.</p><textarea id="goal" class="goal" placeholder="Optional goal — e.g. grow my YouTube channel, run my ecommerce business, watch competitors, publish content..."></textarea></section><div id="notice" class="notice"></div><div class="toolbar"><input id="search" class="search" placeholder="Search anything"><select id="group" class="select"></select></div><section id="nodes" class="nodes"></section><section class="panel"><div class="card"><h2>Connections</h2><div id="linkStatus" class="status">Click any two ready services.</div><div id="links" class="links" style="margin-top:10px"></div></div><div class="card"><div class="link-head"><h2>Activity</h2><button class="btn" id="refresh">Refresh</button></div><div id="activity" class="activity"><div class="status">No runs yet.</div></div></div></section></main><div id="modal" class="modal"><div class="modal-box"><div class="link-head"><div><h3 id="modalTitle">Connect</h3><div id="modalDesc" class="hint"></div></div><button class="btn" id="closeModal">Close</button></div><div class="form"><input id="secret" class="field" type="password" placeholder="API key / access token"><input id="configUrl" class="field" placeholder="API URL / shop domain / optional endpoint"><textarea id="configJson" class="goal" style="min-height:100px" placeholder='Optional settings JSON, e.g. {"to":"me@example.com"}'></textarea><div class="row"><button class="btn primary" id="saveConnector">Connect</button><button class="btn danger" id="disconnectConnector">Disconnect</button></div><div class="hint">Credentials are encrypted before storage. OAuth services use their provider authorization screen instead of this form.</div></div></div></div><script>
const NODE_DEFS=${nodes};let state={catalog:[],links:[],runs:[],goal:''};let selected=[];let modalNode=null;const q=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function api(path,opts){const r=await fetch(path,opts);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.reason||d.error||'Request failed');return d}function note(t){const n=q('#notice');n.textContent=t;n.style.display=t?'block':'none'}async function ensure(){await api('/session',{method:'POST'});await load()}async function load(){state=await api('/mesh/state');q('#goal').value=state.goal||'';render();renderActivity()}function groups(){return ['All',...new Set(NODE_DEFS.map(n=>n.group))]}function render(){const g=q('#group');if(!g.dataset.init){g.innerHTML=groups().map(x=>'<option>'+esc(x)+'</option>').join('');g.dataset.init='1'}const term=q('#search').value.toLowerCase();const group=g.value||'All';const catalog=new Map(state.catalog.map(n=>[n.id,n]));q('#nodes').innerHTML=NODE_DEFS.filter(n=>(group==='All'||n.group===group)&&(!term||(n.name+' '+n.group+' '+n.description).toLowerCase().includes(term))).map(n=>{const s=catalog.get(n.id)||n;const chosen=selected.includes(n.id);return '<button class="node '+(s.ready?'ready ':'')+(chosen?'chosen':'')+'" data-node="'+esc(n.id)+'"><div class="node-top"><span class="ico">'+esc(n.icon)+'</span><span class="state">'+(s.ready?'READY':'CONNECT')+'</span></div><div class="node-name">'+esc(n.name)+'</div><div class="node-desc">'+esc(n.description)+'</div></button>'}).join('');q('#nodes').querySelectorAll('[data-node]').forEach(b=>b.addEventListener('click',()=>choose(b.dataset.node)));q('#linkStatus').textContent=selected.length===1?(nameOf(selected[0])+' → click another thing'):'Click any two ready services.';q('#links').innerHTML=state.links.length?state.links.map(l=>'<div class="link"><div class="link-head"><strong>'+esc(nameOf(l.from))+' → '+esc(nameOf(l.to))+'</strong><div class="actions"><button class="btn" data-power="'+esc(l.id)+'">'+(l.capabilities.includes('Execute')?'Actions allowed':'Allow actions')+'</button><button class="btn danger" data-del="'+esc(l.id)+'">Remove</button></div></div><div class="chips">'+l.capabilities.map(c=>'<span class="chip">'+esc(c)+'</span>').join('')+'</div></div>').join(''):'<div class="status">No connections yet.</div>';q('#links').querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',()=>removeLink(b.dataset.del)));q('#links').querySelectorAll('[data-power]').forEach(b=>b.addEventListener('click',()=>togglePower(b.dataset.power)))}function nameOf(id){return NODE_DEFS.find(n=>n.id===id)?.name||id}function live(id){return state.catalog.find(n=>n.id===id)}async function choose(id){const n=live(id)||NODE_DEFS.find(x=>x.id===id);if(!n.ready){if(n.mode==='oauth'){location.href='/auth/'+id+'/start';return}if(n.mode==='google'){location.href='/auth/google/start';return}if(n.mode==='ai'){note('Open AI Toolbox settings in the legacy studio to add this provider, or use Workers AI which is native.');return}openConnector(id);return}if(selected.includes(id)){selected=selected.filter(x=>x!==id);render();return}selected.push(id);if(selected.length===2){const [from,to]=selected;selected=[];try{await api('/mesh/links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from,to})});note(nameOf(from)+' connected to '+nameOf(to));await load()}catch(e){note(e.message)}}else render()}async function removeLink(id){await api('/mesh/links/'+encodeURIComponent(id),{method:'DELETE'});await load()}async function togglePower(id){const l=state.links.find(x=>x.id===id);const capabilities=l.capabilities.includes('Execute')?['Observe','Analyze']:['Observe','Analyze','Create','Modify','Execute'];await api('/mesh/links/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({capabilities})});await load()}function openConnector(id){modalNode=NODE_DEFS.find(n=>n.id===id);q('#modalTitle').textContent='Connect '+modalNode.name;q('#modalDesc').textContent=modalNode.description;q('#secret').value='';const existing=live(id)?.config||{};q('#configUrl').value=existing.url||existing.shop||existing.testUrl||'';q('#configJson').value=Object.keys(existing).length?JSON.stringify(existing,null,2):'';q('#modal').classList.add('open')}async function saveConnector(){if(!modalNode)return;let cfg={};try{cfg=q('#configJson').value.trim()?JSON.parse(q('#configJson').value):{}}catch{return note('Settings JSON is invalid')}const v=q('#configUrl').value.trim();if(v){if(modalNode.id==='shopify')cfg.shop=v;else if(modalNode.id==='webhook')cfg.url=v;else cfg.testUrl=v}try{const d=await api('/mesh/connect/'+encodeURIComponent(modalNode.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:q('#secret').value,config:cfg})});note(d.detail||'Connected');q('#modal').classList.remove('open');await load()}catch(e){note(e.message)}}async function disconnect(){if(!modalNode)return;await api('/mesh/connect/'+encodeURIComponent(modalNode.id),{method:'DELETE'});q('#modal').classList.remove('open');await load()}async function run(){q('#run').disabled=true;note('Running the mesh…');try{const d=await api('/mesh/run',{method:'POST'});note('Run complete · '+d.summary.linksProcessed+' connection'+(d.summary.linksProcessed===1?'':'s')+' processed');await load()}catch(e){note(e.message)}finally{q('#run').disabled=false}}function renderActivity(){const root=q('#activity');if(!state.runs?.length){root.innerHTML='<div class="status">No runs yet.</div>';return}root.innerHTML=state.runs.map(r=>'<div class="event"><strong>'+esc(r.status.toUpperCase())+'</strong> · '+esc(new Date(r.started_at).toLocaleString())+(r.error?'<div>'+esc(r.error)+'</div>':'')+(r.summary?'<div>'+esc(r.summary.linksProcessed)+' links processed</div>':'')+'</div>').join('')}let goalTimer;q('#goal').addEventListener('input',()=>{clearTimeout(goalTimer);goalTimer=setTimeout(async()=>{try{await api('/mesh/goal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({goal:q('#goal').value})})}catch(e){note(e.message)}},500)});q('#search').addEventListener('input',render);q('#group').addEventListener('change',render);q('#refresh').addEventListener('click',load);q('#run').addEventListener('click',run);q('#googleServices').addEventListener('click',()=>location.href='/auth/google/start');q('#closeModal').addEventListener('click',()=>q('#modal').classList.remove('open'));q('#saveConnector').addEventListener('click',saveConnector);q('#disconnectConnector').addEventListener('click',disconnect);ensure().catch(e=>note(e.message));
</script></body></html>`;
}

export async function handleMeshRequest(request: Request, env: MeshEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/auth/google/start' && request.method === 'GET') return startGoogleAuthorization(request, env);
  if (url.pathname === '/' && request.method === 'GET') return new Response(html(), { headers: securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })) });
  if (!url.pathname.startsWith('/mesh/')) return null;
  await ensureSchema(env);
  const ownerId = await readOwner(request, env);
  if (!ownerId) return json({ error: 'Start a workspace first.' }, 401);

  if (url.pathname === '/mesh/state' && request.method === 'GET') return json(await stateFor(env, ownerId));

  if (url.pathname === '/mesh/goal' && request.method === 'POST') {
    const body = await request.json<{ goal?: string }>().catch(() => ({}));
    const goal = String(body.goal || '').slice(0, 5000);
    const now = new Date().toISOString();
    await env.DB!.prepare(`INSERT INTO mesh_workspaces(owner_id,goal,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET goal=excluded.goal,updated_at=excluded.updated_at`).bind(ownerId, goal, now).run();
    return json({ ok: true });
  }

  if (url.pathname === '/mesh/links' && request.method === 'POST') {
    const body = await request.json<{ from?: string; to?: string; capabilities?: string[] }>().catch(() => ({}));
    const from = String(body.from || '');
    const to = String(body.to || '');
    if (!NODES.some(n => n.id === from) || !NODES.some(n => n.id === to) || from === to) return json({ error: 'Choose two different supported services' }, 400);
    const existing = await env.DB!.prepare('SELECT id FROM mesh_links WHERE owner_id=? AND from_node=? AND to_node=?').bind(ownerId, from, to).first<{ id: string }>();
    if (existing) return json({ ok: true, id: existing.id });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const caps = Array.isArray(body.capabilities) && body.capabilities.length ? body.capabilities : ['Observe','Analyze'];
    await env.DB!.prepare('INSERT INTO mesh_links(id,owner_id,from_node,to_node,capabilities_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').bind(id, ownerId, from, to, JSON.stringify(caps), now, now).run();
    return json({ ok: true, id }, 201);
  }

  const linkMatch = url.pathname.match(/^\/mesh\/links\/([^/]+)$/);
  if (linkMatch && request.method === 'DELETE') {
    await env.DB!.prepare('DELETE FROM mesh_links WHERE id=? AND owner_id=?').bind(linkMatch[1], ownerId).run();
    return json({ ok: true });
  }
  if (linkMatch && request.method === 'PATCH') {
    const body = await request.json<{ capabilities?: string[]; enabled?: boolean }>().catch(() => ({}));
    const allowed = ['Observe','Analyze','Create','Modify','Execute'];
    const caps = Array.isArray(body.capabilities) ? body.capabilities.filter(x => allowed.includes(x)) : null;
    if (caps) await env.DB!.prepare('UPDATE mesh_links SET capabilities_json=?,updated_at=? WHERE id=? AND owner_id=?').bind(JSON.stringify(caps), new Date().toISOString(), linkMatch[1], ownerId).run();
    if (typeof body.enabled === 'boolean') await env.DB!.prepare('UPDATE mesh_links SET enabled=?,updated_at=? WHERE id=? AND owner_id=?').bind(body.enabled ? 1 : 0, new Date().toISOString(), linkMatch[1], ownerId).run();
    return json({ ok: true });
  }

  const connectMatch = url.pathname.match(/^\/mesh\/connect\/([a-z0-9-]+)$/);
  if (connectMatch && request.method === 'POST') {
    const nodeId = connectMatch[1];
    const node = NODES.find(n => n.id === nodeId);
    if (!node) return json({ error: 'Unknown connector' }, 404);
    const body = await request.json<{ secret?: string; config?: Record<string, any> }>().catch(() => ({}));
    const secret = String(body.secret || '');
    const config = body.config && typeof body.config === 'object' ? body.config : {};
    if (node.mode === 'credential' && !secret && nodeId !== 'webhook') return json({ error: 'API key or access token is required' }, 400);
    const result = await testCredential(nodeId, secret, config);
    const now = new Date().toISOString();
    await env.DB!.prepare(`INSERT INTO mesh_credentials(owner_id,node_id,secret_ciphertext,public_config_json,status,last_tested_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,node_id) DO UPDATE SET secret_ciphertext=CASE WHEN excluded.secret_ciphertext IS NULL THEN mesh_credentials.secret_ciphertext ELSE excluded.secret_ciphertext END,public_config_json=excluded.public_config_json,status=excluded.status,last_tested_at=excluded.last_tested_at,updated_at=excluded.updated_at`)
      .bind(ownerId, nodeId, secret ? await encryptSecret(secret, env) : null, JSON.stringify(config), 'connected', now, now, now).run();
    return json({ ok: true, detail: result.detail });
  }
  if (connectMatch && request.method === 'DELETE') {
    await env.DB!.prepare('DELETE FROM mesh_credentials WHERE owner_id=? AND node_id=?').bind(ownerId, connectMatch[1]).run();
    return json({ ok: true });
  }

  if (url.pathname === '/mesh/run' && request.method === 'POST') return json(await runMesh(env, ownerId));

  const runMatch = url.pathname.match(/^\/mesh\/runs\/([^/]+)$/);
  if (runMatch && request.method === 'GET') {
    const run = await env.DB!.prepare('SELECT * FROM mesh_runs WHERE id=? AND owner_id=?').bind(runMatch[1], ownerId).first<any>();
    if (!run) return json({ error: 'Run not found' }, 404);
    const events = await env.DB!.prepare('SELECT node_id,kind,detail_json,created_at FROM mesh_events WHERE run_id=? AND owner_id=? ORDER BY created_at ASC').bind(runMatch[1], ownerId).all<any>();
    return json({ run: { ...run, summary: parseJson(run.summary_json, null) }, events: (events.results || []).map((e: any) => ({ ...e, detail: parseJson(e.detail_json, null) })) });
  }

  return json({ error: 'Mesh route not found' }, 404);
}
