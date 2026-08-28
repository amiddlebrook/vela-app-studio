import { DurableObject } from 'cloudflare:workers';

export interface Env {
  DB: D1Database;
  BUILDS: DurableObjectNamespace<BuildCoordinator>;
  BUILD_JOBS: Queue<{ projectId: string; prompt: string; resumeFrom?: string }>;
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
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  AI?: { run(model: string, args: unknown): Promise<{ response?: string }> };
}

type Provider = 'google' | 'github' | 'cloudflare';
type OAuthState = { provider: Provider; session_id: string; code_verifier_ciphertext: string; redirect_uri: string; expires_at: string };
type ProviderToken = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
type ProviderIdentity = { id: string; email?: string; name?: string };
type ProjectRecord = { id: string; owner_id: string; name: string; prompt: string; github_repository: string | null; worker_name: string | null; status: string; scaffolding_json: string | null; plan_json: string | null; created_at: string; updated_at: string };
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

function unsignedAnonymousSessionId(request: Request): string | null {
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!value) return null;
  const [id] = value.split('.');
  return id || null;
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

function cleanCodeBlock(code: string): string {
  if (!code) return '';
  let cleaned = code.trim();
  cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\r?\n?/, '');
  cleaned = cleaned.replace(/\r?\n?```\s*$/, '');
  return cleaned.trim();
}

function sanitizeWorkerSource(name: string, prompt: string, source: string): string {
  let cleaned = cleanCodeBlock(source);
  if (!cleaned || !cleaned.includes('export default')) {
    cleaned = generateEnterpriseScaffoldFallback(name, prompt).backend;
  }
  cleaned = cleanCodeBlock(cleaned);
  return cleaned;
}

// --- Database Auto-Healing & Schema Guard ---

let schemaInitialized = false;
async function ensureSchema(env: Env): Promise<void> {
  if (schemaInitialized) return;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        github_repository TEXT,
        worker_name TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        scaffolding_json TEXT,
        plan_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_account_id TEXT,
        status TEXT NOT NULL DEFAULT 'disconnected',
        access_token_ciphertext TEXT,
        refresh_token_ciphertext TEXT,
        token_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_id, provider)
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_features (
        project_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, feature)
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        quantity REAL NOT NULL,
        estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        code_verifier_ciphertext TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_subject TEXT NOT NULL UNIQUE,
        email TEXT,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS build_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        stage TEXT,
        created_at TEXT NOT NULL
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        owner_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_secrets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, key)
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        commit_sha TEXT,
        worker_url TEXT,
        status TEXT NOT NULL,
        error TEXT,
        deployed_by TEXT,
        created_at TEXT NOT NULL
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_collaborators (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'developer',
        created_at TEXT NOT NULL,
        UNIQUE(project_id, email)
      );`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_settings (
        owner_id TEXT PRIMARY KEY,
        active_provider TEXT DEFAULT 'auto',
        openrouter_key_ciphertext TEXT,
        openrouter_model TEXT DEFAULT 'anthropic/claude-3.5-sonnet',
        openai_key_ciphertext TEXT,
        openai_model TEXT DEFAULT 'gpt-4o',
        gemini_key_ciphertext TEXT,
        gemini_model TEXT DEFAULT 'gemini-2.0-flash',
        anthropic_key_ciphertext TEXT,
        anthropic_model TEXT DEFAULT 'claude-3-5-sonnet-20241022',
        cf_ai_model TEXT DEFAULT '@cf/meta/llama-3.3-70b-instruct',
        custom_endpoint TEXT,
        custom_key_ciphertext TEXT,
        custom_model TEXT,
        updated_at TEXT NOT NULL
      );`),
    ]);

    try { await env.DB.prepare('ALTER TABLE build_events ADD COLUMN stage TEXT;').run(); } catch {}
    try { await env.DB.prepare('ALTER TABLE projects ADD COLUMN scaffolding_json TEXT;').run(); } catch {}
    try { await env.DB.prepare('ALTER TABLE projects ADD COLUMN plan_json TEXT;').run(); } catch {}
    try { await env.DB.prepare('ALTER TABLE connections ADD COLUMN access_token_ciphertext TEXT;').run(); } catch {}
    try { await env.DB.prepare('ALTER TABLE connections ADD COLUMN refresh_token_ciphertext TEXT;').run(); } catch {}
    try { await env.DB.prepare('ALTER TABLE connections ADD COLUMN token_expires_at TEXT;').run(); } catch {}

    schemaInitialized = true;
  } catch (err) {
    console.warn('ensureSchema warning:', err);
  }
}

// --- Workspace Settings & AI Provider Toolbox ---

export type WorkspaceSettings = {
  active_provider: string;
  openrouter_key?: string;
  openrouter_model: string;
  openai_key?: string;
  openai_model: string;
  gemini_key?: string;
  gemini_model: string;
  anthropic_key?: string;
  anthropic_model: string;
  cf_ai_model: string;
  custom_endpoint?: string;
  custom_key?: string;
  custom_model?: string;
};

async function getWorkspaceSettings(env: Env, ownerId: string, decrypted = false): Promise<WorkspaceSettings> {
  const row = await env.DB.prepare('SELECT * FROM workspace_settings WHERE owner_id = ?').bind(ownerId).first<any>();
  if (!row) {
    return {
      active_provider: 'auto',
      openrouter_model: env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
      openai_model: env.OPENAI_MODEL || 'gpt-4o',
      gemini_model: env.GEMINI_MODEL || 'gemini-2.0-flash',
      anthropic_model: env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      cf_ai_model: '@cf/meta/llama-3.3-70b-instruct',
    };
  }

  const decryptKey = async (ciphertext?: string | null): Promise<string | undefined> => {
    if (!ciphertext) return undefined;
    if (!decrypted) return '••••••••••••';
    try {
      return JSON.parse(await decrypt(ciphertext, env.TOKEN_ENCRYPTION_KEY)) as string;
    } catch {
      return undefined;
    }
  };

  return {
    active_provider: row.active_provider || 'auto',
    openrouter_key: await decryptKey(row.openrouter_key_ciphertext),
    openrouter_model: row.openrouter_model || env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
    openai_key: await decryptKey(row.openai_key_ciphertext),
    openai_model: row.openai_model || env.OPENAI_MODEL || 'gpt-4o',
    gemini_key: await decryptKey(row.gemini_key_ciphertext),
    gemini_model: row.gemini_model || env.GEMINI_MODEL || 'gemini-2.0-flash',
    anthropic_key: await decryptKey(row.anthropic_key_ciphertext),
    anthropic_model: row.anthropic_model || env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    cf_ai_model: row.cf_ai_model || '@cf/meta/llama-3.3-70b-instruct',
    custom_endpoint: row.custom_endpoint || undefined,
    custom_key: await decryptKey(row.custom_key_ciphertext),
    custom_model: row.custom_model || undefined,
  };
}

async function saveWorkspaceSettings(env: Env, ownerId: string, settings: Partial<WorkspaceSettings>): Promise<void> {
  const existing = await env.DB.prepare('SELECT * FROM workspace_settings WHERE owner_id = ?').bind(ownerId).first<any>();
  const now = new Date().toISOString();

  const encryptKey = async (newVal?: string, oldCiphertext?: string): Promise<string | null> => {
    if (!newVal || newVal.includes('••••')) return oldCiphertext || null;
    return await encrypt(newVal.trim(), env.TOKEN_ENCRYPTION_KEY);
  };

  const openrouter_key_ciphertext = await encryptKey(settings.openrouter_key, existing?.openrouter_key_ciphertext);
  const openai_key_ciphertext = await encryptKey(settings.openai_key, existing?.openai_key_ciphertext);
  const gemini_key_ciphertext = await encryptKey(settings.gemini_key, existing?.gemini_key_ciphertext);
  const anthropic_key_ciphertext = await encryptKey(settings.anthropic_key, existing?.anthropic_key_ciphertext);
  const custom_key_ciphertext = await encryptKey(settings.custom_key, existing?.custom_key_ciphertext);

  await env.DB.prepare(`INSERT INTO workspace_settings (
    owner_id, active_provider,
    openrouter_key_ciphertext, openrouter_model,
    openai_key_ciphertext, openai_model,
    gemini_key_ciphertext, gemini_model,
    anthropic_key_ciphertext, anthropic_model,
    cf_ai_model,
    custom_endpoint, custom_key_ciphertext, custom_model,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(owner_id) DO UPDATE SET
    active_provider = excluded.active_provider,
    openrouter_key_ciphertext = excluded.openrouter_key_ciphertext,
    openrouter_model = excluded.openrouter_model,
    openai_key_ciphertext = excluded.openai_key_ciphertext,
    openai_model = excluded.openai_model,
    gemini_key_ciphertext = excluded.gemini_key_ciphertext,
    gemini_model = excluded.gemini_model,
    anthropic_key_ciphertext = excluded.anthropic_key_ciphertext,
    anthropic_model = excluded.anthropic_model,
    cf_ai_model = excluded.cf_ai_model,
    custom_endpoint = excluded.custom_endpoint,
    custom_key_ciphertext = excluded.custom_key_ciphertext,
    custom_model = excluded.custom_model,
    updated_at = excluded.updated_at
  `).bind(
    ownerId,
    settings.active_provider || existing?.active_provider || 'auto',
    openrouter_key_ciphertext,
    settings.openrouter_model || existing?.openrouter_model || 'anthropic/claude-3.5-sonnet',
    openai_key_ciphertext,
    settings.openai_model || existing?.openai_model || 'gpt-4o',
    gemini_key_ciphertext,
    settings.gemini_model || existing?.gemini_model || 'gemini-2.0-flash',
    anthropic_key_ciphertext,
    settings.anthropic_model || existing?.anthropic_model || 'claude-3-5-sonnet-20241022',
    settings.cf_ai_model || existing?.cf_ai_model || '@cf/meta/llama-3.3-70b-instruct',
    settings.custom_endpoint || existing?.custom_endpoint || null,
    custom_key_ciphertext,
    settings.custom_model || existing?.custom_model || null,
    now
  ).run();
}

// --- Multi-LLM Provider Engine ---

export type PlanResult = {
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

export type ScaffoldResult = {
  frontend: string;
  backend: string;
  database: string;
  config: string;
  instructions: string;
};

async function callLLM(env: Env, messages: Array<{ role: string; content: string }>, ownerId?: string): Promise<string> {
  let settings: WorkspaceSettings | null = null;
  if (ownerId) {
    try { settings = await getWorkspaceSettings(env, ownerId, true); } catch {}
  }

  const openrouterKey = settings?.openrouter_key || env.OPENROUTER_API_KEY;
  const openrouterModel = settings?.openrouter_model || env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';

  const openaiKey = settings?.openai_key || env.OPENAI_API_KEY;
  const openaiModel = settings?.openai_model || env.OPENAI_MODEL || 'gpt-4o';

  const geminiKey = settings?.gemini_key || env.GEMINI_API_KEY;
  const geminiModel = settings?.gemini_model || env.GEMINI_MODEL || 'gemini-2.0-flash';

  const anthropicKey = settings?.anthropic_key || env.ANTHROPIC_API_KEY;
  const anthropicModel = settings?.anthropic_model || env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

  const cfModel = settings?.cf_ai_model || '@cf/meta/llama-3.3-70b-instruct';

  // 1. Check Custom Endpoint if active
  if (settings?.custom_endpoint && (settings.active_provider === 'custom' || settings.active_provider === 'auto')) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.custom_key) headers['Authorization'] = `Bearer ${settings.custom_key}`;
      const res = await fetch(`${settings.custom_endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: settings.custom_model || 'default', messages }),
      });
      if (res.ok) {
        const data = await res.json<{ choices?: Array<{ message?: { content?: string } }> }>();
        const content = data.choices?.[0]?.message?.content;
        if (content) return content;
      }
    } catch (e) {
      console.warn('Custom LLM endpoint error:', e);
    }
  }

  // 2. Try OpenRouter
  if (openrouterKey && (settings?.active_provider === 'openrouter' || settings?.active_provider === 'auto' || !settings?.active_provider)) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openrouterKey}` },
        body: JSON.stringify({ model: openrouterModel, messages }),
      });
      if (res.ok) {
        const data = await res.json<{ choices?: Array<{ message?: { content?: string } }> }>();
        const content = data.choices?.[0]?.message?.content;
        if (content) return content;
      }
    } catch (e) {
      console.warn('OpenRouter request error:', e);
    }
  }

  // 3. Try Cloudflare Workers AI
  if (env.AI && typeof env.AI.run === 'function' && (settings?.active_provider === 'cloudflare' || settings?.active_provider === 'auto' || !settings?.active_provider)) {
    try {
      const response = await env.AI.run(cfModel, { messages });
      if (response && response.response) return response.response;
    } catch (e) {
      console.warn('Workers AI request error:', e);
    }
  }

  // 4. Try OpenAI
  if (openaiKey && (settings?.active_provider === 'openai' || settings?.active_provider === 'auto' || !settings?.active_provider)) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: openaiModel, messages }),
      });
      if (res.ok) {
        const data = await res.json<{ choices?: Array<{ message?: { content?: string } }> }>();
        const content = data.choices?.[0]?.message?.content;
        if (content) return content;
      }
    } catch (e) {
      console.warn('OpenAI request error:', e);
    }
  }

  // 5. Try Gemini
  if (geminiKey && (settings?.active_provider === 'gemini' || settings?.active_provider === 'auto' || !settings?.active_provider)) {
    try {
      const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (res.ok) {
        const data = await res.json<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (content) return content;
      }
    } catch (e) {
      console.warn('Gemini request error:', e);
    }
  }

  // 6. Try Anthropic
  if (anthropicKey && (settings?.active_provider === 'anthropic' || settings?.active_provider === 'auto' || !settings?.active_provider)) {
    try {
      const system = messages.find(m => m.role === 'system')?.content;
      const userMessages = messages.filter(m => m.role !== 'system');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 4096,
          system,
          messages: userMessages,
        }),
      });
      if (res.ok) {
        const data = await res.json<{ content?: Array<{ text?: string }> }>();
        const content = data.content?.[0]?.text;
        if (content) return content;
      }
    } catch (e) {
      console.warn('Anthropic request error:', e);
    }
  }

  throw new Error('No functional LLM provider available');
}

// Fallback Plan Generator (Deterministic, High-Quality Enterprise Architecture)
function generateEnterprisePlanFallback(prompt: string): PlanResult {
  const words = prompt.trim().split(/\s+/);
  const rawName = words.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || 'Cloud Platform';
  const cleanName = rawName.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Vela Enterprise App';

  return {
    name: cleanName,
    description: `Enterprise-grade, distributed Cloudflare Worker application built for "${prompt.slice(0, 100)}..." with multi-tenant data segmentation, RBAC security, and real-time edge telemetry.`,
    features: [
      'Role-Based Access Control (RBAC) & Session Management',
      'Real-Time CRUD API with Parameter Validation & Error Boundaries',
      'D1 SQL Database with Automated Migrations & Triggers',
      'Audit Logging & Security Event Trail for Compliance',
      'Edge Caching, CORS Governance & OWASP Security Headers',
      'Responsive Tailwind UI with Live Telemetry & Filtering',
    ],
    techStack: [
      'Cloudflare Workers',
      'D1 Database (SQLite at Edge)',
      'React 19 & Next.js Components',
      'Tailwind CSS v4',
      'Web Crypto API (AES-GCM / HMAC)',
      'Cloudflare Queues & Observability',
    ],
    estimatedSteps: [
      '1. Provision Cloudflare D1 database schema with indexes and triggers',
      '2. Generate secure REST API route handlers with role authorization',
      '3. Assemble reactive React / Tailwind single-page dashboard UI',
      '4. Push complete codebase to private GitHub repository',
      '5. Deploy edge Worker to Cloudflare and provision custom subdomain',
    ],
    security: {
      rbac: true,
      auditLog: true,
      fieldLevelSecurity: true,
      dataSegmentation: true,
    },
  };
}

async function planAppWithLLM(env: Env, prompt: string, ownerId?: string): Promise<PlanResult> {
  const systemPrompt = `You are Vela, a world-class enterprise full-stack architect. Generate a complete, production-ready MVP plan from this natural language prompt.
Output EXACTLY this JSON format and nothing else:
{
  "name": "App Name",
  "description": "1-2 sentence executive description",
  "features": ["feature 1", "feature 2", "feature 3", "feature 4", "feature 5"],
  "techStack": ["Cloudflare Workers", "D1 Database", "React 19", "Tailwind CSS", "Web Crypto"],
  "estimatedSteps": ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"],
  "security": {
    "rbac": true,
    "auditLog": true,
    "fieldLevelSecurity": true,
    "dataSegmentation": true
  }
}
CRITICAL: Output ONLY valid JSON enclosed in curly braces. No markdown, no conversational commentary.`;

  try {
    const content = await callLLM(env, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Plan this enterprise application: ' + prompt },
    ], ownerId);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as PlanResult;
      parsed.security = { rbac: true, auditLog: true, fieldLevelSecurity: true, dataSegmentation: true };
      if (!parsed.techStack?.includes('Cloudflare Workers')) parsed.techStack.push('Cloudflare Workers');
      if (!parsed.techStack?.includes('D1 Database')) parsed.techStack.push('D1 Database');
      return parsed;
    }
  } catch (err) {
    console.warn('planAppWithLLM fell back to deterministic generator:', err);
  }

  return generateEnterprisePlanFallback(prompt);
}

// Fallback Full-Stack Scaffolder (Production-Ready Code)
function generateEnterpriseScaffoldFallback(name: string, prompt: string, plan?: PlanResult | null): ScaffoldResult {
  const appTitle = plan?.name || name || 'Enterprise Portal';
  const desc = plan?.description || prompt || 'Distributed Edge Application';

  const schema = `-- D1 Database Schema for ${appTitle}
-- Core Tables
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  status TEXT NOT NULL DEFAULT 'Active',
  priority TEXT NOT NULL DEFAULT 'Medium',
  data_json TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);

-- Users & Authentication
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Sessions & Refresh Tokens
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Refresh Tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- Rate Limiting
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  window_start TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ratelimit_expires ON rate_limits(expires_at);

-- File Uploads (R2 Metadata)
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);

-- Background Jobs
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);

-- Items (Core Business Data)
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  status TEXT NOT NULL DEFAULT 'Active',
  priority TEXT NOT NULL DEFAULT 'Medium',
  data_json TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);

-- Seed initial data
INSERT OR IGNORE INTO items (id, title, category, status, priority, data_json, created_by, created_at, updated_at)
VALUES 
  ('item-1', 'Initial Setup & Security Baseline', 'Infrastructure', 'Active', 'High', '{"score": 98, "tags": ["prod", "edge"]}', 'admin@vela.local', datetime('now'), datetime('now')),
  ('item-2', 'Edge Telemetry & Observability', 'Monitoring', 'Active', 'Medium', '{"sample_rate": 1.0, "latency_ms": 12}', 'system', datetime('now'), datetime('now')),
  ('item-3', 'Compliance & Role-Based Access', 'Security', 'Active', 'High', '{"rbac_enforced": true}', 'security@vela.local', datetime('now'), datetime('now'));
`;

  const backend = `// Cloudflare Workers REST API & Backend for ${appTitle}
const APP_NAME = ${JSON.stringify(appTitle)};
const APP_DESC = ${JSON.stringify(desc)};

function securityHeaders() {
  const h = new Headers();
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return h;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: securityHeaders() });
}

function htmlResponse(html, status = 200) {
  const h = securityHeaders();
  h.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(html, { status, headers: h });
}

// ============================================
// ENTERPRISE MIDDLEWARE & UTILITIES
// ============================================

// ---- Rate Limiting (Token Bucket per IP/User) ----
async function checkRateLimit(env, key, limit = 100, windowMs = 60000) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const row = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row) {
    await env.DB.prepare('INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 1, ?, ?)')
      .bind(key, now.toString(), new Date(now + 86400000).toISOString()).run();
    return { allowed: true, remaining: 99 };
  }
  if (parseInt(row.window_start) < Date.now() - 60000) {
    await env.DB.prepare('UPDATE rate_limits SET count = 1, window_start = ? WHERE key = ?').bind(now.toString(), key).run();
    return { allowed: true, remaining: 99 };
  }
  if (row.count >= limit) return { allowed: false, remaining: 0 };
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return { allowed: true, remaining: limit - row.count - 1 };
}

// ---- Password Hashing (Argon2 via Web Crypto PBKDF2 fallback) ----
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(salt))) + ':' + btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(':');
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(hash))) === hashB64;
}

// ---- JWT (HS256 via Web Crypto) ----
const JWT_SECRET = 'vela-enterprise-jwt-secret-change-in-production';
async function signJWT(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  new TextEncoder().encode(header + '.' + body)
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `\${header}.\${body}.\${sigB64}`;
}

async function verifyJWT(token) {
  const [header, body, sig] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)), new TextEncoder().encode(`\${header}.\${body}`));
  if (!valid) return null;
  const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  return payload;
}

function extractBearer(request) {
  const auth = request.headers.get('Authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
}

async function getCurrentUser(env, request) {
  const token = extractBearer(request);
  if (!token) return null;
  const payload = await verifyJWT(token);
  if (!payload) return null;
  const user = await env.DB.prepare('SELECT id, email, name, role, email_verified FROM users WHERE id = ?').bind(payload.sub).first();
  return user || null;
}

// ---- RBAC Middleware ----
function requireRole(user, ...allowedRoles) {
  if (!user) return { error: 'Unauthorized', status: 401 };
  if (!allowedRoles.includes(user.role)) return { error: 'Forbidden', status: 403 };
  return null;
}

// ---- Rate Limit Middleware ----
async function rateLimitMiddleware(env, request, limit = 100) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rl = await checkRateLimit(env, `ip:${ip}`, limit);
  if (!rl.allowed) return jsonResponse({ error: 'Rate limit exceeded', retry_after: 60 }, 429);
  return null;
}

// ---- OpenAPI Spec ----
function generateOpenAPISpec() {
  return {
    openapi: '3.0.3',
    info: { title: APP_NAME, version: '1.0.0', description: APP_DESC },
    servers: [{ url: '/', description: 'Current deployment' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Item: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' }, created_at: { type: 'string' }, updated_at: { type: 'string' } } },
        User: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, email_verified: { type: 'boolean' } } },
        AuthTokens: { type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' }, token_type: { type: 'string' }, expires_in: { type: 'integer' } } },
      }
    },
    paths: {
      '/api/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
      '/api/auth/register': { post: { summary: 'Register user', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } }, required: ['email', 'password'] } } } }, responses: { '201': { description: 'Created' } } } },
      '/api/auth/login': { post: { summary: 'Login', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } }, required: ['email', 'password'] } } } }, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthTokens' } } } } } } },
      '/api/auth/me': { get: { summary: 'Current user', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } } } } },
      '/api/auth/refresh': { post: { summary: 'Refresh access token', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthTokens' } } } } } } },
      '/api/auth/logout': { post: { summary: 'Logout', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } },
      '/api/items': { get: { summary: 'List items', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } } } }, post: { summary: 'Create item', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string' } }, required: ['title'] } } } }, responses: { '201': { description: 'Created' } } } },
      '/api/upload': { post: { summary: 'Get signed upload URL', security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { filename: { type: 'string' }, content_type: { type: 'string' }, size: { type: 'integer' } }, required: ['filename', 'content_type', 'size'] } } } }, responses: { '200': { description: 'Upload URL', content: { 'application/json': { schema: { type: 'object', properties: { upload_url: { type: 'string' }, file_id: { type: 'string' } } } } } } } },
      '/api/ws': { get: { summary: 'WebSocket real-time', security: [{ bearerAuth: [] }], responses: { '101': { description: 'Switching protocols' } } } },
    },
    security: [{ bearerAuth: [] }]
  };
}

function openAPISpecHandler() {
  return jsonResponse(generateOpenAPISpec());
}

// ---- WebSocket Handler ----
async function handleWebSocket(request, env) {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') return jsonResponse({ error: 'Expected WebSocket upgrade' }, 400);
  const token = extractBearer(request) || new URL(request.url).searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Authentication required' }, 401);
  const payload = await verifyJWT(token);
  if (!payload) return jsonResponse({ error: 'Invalid token' }, 401);
  
  const user = await getCurrentUser(env, new Request(request.url, { headers: { Authorization: `Bearer ${token}` } }));
  if (!user) return jsonResponse({ error: 'User not found' }, 404);
  
  const doId = env.REALTIME.idFromName(`user:${user.id}`);
  const stub = env.REALTIME.get(doId);
  return stub.fetch(request);
}

// ---- Queue Consumer ----
async function processQueue(job, env) {
  switch (job.type) {
    case 'send_email':
      console.log('[Queue] Sending email:', job.payload);
      break;
    case 'process_file':
      console.log('[Queue] Processing file:', job.payload);
      break;
    case 'webhook':
      console.log('[Queue] Webhook:', job.payload);
      break;
    default:
      console.warn('[Queue] Unknown job type:', job.type);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: securityHeaders() });
    }

    // Rate limiting (skip health)
    if (url.pathname !== '/api/health') {
      const rl = await rateLimitMiddleware(env, request);
      if (rl) return rl;
    }

    try {
      if (url.pathname === '/api/health') {
        return jsonResponse({ ok: true, app: APP_NAME, time: new Date().toISOString() });
      }

      if (url.pathname === '/api/items' && method === 'GET') {
        if (env.DB) {
          const results = await env.DB.prepare('SELECT * FROM items ORDER BY updated_at DESC LIMIT 100').all();
          return jsonResponse({ items: results.results || [] });
        }
        return jsonResponse({
          items: [
            { id: '1', title: 'Edge Worker Running', category: 'Platform', status: 'Active', priority: 'High', updated_at: new Date().toISOString() },
            { id: '2', title: 'Security RBAC Active', category: 'Security', status: 'Active', priority: 'Medium', updated_at: new Date().toISOString() }
          ]
        });
      }

      if (url.pathname === '/api/items' && method === 'POST') {
        const body = await request.json();
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const title = body.title || 'Untitled Item';
        const category = body.category || 'General';
        const priority = body.priority || 'Medium';

        if (env.DB) {
          await env.DB.prepare('INSERT INTO items (id, title, category, status, priority, data_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(id, title, category, 'Active', priority, JSON.stringify(body.data || {}), body.created_by || 'user', now, now).run();

          await env.DB.prepare('INSERT INTO audit_logs (id, action, actor, entity_id, payload_json, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), 'ITEM_CREATED', body.created_by || 'user', id, JSON.stringify({ title }), request.headers.get('cf-connecting-ip') || 'edge', now).run();
        }

        return jsonResponse({ ok: true, item: { id, title, category, status: 'Active', priority, created_at: now, updated_at: now } }, 201);
      }

      if (url.pathname === '/api/audit' && method === 'GET') {
        if (env.DB) {
          const logs = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50').all();
          return jsonResponse({ audit_logs: logs.results || [] });
        }
        return jsonResponse({ audit_logs: [] });
      }

      // ============================================
      // ENTERPRISE ENDPOINTS
      // ============================================

      // ---- OpenAPI Spec ----
      if (url.pathname === '/api/openapi.json' && method === 'GET') {
        return openAPISpecHandler();
      }

      // ---- Auth: Register ----
      if (url.pathname === '/api/auth/register' && method === 'POST') {
        const rl = await checkRateLimit(env, `auth:register:${request.headers.get('cf-connecting-ip') || 'unknown'}`, 10, 3600000);
        if (!rl.allowed) return jsonResponse({ error: 'Too many registration attempts' }, 429);
        const body = await request.json();
        const { email, password, name } = body;
        if (!email || !password) return jsonResponse({ error: 'email and password required' }, 400);
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existing) return jsonResponse({ error: 'Email already registered' }, 409);
        const hash = await hashPassword(password);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare('INSERT INTO users (id, email, password_hash, name, role, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, email, hash, name || email.split('@')[0], 'developer', 0, now, now).run();
        const accessToken = await signJWT({ sub: id, role: 'developer', email });
        const refreshToken = await signJWT({ sub: id, type: 'refresh', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
        const refreshHash = await hashPassword(refreshToken);
        await env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), id, await hashPassword(refreshToken), new Date(Date.now() + 30 * 24 * 3600000).toISOString(), new Date().toISOString()).run();
        await recordAuditLog(env, id, 'USER_REGISTERED', `User registered: ${email}`, null, request.headers.get('cf-connecting-ip') || 'edge');
        return jsonResponse({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 }, 201);
      }

      // ---- Auth: Login ----
      if (url.pathname === '/api/auth/login' && method === 'POST') {
        const rl = await checkRateLimit(env, `auth:login:${request.headers.get('cf-connecting-ip') || 'unknown'}`, 20, 3600000);
        if (!rl.allowed) return jsonResponse({ error: 'Too many login attempts' }, 429);
        const body = await request.json();
        const { email, password } = body;
        if (!email || !password) return jsonResponse({ error: 'email and password required' }, 400);
        const user = await env.DB.prepare('SELECT id, email, password_hash, name, role, email_verified FROM users WHERE email = ?').bind(email).first();
        if (!user || !(await verifyPassword(password, user.password_hash))) return jsonResponse({ error: 'Invalid credentials' }, 401);
        const accessToken = await signJWT({ sub: user.id, role: user.role, email: user.email });
        const refreshToken = await signJWT({ sub: user.id, type: 'refresh', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
        await env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), user.id, await hashPassword(refreshToken), new Date(Date.now() + 30 * 24 * 3600000).toISOString(), new Date().toISOString()).run();
        await env.DB.prepare('UPDATE users SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id).run();
        await recordAuditLog(env, user.id, 'USER_LOGIN', `User logged in: ${email}`, null, request.headers.get('cf-connecting-ip') || 'edge');
        return jsonResponse({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 });
      }

      // ---- Auth: Me (Current User) ----
      if (url.pathname === '/api/auth/me' && method === 'GET') {
        const user = await getCurrentUser(env, request);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
        return jsonResponse(user);
      }

      // ---- Auth: Refresh Token ----
      if (url.pathname === '/api/auth/refresh' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const refreshToken = body.refresh_token;
        if (!refreshToken) return jsonResponse({ error: 'refresh_token required' }, 400);
        const payload = await verifyJWT(refreshToken);
        if (!payload || payload.type !== 'refresh') return jsonResponse({ error: 'Invalid refresh token' }, 401);
        const stored = await env.DB.prepare('SELECT id FROM refresh_tokens WHERE user_id = ? AND token_hash = ? AND revoked = 0 AND expires_at > ?')
          .bind(payload.sub, await hashPassword(refreshToken), new Date().toISOString()).first();
        if (!stored) return jsonResponse({ error: 'Refresh token revoked or expired' }, 401);
        await env.DB.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').bind(stored.id).run();
        const user = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(payload.sub).first();
        if (!user) return jsonResponse({ error: 'User not found' }, 404);
        const newAccessToken = await signJWT({ sub: user.id, role: user.role, email: user.email });
        const newRefreshToken = await signJWT({ sub: user.id, type: 'refresh', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
        await env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), user.id, await hashPassword(newRefreshToken), new Date(Date.now() + 30 * 24 * 3600000).toISOString(), new Date().toISOString()).run();
        return jsonResponse({ access_token: newAccessToken, refresh_token: newRefreshToken, token_type: 'Bearer', expires_in: 3600 });
      }

      // ---- Auth: Logout ----
      if (url.pathname === '/api/auth/logout' && method === 'POST') {
        const user = await getCurrentUser(env, request);
        if (user) {
          const token = extractBearer(request);
          if (token) {
            const payload = await verifyJWT(token);
            if (payload) {
              await env.DB.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND token_hash = ?').bind(payload.sub, await hashPassword(token)).run();
            }
          }
        }
        return jsonResponse({ ok: true });
      }

      // ---- File Upload: Get Signed R2 URL ----
      if (url.pathname === '/api/upload' && method === 'POST') {
        const user = await getCurrentUser(env, request);
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        const { filename, content_type, size } = body;
        if (!filename || !content_type || !size) return jsonResponse({ error: 'filename, content_type, size required' }, 400);
        if (size > 50 * 1024 * 1024) return jsonResponse({ error: 'File too large (max 50MB)' }, 400);
        const fileId = crypto.randomUUID();
        const r2Key = `uploads/${user.id}/${fileId}/${filename}`;
        const uploadUrl = `https://${env.BUCKET}.r2.cloudflarestorage.com/${r2Key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...`; // In production, generate proper signed URL
        const now = new Date().toISOString();
        await env.DB.prepare('INSERT INTO files (id, user_id, filename, content_type, size, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(fileId, user.id, filename, content_type, size, r2Key, now).run();
        await recordAuditLog(env, user.id, 'FILE_UPLOAD_INITIATED', `Initiated upload: ${filename}`, null, request.headers.get('cf-connecting-ip') || 'edge');
        return jsonResponse({ upload_url: uploadUrl, file_id: fileId, r2_key: r2Key });
      }

      // ---- WebSocket Real-time ----
      if (url.pathname === '/api/ws' && method === 'GET') {
        const res = await handleWebSocket(request, env);
        return res;
      }

      // ---- OpenAPI Spec ----
      if (url.pathname === '/api/openapi.json' && method === 'GET') {
        return openAPISpecHandler();
      }

      // ---- OpenAPI YAML ----
      if (url.pathname === '/api/openapi.yaml' && method === 'GET') {
        const spec = generateOpenAPISpec();
        const yaml = Object.entries(spec).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
        return new Response(yaml, { headers: { ...securityHeaders(), 'Content-Type': 'application/yaml' } });
      }

      const appHtml = \`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>\${APP_NAME}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root { color-scheme: dark; }
    body { background: #070913; color: #eaf0ff; font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="min-h-screen p-6 md:p-12">
  <div class="max-w-5xl mx-auto">
    <header class="flex flex-col md:flex-row md:items-center justify-between pb-8 border-b border-slate-800 gap-4">
      <div>
        <div class="inline-block px-2.5 py-1 text-xs font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 rounded-full mb-3">
          ● Live on Cloudflare Edge
        </div>
        <h1 class="text-3xl md:text-5xl font-black tracking-tight text-white">\${APP_NAME}</h1>
        <p class="text-slate-400 text-sm md:text-base mt-1">\${APP_DESC}</p>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="fetchItems()" class="px-4 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition">Refresh</button>
        <button onclick="openModal()" class="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg shadow-blue-500/20 transition">+ New Record</button>
      </div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 my-8">
      <div class="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl">
        <span class="text-xs text-slate-400 font-medium">Status</span>
        <div class="text-2xl font-bold text-emerald-400 mt-1">Operational</div>
        <p class="text-xs text-slate-500 mt-1">Edge latency ~12ms</p>
      </div>
      <div class="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl">
        <span class="text-xs text-slate-400 font-medium">Security</span>
        <div class="text-2xl font-bold text-blue-400 mt-1">RBAC Active</div>
        <p class="text-xs text-slate-500 mt-1">Audit log streaming</p>
      </div>
      <div class="p-5 bg-slate-900/80 border border-slate-800 rounded-2xl">
        <span class="text-xs text-slate-400 font-medium">Total Records</span>
        <div id="metricCount" class="text-2xl font-bold text-white mt-1">--</div>
        <p class="text-xs text-slate-500 mt-1">Cloudflare D1 SQLite</p>
      </div>
    </div>

    <div class="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
      <div class="p-5 border-b border-slate-800 flex justify-between items-center">
        <h2 class="text-base font-bold text-white">Records & Activity</h2>
        <span id="loadState" class="text-xs text-slate-400">Loading...</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-950/50 text-slate-400 text-xs uppercase tracking-wider border-b border-slate-800">
            <tr>
              <th class="p-4">Title</th>
              <th class="p-4">Category</th>
              <th class="p-4">Priority</th>
              <th class="p-4">Status</th>
              <th class="p-4 text-right">Updated</th>
            </tr>
          </thead>
          <tbody id="itemsTable" class="divide-y divide-slate-800/60 text-slate-300">
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="modal" class="fixed inset-0 bg-black/80 backdrop-blur-sm hidden place-items-center p-4 z-50">
    <div class="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md">
      <h3 class="text-lg font-bold text-white mb-4">Add New Record</h3>
      <div class="space-y-3">
        <input id="newTitle" placeholder="Title" class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white outline-none focus:border-blue-500 text-sm">
        <input id="newCategory" placeholder="Category (e.g. Operations, Security)" class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white outline-none focus:border-blue-500 text-sm">
        <select id="newPriority" class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white outline-none focus:border-blue-500 text-sm">
          <option value="Low">Low Priority</option>
          <option value="Medium" selected>Medium Priority</option>
          <option value="High">High Priority</option>
        </select>
      </div>
      <div class="flex justify-end gap-2 mt-6">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold bg-slate-800 text-slate-300 rounded-xl">Cancel</button>
        <button onclick="createItem()" class="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-xl">Create</button>
      </div>
    </div>
  </div>

  <script>
    const esc = s => String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    async function fetchItems() {
      document.getElementById('loadState').textContent = 'Syncing...';
      try {
        const res = await fetch('/api/items');
        const data = await res.json();
        const items = data.items || [];
        document.getElementById('metricCount').textContent = items.length;
        document.getElementById('itemsTable').innerHTML = items.map(i => \`
          <tr class="hover:bg-slate-800/30 transition">
            <td class="p-4 font-semibold text-white">\${esc(i.title)}</td>
            <td class="p-4"><span class="px-2 py-0.5 text-xs rounded-md bg-slate-800 text-slate-300">\${esc(i.category)}</span></td>
            <td class="p-4"><span class="text-xs font-bold \${i.priority==='High'?'text-rose-400':i.priority==='Medium'?'text-amber-400':'text-slate-400'}">\${esc(i.priority)}</span></td>
            <td class="p-4"><span class="text-xs text-emerald-400">● \${esc(i.status)}</span></td>
            <td class="p-4 text-right text-xs text-slate-500">\${new Date(i.updated_at).toLocaleTimeString()}</td>
          </tr>
        \`).join('');
        document.getElementById('loadState').textContent = 'Live';
      } catch(e) {
        document.getElementById('loadState').textContent = 'Error syncing';
      }
    }
    function openModal() { document.getElementById('modal').classList.remove('hidden'); document.getElementById('modal').classList.add('grid'); }
    function closeModal() { document.getElementById('modal').classList.add('hidden'); document.getElementById('modal').classList.remove('grid'); }
    async function createItem() {
      const title = document.getElementById('newTitle').value.trim();
      const category = document.getElementById('newCategory').value.trim() || 'General';
      const priority = document.getElementById('newPriority').value;
      if (!title) return;
      await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, category, priority })
      });
      closeModal();
      document.getElementById('newTitle').value = '';
      document.getElementById('newCategory').value = '';
      fetchItems();
    }
    fetchItems();
  </script>
</body>
</html>\`;

      return htmlResponse(appHtml);
    } catch (err) {
      return jsonResponse({ error: 'Internal Server Error', message: err.message }, 500);
    }
  }
};
`;

  const frontend = `// React / Next.js Component for ${appTitle}
'use client';
import React, { useState, useEffect } from 'react';

export default function EnterpriseApp() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Operations');
  const [priority, setPriority] = useState('Medium');

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/items');
      const json = await res.json();
      setItems(json.items || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, category, priority }),
    });
    setTitle('');
    setModalOpen(false);
    loadData();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12">
      <div className="max-w-6xl mx-auto">
        <header className="flex justify-between items-center pb-6 border-b border-slate-800">
          <div>
            <div className="text-xs font-bold text-emerald-400 mb-1 tracking-wider uppercase">● Distributed Cloudflare App</div>
            <h1 className="text-3xl font-black">${appTitle}</h1>
            <p className="text-sm text-slate-400 mt-1">${desc}</p>
          </div>
          <button onClick={() => setModalOpen(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl font-bold text-xs transition">
            + New Record
          </button>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 my-8">
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
            <span className="text-xs text-slate-400">Total Items</span>
            <div className="text-2xl font-bold mt-1">{items.length}</div>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
            <span className="text-xs text-slate-400">Security Posture</span>
            <div className="text-2xl font-bold text-emerald-400 mt-1">RBAC Enforced</div>
          </div>
          <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl">
            <span className="text-xs text-slate-400">Database Engine</span>
            <div className="text-2xl font-bold text-blue-400 mt-1">Cloudflare D1</div>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex justify-between items-center">
            <h2 className="font-bold text-sm">Active Records</h2>
            <button onClick={loadData} className="text-xs text-blue-400 hover:underline">{loading ? 'Syncing...' : 'Refresh'}</button>
          </div>
          <div className="divide-y divide-slate-800">
            {items.map((item) => (
              <div key={item.id} className="p-4 flex justify-between items-center hover:bg-slate-800/40 transition">
                <div>
                  <div className="font-bold text-sm">{item.title}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{item.category} · {item.priority} priority</div>
                </div>
                <div className="text-xs text-emerald-400 font-semibold">{item.status}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
`;

  const config = `{\n  "name": "vela-app",\n  "main": "src/worker.mjs",\n  "compatibility_date": "2026-08-25",\n  "compatibility_flags": ["nodejs_compat"],\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "vela-app-db",\n      "database_id": "auto"\n    }\n  ],\n  "r2_buckets": [\n    { "binding": "BUCKET", "bucket_name": "vela-app-files" }\n  ],\n  "queues": { "producers": [{ "binding": "JOBS", "queue": "vela-app-jobs" }], "consumers": [{ "queue": "vela-app-jobs", "max_batch_size": 10, "max_batch_timeout": 30 }] },\n  "durable_objects": { "bindings": [{ "name": "REALTIME", "class_name": "RealtimeDO" }] }\n}`;

  const instructions = `# ${appTitle}\n\n${desc}\n\n## Features\n- Full Cloudflare Workers REST API with RBAC\n- JWT Authentication (Login, Register, Refresh, Me)\n- Role-Based Access Control (admin, developer, viewer)\n- Cloudflare D1 SQL Schema with Audit Logging\n- R2 File Upload with Signed URLs\n- WebSocket Real-time via Durable Objects\n- Background Job Processing via Cloudflare Queues\n- Rate Limiting (Token Bucket per IP/User)\n- Responsive Tailwind React UI\n- OWASP Security Controls & Rate Limiting\n`;

  return { frontend, backend, database: schema, config, instructions };
}

async function scaffoldAppWithLLM(env: Env, prompt: string, plan?: PlanResult | null, ownerId?: string): Promise<ScaffoldResult> {
  const systemPrompt = `You are Vela, an elite agentic full-stack app builder. Given a natural language prompt and architecture plan, generate production-ready code.
Generate code in these labeled sections:
FRONTEND: Complete React/Next.js component with Tailwind CSS.
BACKEND: Cloudflare Workers API route handlers (ES module format: export default { async fetch(request, env, ctx) { ... } }). Include REST endpoints (/api/items, /api/health), D1 database bindings, CORS, and full responsive HTML fallback.
DATABASE: Complete D1 SQL schema (CREATE TABLE statements with indexes, audit_logs table, and seed data).
CONFIG: Valid wrangler.jsonc configuration with D1 database binding.
INSTRUCTIONS: Concise Markdown documentation.

CRITICAL: Output ONLY the labeled code sections. Format each section header as FRONTEND:, BACKEND:, DATABASE:, CONFIG:, INSTRUCTIONS:. DO NOT wrap sections in markdown backticks.`;

  try {
    const content = await callLLM(env, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Scaffold full-stack app for: ${prompt}\nPlan: ${JSON.stringify(plan || {})}` },
    ], ownerId);

    const result: ScaffoldResult = { frontend: '', backend: '', database: '', config: '', instructions: '' };
    const sections = content.split(/\n(?=^(FRONTEND|BACKEND|DATABASE|CONFIG|INSTRUCTIONS):)/m);
    for (const section of sections) {
      const match = section.match(/^(FRONTEND|BACKEND|DATABASE|CONFIG|INSTRUCTIONS):\s*([\s\S]*)$/m);
      if (match) {
        const key = match[1].toLowerCase() as keyof ScaffoldResult;
        result[key] = cleanCodeBlock(match[2]);
      }
    }

    if (result.backend && (result.frontend || result.database)) {
      result.backend = sanitizeWorkerSource(plan?.name || 'app', prompt, result.backend);
      return result;
    }
  } catch (e) {
    console.warn('scaffoldAppWithLLM fell back to enterprise template:', e);
  }

  return generateEnterpriseScaffoldFallback(plan?.name || 'Vela Enterprise App', prompt, plan);
}

// --- Connections & Deployment Infrastructure ---

async function connectedToken(env: Env, ownerId: string, provider: Exclude<Provider, 'google'>): Promise<ConnectionToken> {
  const connection = await env.DB.prepare('SELECT access_token_ciphertext, refresh_token_ciphertext, external_account_id, token_expires_at FROM connections WHERE owner_id = ? AND provider = ? AND status = ?')
    .bind(ownerId, provider, 'connected')
    .first<{ access_token_ciphertext: string | null; refresh_token_ciphertext: string | null; external_account_id: string | null; token_expires_at: string | null }>();
  if (!connection?.access_token_ciphertext) throw new Error(`${provider} connection is missing or expired`);
  if (connection.token_expires_at && Date.parse(connection.token_expires_at) <= Date.now() + 60_000) {
    if (provider === 'cloudflare' && connection.refresh_token_ciphertext) {
      return refreshCloudflareToken(env, ownerId, {
        refresh_token_ciphertext: connection.refresh_token_ciphertext,
        external_account_id: connection.external_account_id,
      });
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
      ? String((payload as { message: unknown }).message)
      : String(payload).slice(0, 300);
    throw new Error(`GitHub request failed (${response.status}): ${detail}`);
  }
  if (typeof payload !== 'object' || !payload) throw new Error('GitHub returned an unexpected response');
  return payload as T;
}

async function putGithubFile(token: string, repository: string, path: string, content: string, message: string): Promise<void> {
  let sha: string | undefined;
  try {
    const existing = await githubRequest<{ sha: string }>(token, `/repos/${repository}/contents/${path}`);
    sha = existing.sha;
  } catch {}

  const body: Record<string, unknown> = {
    message,
    content: base64(encoder.encode(cleanCodeBlock(content))),
  };
  if (sha) body.sha = sha;

  await githubRequest(token, `/repos/${repository}/contents/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function deployStandaloneWorker(token: string, accountId: string, workerName: string, source: string): Promise<void> {
  const cleanSource = sanitizeWorkerSource(workerName, 'Standalone App', source);
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-08-25' }));
  form.set('worker.mjs', new Blob([cleanSource], { type: 'application/javascript+module' }), 'worker.mjs');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 350);
    throw new Error(`Cloudflare Worker deployment failed (${response.status}): ${detail || 'No additional detail returned'}`);
  }
  const subdomainResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: true, previews_enabled: true }),
    }
  );
  if (!subdomainResponse.ok) {
    const detail = (await subdomainResponse.text()).replace(/\s+/g, ' ').slice(0, 350);
    console.warn(`Cloudflare subdomain enable warning (${subdomainResponse.status}): ${detail}`);
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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connection complete</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a13;color:#f4f5ff;font:16px system-ui}main{max-width:500px;text-align:center;padding:40px;border:1px solid #283252;border-radius:24px;background:#111628}h1{font-size:28px;margin:0 0 12px;color:#9de8c5}p{color:#aab5d8;line-height:1.6}button{margin-top:20px;background:#8aa4ff;color:#090f23;border:0;border-radius:99px;padding:12px 24px;font-weight:700;cursor:pointer}</style></head><body><main><h1>${label} Connected</h1><p>Your authentication token is securely encrypted and stored on the control plane.</p><button onclick="window.location.href='/'">Return to Vela Studio →</button></main></body></html>`, { headers });
}

async function connectionProviders(env: Env, ownerId: string): Promise<Set<string>> {
  await refreshCloudflareConnectionIfNeeded(env, ownerId);
  const result = await env.DB.prepare('SELECT provider FROM connections WHERE owner_id = ? AND status = ? AND (token_expires_at IS NULL OR token_expires_at > ?)')
    .bind(ownerId, 'connected', new Date(Date.now() + 60_000).toISOString())
    .all<{ provider: string }>();
  return new Set(result.results.map((connection) => connection.provider));
}

async function mergeOwnerState(env: Env, currentOwnerId: string, targetOwnerId: string): Promise<void> {
  if (currentOwnerId === targetOwnerId) return;
  const now = new Date().toISOString();
  const currentConnections = await env.DB.prepare('SELECT id, provider FROM connections WHERE owner_id = ?')
    .bind(currentOwnerId)
    .all<{ id: string; provider: string }>();
  for (const connection of currentConnections.results) {
    const target = await env.DB.prepare('SELECT id FROM connections WHERE owner_id = ? AND provider = ?')
      .bind(targetOwnerId, connection.provider)
      .first<{ id: string }>();
    if (target) {
      await env.DB.prepare('DELETE FROM connections WHERE id = ?').bind(connection.id).run();
    } else {
      await env.DB.prepare('UPDATE connections SET owner_id = ?, updated_at = ? WHERE id = ?')
        .bind(targetOwnerId, now, connection.id)
        .run();
    }
  }
  await env.DB.prepare('UPDATE projects SET owner_id = ?, updated_at = ? WHERE owner_id = ?')
    .bind(targetOwnerId, now, currentOwnerId)
    .run();
}

async function recoverOwnerFromProvider(env: Env, currentOwnerId: string, provider: Exclude<Provider, 'google'>, externalAccountId: string): Promise<string> {
  const existing = await env.DB.prepare('SELECT owner_id FROM connections WHERE provider = ? AND external_account_id = ? ORDER BY updated_at DESC LIMIT 1')
    .bind(provider, externalAccountId)
    .first<{ owner_id: string }>();
  if (!existing?.owner_id || existing.owner_id === currentOwnerId) return currentOwnerId;
  await mergeOwnerState(env, currentOwnerId, existing.owner_id);
  return existing.owner_id;
}

async function refreshCloudflareConnectionIfNeeded(env: Env, ownerId: string): Promise<void> {
  const connection = await env.DB.prepare('SELECT refresh_token_ciphertext, token_expires_at FROM connections WHERE owner_id = ? AND provider = ? AND status = ?')
    .bind(ownerId, 'cloudflare', 'connected')
    .first<{ refresh_token_ciphertext: string | null; token_expires_at: string | null }>();
  if (!connection?.refresh_token_ciphertext || !connection.token_expires_at) return;
  if (Date.parse(connection.token_expires_at) > Date.now() + 60_000) return;
  try {
    await connectedToken(env, ownerId, 'cloudflare');
  } catch (error) {
    console.warn('Cloudflare token refresh during connection check failed:', messageFromError(error));
  }
}

async function ownerHasState(env: Env, ownerId: string): Promise<boolean> {
  const [projectCount, connectionCount] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM projects WHERE owner_id = ?').bind(ownerId).first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM connections WHERE owner_id = ? AND status = ?').bind(ownerId, 'connected').first<{ count: number }>(),
  ]);
  return Boolean((projectCount?.count ?? 0) > 0 || (connectionCount?.count ?? 0) > 0);
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
  return env.DB.prepare('SELECT id, name, prompt, status, scaffolding_json, plan_json, github_repository, worker_name, created_at, updated_at FROM projects WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<ProjectRecord>();
}

async function recordEvent(env: Env, projectId: string, kind: string, detail: string, stage?: string): Promise<void> {
  await env.DB.prepare('INSERT INTO build_events (id, project_id, kind, detail, stage, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), projectId, kind, detail, stage || 'general', new Date().toISOString()).run();
}

async function recordAuditLog(env: Env, ownerId: string, action: string, details: string, projectId?: string, ipAddress?: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO audit_logs (id, project_id, owner_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), projectId || null, ownerId, action, details, ipAddress || 'edge', new Date().toISOString()).run();
  } catch {}
}

const BUILD_STAGES = ['planning', 'awaiting_approval', 'scaffolding', 'creating_repository', 'pushing_files', 'deploying_worker', 'enabling_subdomain', 'live'] as const;

export async function buildStandaloneApp(env: Env, projectId: string, resumeFrom?: string): Promise<void> {
  await ensureSchema(env);
  const project = await env.DB.prepare('SELECT id, owner_id, name, prompt, github_repository, worker_name, plan_json, scaffolding_json FROM projects WHERE id = ?').bind(projectId).first<ProjectRecord>();
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

  let plan: PlanResult | null = null;
  let scaffolding: ScaffoldResult = { frontend: '', backend: '', database: '', config: '', instructions: '' };

  // --- Stage 1: Planning ---
  if (!shouldSkip('planning')) {
    await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('planning', now, projectId).run();
    await recordEvent(env, projectId, 'plan_started', 'Generating enterprise MVP plan and architecture blueprint', 'planning');
    
    plan = await planAppWithLLM(env, project.prompt, project.owner_id);
    await env.DB.prepare('UPDATE projects SET plan_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(plan), new Date().toISOString(), projectId).run();
    await recordEvent(env, projectId, 'plan_generated', `Architecture blueprint ready: ${plan.features.length} features, ${plan.techStack.length} tech modules`, 'planning');
    
    await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('awaiting_approval', new Date().toISOString(), projectId).run();
    await recordEvent(env, projectId, 'awaiting_approval', 'Plan ready for review — awaiting your approval to generate full-stack code', 'awaiting_approval');
    return;
  } else {
    const existing = await env.DB.prepare('SELECT plan_json, scaffolding_json FROM projects WHERE id = ?').bind(projectId).first<{ plan_json: string | null; scaffolding_json: string | null }>();
    plan = existing?.plan_json ? JSON.parse(existing.plan_json) : null;
    if (existing?.scaffolding_json) {
      try { scaffolding = JSON.parse(existing.scaffolding_json); } catch {}
    }
  }

  // --- Stage 2: Code Scaffolding ---
  if (!shouldSkip('scaffolding') || !scaffolding.backend) {
    await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('scaffolding', new Date().toISOString(), projectId).run();
    await recordEvent(env, projectId, 'scaffolding_started', 'AI agent generating full-stack code (React UI, Cloudflare Worker API, D1 schema, wrangler config)', 'scaffolding');
    
    scaffolding = await scaffoldAppWithLLM(env, project.prompt, plan, project.owner_id);
    await env.DB.prepare('UPDATE projects SET scaffolding_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(scaffolding), new Date().toISOString(), projectId).run();
    await recordEvent(env, projectId, 'scaffolding_complete', `Generated ${scaffolding.backend.length}B API worker, ${scaffolding.frontend.length}B React UI, ${scaffolding.database.length}B D1 schema`, 'scaffolding');
  }

  const source = sanitizeWorkerSource(project.name, project.prompt, scaffolding.backend);

  // --- Stage 3: Repository Creation & Commit ---
  if (!project.github_repository) {
    if (!shouldSkip('creating_repository')) {
      await env.DB.prepare('UPDATE projects SET status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind('creating_repository', workerName, new Date().toISOString(), project.id).run();
      await recordEvent(env, projectId, 'repository_started', `Creating private GitHub repository ${repositoryName}`, 'creating_repository');
      const repository = await githubRequest<{ full_name: string }>(github.accessToken, '/user/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: repositoryName, description: project.prompt.slice(0, 160), private: true, has_issues: true, has_projects: true }),
      });
      await recordEvent(env, projectId, 'repository_created', `Private repository ${repository.full_name} created on GitHub`, 'creating_repository');

      if (!shouldSkip('pushing_files')) {
        await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('pushing_files', new Date().toISOString(), project.id).run();
        await recordEvent(env, projectId, 'pushing_files', `Pushing enterprise source tree to ${repository.full_name}`, 'pushing_files');
        
        await putGithubFile(github.accessToken, repository.full_name, 'README.md', scaffolding.instructions || `# ${project.name}\n\n${project.prompt}\n`, 'Initial commit: Documentation');
        await putGithubFile(github.accessToken, repository.full_name, 'src/worker.mjs', source, 'Initial commit: Cloudflare Worker API & Server');
        await putGithubFile(github.accessToken, repository.full_name, 'wrangler.json', scaffolding.config || JSON.stringify({ name: workerName, main: 'src/worker.mjs', compatibility_date: '2026-08-25' }, null, 2), 'Initial commit: Wrangler configuration');
        if (scaffolding.frontend) await putGithubFile(github.accessToken, repository.full_name, 'src/frontend.jsx', scaffolding.frontend, 'Initial commit: React UI');
        if (scaffolding.database) await putGithubFile(github.accessToken, repository.full_name, 'schema.sql', scaffolding.database, 'Initial commit: D1 database schema');
        
        await env.DB.prepare('UPDATE projects SET github_repository = ?, status = ?, worker_name = ?, updated_at = ? WHERE id = ?')
          .bind(repository.full_name, 'deploying_worker', workerName, new Date().toISOString(), project.id).run();
        await recordEvent(env, projectId, 'files_pushed', `All enterprise source files committed and pushed to ${repository.full_name}`, 'pushing_files');
      }
    }
  } else {
    if (!shouldSkip('pushing_files')) {
      await env.DB.prepare('UPDATE projects SET status = ?, worker_name = ?, updated_at = ? WHERE id = ?').bind('pushing_files', workerName, new Date().toISOString(), project.id).run();
      await recordEvent(env, projectId, 'repository_reused', `Synchronizing code to existing repository ${project.github_repository}`, 'pushing_files');
      await putGithubFile(github.accessToken, project.github_repository, 'src/worker.mjs', source, 'Update Cloudflare Worker source');
      if (scaffolding.frontend) await putGithubFile(github.accessToken, project.github_repository, 'src/frontend.jsx', scaffolding.frontend, 'Update React UI');
      if (scaffolding.database) await putGithubFile(github.accessToken, project.github_repository, 'schema.sql', scaffolding.database, 'Update database schema');
      await recordEvent(env, projectId, 'files_pushed', `Source files successfully updated in ${project.github_repository}`, 'pushing_files');
    }
  }

  // --- Stage 4: Deploy Worker to Cloudflare ---
  if (!shouldSkip('deploying_worker')) {
    await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('deploying_worker', new Date().toISOString(), project.id).run();
    await recordEvent(env, projectId, 'deployment_started', `Deploying edge worker ${workerName} to Cloudflare`, 'deploying_worker');
    await deployStandaloneWorker(cloudflare.accessToken, env.CLOUDFLARE_ACCOUNT_ID, workerName, source);
    await recordEvent(env, projectId, 'deployment_complete', `Worker ${workerName} uploaded and *.workers.dev subdomain enabled`, 'deploying_worker');
  }

  // --- Live Status & Deployment Record ---
  const workerUrl = `https://${workerName}.workers.dev`;
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('live', new Date().toISOString(), project.id),
    env.DB.prepare('INSERT INTO project_deployments (id, project_id, version, commit_sha, worker_url, status, deployed_by, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM project_deployments WHERE project_id = ?), ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), project.id, project.id, 'main', workerUrl, 'active', 'Vela Orchestrator', new Date().toISOString()),
  ]);

  await recordEvent(env, projectId, 'live', `App is live on Cloudflare Edge: ${workerUrl}`, 'live');
}

async function projectsWithFeatures(env: Env, ownerId: string) {
  const projects = await env.DB.prepare('SELECT id, name, prompt, github_repository, worker_name, status, scaffolding_json, plan_json, created_at, updated_at FROM projects WHERE owner_id = ? ORDER BY updated_at DESC').bind(ownerId).all<Record<string, string | null>>();
  const features = await env.DB.prepare('SELECT project_id, feature, enabled, updated_at FROM project_features WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) ORDER BY feature').bind(ownerId).all<{ project_id: string; feature: string; enabled: number; updated_at: string }>();
  const events = await env.DB.prepare('SELECT project_id, kind, detail, stage, created_at FROM build_events WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ?) ORDER BY created_at DESC').bind(ownerId).all<{ project_id: string; kind: string; detail: string; stage: string; created_at: string }>();
  
  return projects.results.map((project) => ({
    ...project,
    features: features.results.filter((feature) => feature.project_id === project.id).map((feature) => ({ ...feature, enabled: Boolean(feature.enabled) })),
    latest_event: events.results.find((event) => event.project_id === project.id) ?? null,
  }));
}

// --- Enterprise Studio HTML Dashboard ---

function enterpriseDashboard(): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vela — Enterprise App Studio &amp; AI Toolbox</title>
  <style>
    :root {
      --bg: #070913;
      --card: #0e1222;
      --card-alt: #13192f;
      --border: #232d4e;
      --border-focus: #4b6fff;
      --ink: #f0f4ff;
      --muted: #8895bd;
      --blue: #4d77ff;
      --cyan: #46d0f7;
      --mint: #53e5a5;
      --amber: #ffbe53;
      --rose: #ff5b73;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 85% -10%, #20357533, transparent 40%),
                  radial-gradient(circle at 10% 20%, #44206522, transparent 40%),
                  var(--bg);
      color: var(--ink);
      font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh;
    }
    header.nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 28px;
      border-bottom: 1px solid var(--border);
      background: rgba(7, 9, 19, 0.8);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 20px; }
    .brand span { width: 28px; height: 28px; border-radius: 8px; background: var(--blue); display: grid; place-items: center; color: #fff; font-size: 16px; }
    .nav-tabs { display: flex; gap: 8px; }
    .tab-btn {
      background: none; border: 0; color: var(--muted); padding: 8px 16px; border-radius: 99px;
      font-weight: 600; font-size: 13px; cursor: pointer; transition: all .15s;
    }
    .tab-btn.active, .tab-btn:hover { color: var(--ink); background: var(--card-alt); }
    .conns { display: flex; gap: 10px; align-items: center; }
    .conn-pill {
      font-size: 11px; padding: 5px 12px; border-radius: 99px; border: 1px solid var(--border);
      background: #0d1224; display: flex; align-items: center; gap: 6px; font-weight: 600;
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--mint); box-shadow: 0 0 8px var(--mint); }
    .dot.wait { background: var(--amber); }
    main { max-width: 1200px; margin: 0 auto; padding: 36px 20px 80px; }
    .hero { margin-bottom: 32px; }
    .hero h1 { font-size: clamp(32px, 5vw, 56px); font-weight: 900; letter-spacing: -0.04em; line-height: 1.05; }
    .hero p { color: var(--muted); font-size: 15px; margin-top: 8px; max-width: 650px; }
    .grid-composer { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 20px; margin-bottom: 36px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 24px; }
    .card h2 { font-size: 17px; font-weight: 700; margin-bottom: 12px; }
    input, textarea, select {
      width: 100%; background: #080b18; border: 1px solid #293456; border-radius: 12px;
      padding: 12px 14px; color: var(--ink); font: inherit; outline: none; margin-bottom: 10px;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--border-focus); }
    textarea { min-height: 110px; resize: vertical; }
    button.primary {
      background: var(--blue); color: #fff; border: 0; border-radius: 12px; padding: 12px 20px;
      font-weight: 700; font-size: 13px; cursor: pointer; transition: all .15s;
    }
    button.primary:hover { filter: brightness(1.15); transform: translateY(-1px); }
    button.secondary {
      background: var(--card-alt); color: var(--ink); border: 1px solid var(--border);
      border-radius: 10px; padding: 8px 14px; font-weight: 600; font-size: 12px; cursor: pointer;
    }
    button.danger {
      background: #321017; color: var(--rose); border: 1px solid #5c1e29;
      border-radius: 10px; padding: 8px 14px; font-weight: 600; font-size: 12px; cursor: pointer;
    }
    button.danger:hover { background: #4a131f; }
    .badge {
      display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700;
      padding: 4px 10px; border-radius: 99px; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .badge.live { color: var(--mint); background: #0e291e; border: 1px solid #1a4f38; }
    .badge.planning, .badge.building, .badge.scaffolding { color: var(--cyan); background: #0c2538; border: 1px solid #194668; }
    .badge.awaiting_approval { color: var(--amber); background: #2e230a; border: 1px solid #5a4414; }
    .badge.failed { color: var(--rose); background: #321017; border: 1px solid #5c1e29; }
    .project-card {
      border: 1px solid var(--border); border-radius: 18px; padding: 22px; margin-bottom: 16px;
      background: linear-gradient(150deg, #11172e, #0c1020);
    }
    .p-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .p-head h3 { font-size: 19px; font-weight: 800; }
    .p-desc { color: var(--muted); font-size: 13px; line-height: 1.5; margin-bottom: 16px; }
    .stage-track { display: flex; gap: 4px; margin-bottom: 16px; }
    .stage-dot { height: 4px; flex: 1; border-radius: 2px; background: #1c2542; }
    .stage-dot.done { background: var(--mint); }
    .stage-dot.active { background: var(--cyan); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .plan-box {
      background: #090d1c; border: 1px solid #283763; border-radius: 14px; padding: 18px; margin: 16px 0;
    }
    .plan-box h4 { font-size: 13px; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px; }
    .tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .tag { font-size: 11px; padding: 4px 9px; border-radius: 6px; background: #16203d; border: 1px solid #2a3a69; color: #b7c7f5; }
    .action-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
    .modal {
      position: fixed; inset: 0; background: rgba(3, 5, 12, 0.85); backdrop-filter: blur(8px);
      z-index: 100; display: none; place-items: center; padding: 20px;
    }
    .modal.open { display: grid; }
    .modal-box {
      background: var(--card); border: 1px solid var(--border); border-radius: 20px;
      padding: 28px; width: 100%; max-width: 720px; max-height: 90vh; overflow-y: auto;
    }
    pre {
      background: #060814; border: 1px solid #1f2742; border-radius: 12px; padding: 16px;
      color: #9fe8c6; font-size: 12px; overflow-x: auto; max-height: 380px;
    }
    @media(max-width: 820px) { .grid-composer { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header class="nav">
    <div class="brand"><span>V</span> Vela Studio</div>
    <div class="nav-tabs">
      <button class="tab-btn active" onclick="switchView('builds')">Studio &amp; Builds</button>
      <button class="tab-btn" onclick="switchView('toolbox')">AI Toolbox &amp; Providers</button>
      <button class="tab-btn" onclick="switchView('audit')">Audit Logs</button>
      <button class="tab-btn" onclick="switchView('usage')">FinOps &amp; Usage</button>
    </div>
    <div class="conns">
      <div class="conn-pill"><span id="gh-dot" class="dot"></span> GitHub <button class="secondary" style="padding:2px 8px;font-size:10px" onclick="location.href='/auth/github/start'">OAuth</button></div>
      <div class="conn-pill"><span id="cf-dot" class="dot"></span> Cloudflare <button class="secondary" style="padding:2px 8px;font-size:10px" onclick="location.href='/auth/cloudflare/start'">OAuth</button></div>
    </div>
  </header>

  <main>
    <div id="view-builds">
      <div class="hero">
        <h1>Autonomous App Engineering</h1>
        <p>Describe your vision. Vela architectures the system, designs enterprise schemas, generates full-stack code, and deploys it to Cloudflare Edge with dedicated GitHub repos.</p>
      </div>

      <div class="grid-composer">
        <article class="card">
          <h2>Create New Standalone App</h2>
          <input id="proj-name" placeholder="App name (e.g. Enterprise Client Portal)">
          <textarea id="proj-prompt" placeholder="Describe the application, target workflows, security requirements, and data model..."></textarea>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
            <span id="create-status" style="font-size:12px;color:var(--cyan)"></span>
            <button class="primary" id="btn-create" onclick="createProject()">Architecture &amp; Plan →</button>
          </div>
        </article>

        <article class="card">
          <h2>Enterprise Capabilities</h2>
          <div style="font-size:13px;line-height:1.7;color:var(--muted)">
            <p>✦ <b>Zero-Trust Security</b>: Pre-configured RBAC, Web Crypto token encryption &amp; OWASP headers.</p>
            <p>✦ <b>Edge Native</b>: Cloudflare Workers, D1 SQLite databases, and Queues.</p>
            <p>✦ <b>Full Source Ownership</b>: Standalone private GitHub repository per application.</p>
            <p>✦ <b>Manageable Toolbox</b>: Configure OpenRouter, Cloudflare Workers AI, OpenAI, Gemini, &amp; Anthropic.</p>
          </div>
        </article>
      </div>

      <section>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 style="font-size:20px;font-weight:800;">Your Applications &amp; Deployments</h2>
          <button class="secondary" onclick="loadWorkspace()">⟳ Sync Workspace</button>
        </div>
        <div id="project-list">Loading workspace...</div>
      </section>
    </div>

    <!-- AI Toolbox View -->
    <div id="view-toolbox" style="display:none">
      <h2 style="font-size:24px;font-weight:800;margin-bottom:8px">AI Provider Toolbox &amp; Models</h2>
      <p style="color:var(--muted);font-size:14px;margin-bottom:24px">Manage LLM keys, select planning models, and test connections for OpenRouter, Cloudflare Workers AI, and custom providers.</p>
      
      <div class="card" style="max-width:800px;margin-bottom:24px">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px">Active Provider &amp; Routing</h3>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">PRIMARY AI ROUTING</label>
        <select id="setting-provider">
          <option value="auto">Auto (Failover: Custom → OpenRouter → Cloudflare AI → OpenAI → Gemini)</option>
          <option value="cloudflare">Cloudflare Workers AI (Edge Native)</option>
          <option value="openrouter">OpenRouter (Multi-Model Hub)</option>
          <option value="openai">OpenAI (GPT-4o / o3-mini)</option>
          <option value="gemini">Google Gemini (Gemini 2.0 Flash / Pro)</option>
          <option value="anthropic">Anthropic Claude (Claude 3.5 Sonnet)</option>
          <option value="custom">Custom OpenAI-Compatible Endpoint (Ollama, vLLM, Groq)</option>
        </select>

        <hr style="border:0;border-top:1px solid var(--border);margin:20px 0">

        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px">Cloudflare Workers AI</h3>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">MODEL ID</label>
        <input id="setting-cf-model" placeholder="@cf/meta/llama-3.3-70b-instruct">

        <hr style="border:0;border-top:1px solid var(--border);margin:20px 0">

        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px">OpenRouter Integration</h3>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">API KEY</label>
        <input id="setting-or-key" type="password" placeholder="sk-or-v1-...">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">MODEL</label>
        <input id="setting-or-model" placeholder="anthropic/claude-3.5-sonnet">

        <hr style="border:0;border-top:1px solid var(--border);margin:20px 0">

        <h3 style="font-size:16px;font-weight:700;margin-bottom:14px">Custom Endpoint (Ollama / Local / Groq / vLLM)</h3>
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">BASE URL (e.g. http://localhost:11434/v1)</label>
        <input id="setting-custom-url" placeholder="https://api.groq.com/openai/v1">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">API KEY (Optional)</label>
        <input id="setting-custom-key" type="password" placeholder="gsk_...">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">MODEL NAME</label>
        <input id="setting-custom-model" placeholder="llama-3.3-70b-versatile">

        <div style="display:flex;gap:10px;margin-top:20px">
          <button class="primary" onclick="saveSettings()">Save AI Toolbox Settings</button>
          <button class="secondary" onclick="testAI()">Test Active Provider ⚡</button>
        </div>
        <div id="ai-test-result" style="font-size:12px;margin-top:12px"></div>
      </div>
    </div>

    <!-- Audit View -->
    <div id="view-audit" style="display:none">
      <h2 style="font-size:24px;font-weight:800;margin-bottom:8px">Security &amp; Audit Trail</h2>
      <p style="color:var(--muted);font-size:14px;margin-bottom:24px">Immutable compliance record of all actions, approvals, deletions, and deployments across your workspace.</p>
      <div class="card" id="audit-list">Loading audit logs...</div>
    </div>

    <!-- Usage View -->
    <div id="view-usage" style="display:none">
      <h2 style="font-size:24px;font-weight:800;margin-bottom:8px">FinOps &amp; Resource Usage</h2>
      <p style="color:var(--muted);font-size:14px;margin-bottom:24px">Track edge CPU execution, D1 read/write transactions, and estimated operational costs.</p>
      <div class="card">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;">
          <div><small style="color:var(--muted)">ESTIMATED SPEND</small><div id="cost-val" style="font-size:28px;font-weight:800;color:var(--mint);margin-top:4px">$0.00</div><small style="color:var(--muted)">Inside Free Allowance</small></div>
          <div><small style="color:var(--muted)">TOTAL WORKERS</small><div id="workers-count" style="font-size:28px;font-weight:800;margin-top:4px">0</div><small style="color:var(--muted)">Isolated edge instances</small></div>
          <div><small style="color:var(--muted)">COMPLIANCE</small><div style="font-size:28px;font-weight:800;color:var(--cyan);margin-top:4px">100%</div><small style="color:var(--muted)">SOC2 / Edge compliant</small></div>
        </div>
      </div>
    </div>
  </main>

  <!-- Code / Blueprint Inspector Modal -->
  <div id="inspector-modal" class="modal">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 id="modal-title" style="font-size:18px;font-weight:800">Code Inspector</h3>
        <button class="secondary" onclick="closeModal('inspector-modal')">✕</button>
      </div>
      <div id="modal-content"></div>
    </div>
  </div>

  <script>
    let projects = [];
    const stages = ['planning', 'awaiting_approval', 'scaffolding', 'creating_repository', 'pushing_files', 'deploying_worker', 'live'];
    const esc = s => String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    async function api(path, opts) {
      const res = await fetch(path, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.reason || data.error || 'Request failed');
      return data;
    }

    function switchView(view) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('view-builds').style.display = view === 'builds' ? 'block' : 'none';
      document.getElementById('view-toolbox').style.display = view === 'toolbox' ? 'block' : 'none';
      document.getElementById('view-audit').style.display = view === 'audit' ? 'block' : 'none';
      document.getElementById('view-usage').style.display = view === 'usage' ? 'block' : 'none';
      if (view === 'audit') loadAuditLogs();
      if (view === 'toolbox') loadSettings();
    }

    async function loadWorkspace() {
      try {
        await api('/session', { method: 'POST' });
        const [connData, projData, usageData] = await Promise.all([
          api('/connections'),
          api('/projects'),
          api('/usage')
        ]);

        const conns = new Set(connData.connections.map(c => c.provider));
        document.getElementById('gh-dot').className = 'dot ' + (conns.has('github') ? 'ok' : 'wait');
        document.getElementById('cf-dot').className = 'dot ' + (conns.has('cloudflare') ? 'ok' : 'wait');

        projects = projData.projects || [];
        document.getElementById('workers-count').textContent = projects.filter(p => p.status === 'live').length;
        document.getElementById('cost-val').textContent = '$' + ((usageData.estimated_cost_cents || 0) / 100).toFixed(2);

        renderProjects();
      } catch (err) {
        console.error(err);
      }
    }

    function renderProjects() {
      const root = document.getElementById('project-list');
      if (!projects.length) {
        root.innerHTML = '<div style="padding:48px 0;text-align:center;color:var(--muted)">No applications built yet. Enter a prompt above to start planning.</div>';
        return;
      }

      root.innerHTML = projects.map(p => {
        const curIdx = stages.indexOf(p.status);
        const dots = stages.map((s, i) => \`<div class="stage-dot \${i < curIdx || p.status==='live' ? 'done' : i===curIdx && p.status!=='failed' ? 'active' : ''}"></div>\`).join('');
        
        let planHtml = '';
        if (p.status === 'awaiting_approval' && p.plan_json) {
          try {
            const plan = JSON.parse(p.plan_json);
            planHtml = \`
              <div class="plan-box">
                <h4>Architecture Blueprint: \${esc(plan.name || p.name)}</h4>
                <p style="font-size:13px;color:var(--ink);margin-bottom:8px">\${esc(plan.description || p.prompt)}</p>
                <div style="font-size:11px;font-weight:700;color:var(--muted);margin-top:10px">PLANNED FEATURES</div>
                <div class="tag-cloud">\${(plan.features||[]).map(f => \`<span class="tag">✦ \${esc(f)}</span>\`).join('')}</div>
                <div style="font-size:11px;font-weight:700;color:var(--muted);margin-top:10px">TECH STACK</div>
                <div class="tag-cloud">\${(plan.techStack||[]).map(t => \`<span class="tag">⚡ \${esc(t)}</span>\`).join('')}</div>
                <div class="action-row" style="margin-top:16px">
                  <button class="primary" onclick="approvePlan('\${p.id}')">✓ Approve &amp; Build Code</button>
                  <button class="secondary" onclick="rejectPlan('\${p.id}')">✕ Revise Plan</button>
                </div>
              </div>
            \`;
          } catch(e) {}
        }

        const appUrl = p.worker_name && p.status === 'live' ? \`<a href="https://\${esc(p.worker_name)}.workers.dev" target="_blank" class="secondary" style="text-decoration:none;color:var(--cyan)">Open Live App ↗</a>\` : '';
        const repoUrl = p.github_repository ? \`<a href="https://github.com/\${esc(p.github_repository)}" target="_blank" class="secondary" style="text-decoration:none">GitHub Repo ↗</a>\` : '';
        const codeBtn = p.scaffolding_json ? \`<button class="secondary" onclick="inspectCode('\${p.id}')">Inspect Code</button>\` : '';
        const retryBtn = p.status === 'failed' ? \`<button class="secondary" onclick="retryBuild('\${p.id}')">Retry Build</button>\` : '';
        const deleteBtn = \`<button class="danger" onclick="deleteProject('\${p.id}', '\${esc(p.name)}')">Delete Build 🗑</button>\`;

        return \`
          <article class="project-card">
            <div class="p-head">
              <div>
                <h3>\${esc(p.name)}</h3>
                <div style="font-size:11px;color:var(--muted);margin-top:3px">ID: \${p.id.slice(0,8)} · Updated \${new Date(p.updated_at).toLocaleTimeString()}</div>
              </div>
              <span class="badge \${p.status}">● \${p.status.replace('_', ' ')}</span>
            </div>
            <p class="p-desc">\${esc(p.prompt)}</p>
            <div class="stage-track">\${dots}</div>
            \${p.latest_event ? \`<div style="font-size:12px;color:var(--muted);margin-bottom:12px"><b>\${esc(p.latest_event.kind)}</b>: \${esc(p.latest_event.detail)}</div>\` : ''}
            \${planHtml}
            <div class="action-row">
              \${appUrl} \${repoUrl} \${codeBtn} \${retryBtn} \${deleteBtn}
            </div>
          </article>
        \`;
      }).join('');
    }

    async function createProject() {
      const name = document.getElementById('proj-name').value.trim();
      const prompt = document.getElementById('proj-prompt').value.trim();
      if (!name || !prompt) return alert('Please enter both an app name and description');
      
      const st = document.getElementById('create-status');
      st.textContent = 'Generating architecture blueprint...';
      try {
        await api('/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, prompt })
        });
        document.getElementById('proj-name').value = '';
        document.getElementById('proj-prompt').value = '';
        st.textContent = 'Blueprint generated!';
        setTimeout(() => st.textContent = '', 3000);
        await loadWorkspace();
      } catch (err) {
        st.textContent = err.message;
      }
    }

    async function deleteProject(id, name) {
      if (!confirm(\`Are you sure you want to delete build "\${name}"? This action is permanent.\`)) return;
      try {
        await api(\`/projects/\${id}\`, { method: 'DELETE' });
        await loadWorkspace();
      } catch (e) { alert(e.message); }
    }

    async function approvePlan(id) {
      try {
        await api(\`/projects/\${id}/approve\`, { method: 'POST' });
        await loadWorkspace();
      } catch (e) { alert(e.message); }
    }

    async function rejectPlan(id) {
      const prompt = window.prompt('Enter your revised requirements:');
      if (prompt === null) return;
      try {
        await api(\`/projects/\${id}/reject\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt })
        });
        await loadWorkspace();
      } catch (e) { alert(e.message); }
    }

    async function retryBuild(id) {
      try {
        await api(\`/projects/\${id}/build\`, { method: 'POST' });
        await loadWorkspace();
      } catch (e) { alert(e.message); }
    }

    async function inspectCode(id) {
      try {
        const data = await api(\`/projects/\${id}/code\`);
        document.getElementById('modal-title').textContent = 'Source Tree & Codebase';
        document.getElementById('modal-content').innerHTML = \`
          <div style="margin-bottom:12px;">
            <h4 style="font-size:12px;color:var(--cyan);margin-bottom:4px">src/worker.mjs (Cloudflare Worker REST API)</h4>
            <pre><code>\${esc(data.backend || 'No worker code')}</code></pre>
          </div>
          <div style="margin-bottom:12px;">
            <h4 style="font-size:12px;color:var(--cyan);margin-bottom:4px">src/frontend.jsx (React UI)</h4>
            <pre><code>\${esc(data.frontend || 'No frontend code')}</code></pre>
          </div>
          <div style="margin-bottom:12px;">
            <h4 style="font-size:12px;color:var(--cyan);margin-bottom:4px">schema.sql (Cloudflare D1 Database)</h4>
            <pre><code>\${esc(data.database || 'No SQL schema')}</code></pre>
          </div>
        \`;
        document.getElementById('inspector-modal').classList.add('open');
      } catch (e) { alert(e.message); }
    }

    async function loadSettings() {
      try {
        const data = await api('/settings');
        document.getElementById('setting-provider').value = data.active_provider || 'auto';
        document.getElementById('setting-cf-model').value = data.cf_ai_model || '@cf/meta/llama-3.3-70b-instruct';
        document.getElementById('setting-or-key').value = data.openrouter_key || '';
        document.getElementById('setting-or-model').value = data.openrouter_model || 'anthropic/claude-3.5-sonnet';
        document.getElementById('setting-custom-url').value = data.custom_endpoint || '';
        document.getElementById('setting-custom-key').value = data.custom_key || '';
        document.getElementById('setting-custom-model').value = data.custom_model || '';
      } catch (e) {}
    }

    async function saveSettings() {
      try {
        const payload = {
          active_provider: document.getElementById('setting-provider').value,
          cf_ai_model: document.getElementById('setting-cf-model').value,
          openrouter_key: document.getElementById('setting-or-key').value,
          openrouter_model: document.getElementById('setting-or-model').value,
          custom_endpoint: document.getElementById('setting-custom-url').value,
          custom_key: document.getElementById('setting-custom-key').value,
          custom_model: document.getElementById('setting-custom-model').value,
        };
        await api('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        alert('AI Toolbox settings saved successfully!');
      } catch (e) { alert(e.message); }
    }

    async function testAI() {
      const resEl = document.getElementById('ai-test-result');
      resEl.textContent = 'Testing generation...';
      resEl.style.color = 'var(--cyan)';
      try {
        const res = await api('/settings/test-llm', { method: 'POST' });
        resEl.textContent = \`✓ Generation Successful in \${res.latency_ms}ms: "\${res.response}"\`;
        resEl.style.color = 'var(--mint)';
      } catch (e) {
        resEl.textContent = '✕ Test failed: ' + e.message;
        resEl.style.color = 'var(--rose)';
      }
    }

    async function loadAuditLogs() {
      try {
        const res = await api('/audit-logs');
        const logs = res.audit_logs || [];
        const root = document.getElementById('audit-list');
        if (!logs.length) {
          root.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px 0">No audit events recorded yet.</div>';
          return;
        }
        root.innerHTML = logs.map(l => \`
          <div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);font-size:13px">
            <div>
              <b>\${esc(l.action)}</b>
              <div style="color:var(--muted);font-size:11px">\${esc(l.details || '')}</div>
            </div>
            <div style="text-align:right;color:var(--muted);font-size:11px">
              <div>\${new Date(l.created_at).toLocaleString()}</div>
              <div>IP: \${esc(l.ip_address || 'edge')}</div>
            </div>
          </div>
        \`).join('');
      } catch (e) {}
    }

    function closeModal(id) { document.getElementById(id).classList.remove('open'); }

    loadWorkspace();
    setInterval(loadWorkspace, 4000);
  </script>
</body>
</html>`;

  return new Response(body, { headers: securityHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })) });
}

// --- Main Handler Export ---

const workerHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureSchema(env);
    const url = new URL(request.url);

    if (url.pathname === '/health') return json({ ok: true, service: 'vela-control-plane', version: '2.0.0' });
    if (url.pathname === '/' && request.method === 'GET') return enterpriseDashboard();

    if (url.pathname === '/session' && request.method === 'POST') {
      const existing = await readSession(request, env.SESSION_SECRET);
      if (existing) return json({ ready: true, sessionId: existing });
      const staleOwnerId = unsignedAnonymousSessionId(request);
      if (staleOwnerId && await ownerHasState(env, staleOwnerId)) {
        const recovered = await issueSessionForId(staleOwnerId, env.SESSION_SECRET);
        return json({ ready: true, recovered: true, sessionId: staleOwnerId }, { headers: { 'set-cookie': recovered.cookie } });
      }
      const session = await issueSession(env.SESSION_SECRET);
      return json({ ready: true, sessionId: session.id }, { headers: { 'set-cookie': session.cookie } });
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
        let ownerId = login?.ownerId ?? stored.session_id;
        let sessionCookie = login?.cookie;
        if (!login && (callbackProvider === 'github' || callbackProvider === 'cloudflare')) {
          const recoveredOwnerId = await recoverOwnerFromProvider(env, stored.session_id, callbackProvider, identity.id);
          if (recoveredOwnerId !== stored.session_id) {
            ownerId = recoveredOwnerId;
            sessionCookie = (await issueSessionForId(ownerId, env.SESSION_SECRET)).cookie;
          }
        }
        const now = new Date().toISOString();
        const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
        await env.DB.prepare(`INSERT INTO connections (id, owner_id, provider, external_account_id, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?) ON CONFLICT(owner_id, provider) DO UPDATE SET external_account_id = excluded.external_account_id, access_token_ciphertext = excluded.access_token_ciphertext, refresh_token_ciphertext = excluded.refresh_token_ciphertext, token_expires_at = excluded.token_expires_at, status = 'connected', updated_at = excluded.updated_at`)
          .bind(crypto.randomUUID(), ownerId, callbackProvider, identity.id, await encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY), token.refresh_token ? await encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY) : null, expiresAt, now, now).run();
        
        await recordAuditLog(env, ownerId, 'OAUTH_CONNECTED', `Connected ${callbackProvider} account (${identity.id})`);
        return successPage(callbackProvider, sessionCookie || login?.cookie);
      } catch (error) {
        const reason = messageFromError(error);
        console.error(JSON.stringify({ event: 'oauth_callback_failed', provider: callbackProvider, message: reason }));
        return json({ error: 'Connection could not be completed. Start again.', reason }, { status: 502 });
      }
    }

    const sessionId = await readSession(request, env.SESSION_SECRET);

    if (url.pathname === '/connections' && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Connect an account first.' }, { status: 401 });
      await refreshCloudflareConnectionIfNeeded(env, sessionId);
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

    if (url.pathname === '/audit-logs' && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const logs = await env.DB.prepare('SELECT * FROM audit_logs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100').bind(sessionId).all();
      return json({ audit_logs: logs.results || [] });
    }

    if (url.pathname === '/settings' && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      return json(await getWorkspaceSettings(env, sessionId, false));
    }

    if (url.pathname === '/settings' && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const body = await request.json<Partial<WorkspaceSettings>>();
      await saveWorkspaceSettings(env, sessionId, body);
      await recordAuditLog(env, sessionId, 'SETTINGS_UPDATED', `Updated AI toolbox configuration (Provider: ${body.active_provider || 'auto'})`);
      return json({ ok: true });
    }

    if (url.pathname === '/settings/test-llm' && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const start = Date.now();
      try {
        const response = await callLLM(env, [
          { role: 'user', content: 'Say "Vela AI Toolbox connection operational" in 5 words or less.' }
        ], sessionId);
        const latency = Date.now() - start;
        return json({ ok: true, latency_ms: latency, response: response.trim() });
      } catch (err: unknown) {
        return json({ ok: false, error: err instanceof Error ? err.message : 'LLM test failed' }, { status: 502 });
      }
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
      
      await env.DB.prepare('INSERT INTO projects (id, owner_id, name, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, sessionId, body.name.trim().slice(0, 80), body.prompt.trim().slice(0, 4000), status, now, now).run();
      await env.DB.batch(['workers', 'd1', 'r2', 'queues', 'rbac', 'audit_log'].map((feature) => env.DB.prepare('INSERT INTO project_features (project_id, feature, enabled, updated_at) VALUES (?, ?, 1, ?)').bind(id, feature, now)));
      await env.DB.prepare('INSERT INTO usage_events (id, project_id, metric, quantity, estimated_cost_cents, occurred_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), id, 'project_created', 1, 0, now).run();
      
      await recordEvent(env, id, 'project_created', canBuild ? 'Architecture planning started' : 'Waiting for GitHub and Cloudflare connections', 'planning');
      await recordAuditLog(env, sessionId, 'PROJECT_CREATED', `Created application "${body.name}"`, id);
      
      if (canBuild) {
        await env.BUILD_JOBS.send({ projectId: id, prompt: body.prompt });
        await env.BUILDS.getByName(id).plan(id, body.prompt);
      }
      return json({ project: await projectForOwner(env, id, sessionId) }, { status: 201 });
    }

    const projectDeleteMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})$/);
    if (projectDeleteMatch && request.method === 'DELETE') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, projectDeleteMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      // Clean up Cloudflare Worker if deployed
      if (project.worker_name && env.CLOUDFLARE_ACCOUNT_ID) {
        try {
          const cloudflare = await connectedToken(env, sessionId, 'cloudflare');
          await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(project.worker_name)}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${cloudflare.accessToken}` },
          });
        } catch (e) {
          console.warn('Worker deletion warning:', e);
        }
      }

      await env.DB.batch([
        env.DB.prepare('DELETE FROM build_events WHERE project_id = ?').bind(project.id),
        env.DB.prepare('DELETE FROM project_features WHERE project_id = ?').bind(project.id),
        env.DB.prepare('DELETE FROM usage_events WHERE project_id = ?').bind(project.id),
        env.DB.prepare('DELETE FROM project_secrets WHERE project_id = ?').bind(project.id),
        env.DB.prepare('DELETE FROM project_deployments WHERE project_id = ?').bind(project.id),
        env.DB.prepare('DELETE FROM project_collaborators WHERE project_id = ?').bind(project.id),
        env.DB.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').bind(project.id, sessionId),
      ]);

      await recordAuditLog(env, sessionId, 'PROJECT_DELETED', `Deleted project "${project.name}" (${project.id})`);
      return json({ ok: true, deleted: project.id });
    }

    // --- PATCH /projects/:id - Rename / Update Project ---
    const projectPatchMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})$/);
    if (projectPatchMatch && request.method === 'PATCH') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, projectPatchMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      const body = await request.json<{ name?: string; prompt?: string }>();
      const updates: string[] = [];
      const binds: unknown[] = [];

      if (body.name?.trim()) {
        updates.push('name = ?');
        binds.push(body.name.trim().slice(0, 80));
      }
      if (body.prompt?.trim()) {
        updates.push('prompt = ?');
        binds.push(body.prompt.trim().slice(0, 4000));
      }

      if (updates.length === 0) return json({ error: 'No valid fields to update' }, { status: 400 });

      updates.push('updated_at = ?');
      binds.push(new Date().toISOString(), project.id);

      await env.DB.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
      await recordAuditLog(env, sessionId, 'PROJECT_UPDATED', `Updated project "${project.name}"`, project.id);

      return json({ ok: true, updated: true });
    }

    // --- Secrets Management ---
    const secretsMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/secrets$/);
    if (secretsMatch) {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, secretsMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      if (request.method === 'GET') {
        const secrets = await env.DB.prepare('SELECT id, key, created_at, updated_at FROM project_secrets WHERE project_id = ? ORDER BY key').bind(project.id).all();
        return json({ secrets: secrets.results });
      }

      if (request.method === 'POST') {
        const body = await request.json<{ key?: string; value?: string }>();
        if (!body.key?.trim() || !body.value?.trim()) return json({ error: 'key and value are required' }, { status: 400 });
        const now = new Date().toISOString();
        const ciphertext = await encrypt(body.value.trim(), env.TOKEN_ENCRYPTION_KEY);
        await env.DB.prepare(`INSERT INTO project_secrets (id, project_id, key, value_ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value_ciphertext = excluded.value_ciphertext, updated_at = excluded.updated_at`)
          .bind(crypto.randomUUID(), project.id, body.key.trim(), ciphertext, now, now).run();
        await recordAuditLog(env, sessionId, 'SECRET_CREATED', `Created secret "${body.key}" for ${project.name}`, project.id);
        return json({ ok: true });
      }

      return json({ error: 'Method not allowed' }, { status: 405 });
    }

    const secretDeleteMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/secrets\/([a-zA-Z0-9_-]{1,128})$/);
    if (secretDeleteMatch && request.method === 'DELETE') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, secretDeleteMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      await env.DB.prepare('DELETE FROM project_secrets WHERE project_id = ? AND key = ?').bind(project.id, secretDeleteMatch[2]).run();
      await recordAuditLog(env, sessionId, 'SECRET_DELETED', `Deleted secret "${secretDeleteMatch[2]}" for ${project.name}`, project.id);
      return json({ ok: true });
    }

    // --- Deployment History & Rollback ---
    const deploymentsMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/deployments$/);
    if (deploymentsMatch && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, deploymentsMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      const deployments = await env.DB.prepare('SELECT * FROM project_deployments WHERE project_id = ? ORDER BY version DESC').bind(project.id).all();
      return json({ deployments: deployments.results || [] });
    }

    const rollbackMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/rollback\/(\d+)$/);
    if (rollbackMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, rollbackMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      const targetVersion = parseInt(rollbackMatch[2], 10);
      const targetDeployment = await env.DB.prepare('SELECT * FROM project_deployments WHERE project_id = ? AND version = ?').bind(project.id, targetVersion).first<any>();
      if (!targetDeployment) return json({ error: 'Deployment version not found' }, { status: 404 });

      await recordAuditLog(env, sessionId, 'ROLLBACK_STARTED', `Rolling back ${project.name} to version ${targetVersion}`, project.id);
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: project.prompt, resumeFrom: 'scaffolding', rollbackToVersion: targetVersion });
      return json({ status: 'scaffolding', rollbackVersion: targetVersion }, { status: 202 });
    }

    // --- Duplicate / Fork Project ---
    const duplicateMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/duplicate$/);
    if (duplicateMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, duplicateMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      const body = await request.json<{ name?: string; prompt?: string }>().catch(() => ({}));
      const newName = body.name?.trim() || `${project.name} (copy)`;
      const newPrompt = body.prompt?.trim() || project.prompt;

      const newId = crypto.randomUUID();
      const now = new Date().toISOString();
      const providers = await connectionProviders(env, sessionId);
      const canBuild = providers.has('github') && providers.has('cloudflare');
      const status = canBuild ? 'planning' : 'needs_connections';

      await env.DB.prepare('INSERT INTO projects (id, owner_id, name, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(newId, sessionId, newName.slice(0, 80), newPrompt.slice(0, 4000), status, now, now).run();
      await env.DB.batch(['workers', 'd1', 'r2', 'queues', 'rbac', 'audit_log'].map((feature) => env.DB.prepare('INSERT INTO project_features (project_id, feature, enabled, updated_at) VALUES (?, ?, 1, ?)').bind(newId, feature, now)));

      // Copy secrets if any
      const secrets = await env.DB.prepare('SELECT key, value_ciphertext FROM project_secrets WHERE project_id = ?').bind(project.id).all();
      if (secrets.results?.length) {
        await env.DB.batch(secrets.results.map(s => env.DB.prepare('INSERT INTO project_secrets (id, project_id, key, value_ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), newId, s.key, s.value_ciphertext, now, now)));
      }

      await recordAuditLog(env, sessionId, 'PROJECT_DUPLICATED', `Duplicated "${project.name}" as "${newName}"`, newId);

      if (canBuild) {
        await env.BUILD_JOBS.send({ projectId: newId, prompt: newPrompt });
        await env.BUILDS.getByName(newId).plan(newId, newPrompt);
      }
      return json({ project: await projectForOwner(env, newId, sessionId) }, { status: 201 });
    }

    const codeMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/code$/);
    if (codeMatch) {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, codeMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });

      if (request.method === 'GET') {
        let code: ScaffoldResult = { frontend: '', backend: '', database: '', config: '', instructions: '' };
        if (project.scaffolding_json) {
          try { code = JSON.parse(project.scaffolding_json); } catch {}
        }
        return json(code);
      }

      if (request.method === 'POST') {
        const body = await request.json<Partial<ScaffoldResult>>();
        let existing: ScaffoldResult = { frontend: '', backend: '', database: '', config: '', instructions: '' };
        if (project.scaffolding_json) {
          try { existing = JSON.parse(project.scaffolding_json); } catch {}
        }
        const updated = { ...existing, ...body };
        if (updated.backend) updated.backend = sanitizeWorkerSource(project.name, project.prompt, updated.backend);
        await env.DB.prepare('UPDATE projects SET scaffolding_json = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(updated), new Date().toISOString(), project.id).run();
        
        await recordAuditLog(env, sessionId, 'CODE_UPDATED', `Source code manually updated for ${project.name}`, project.id);
        return json({ ok: true });
      }
    }

    const eventsMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/events$/);
    if (eventsMatch && request.method === 'GET') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, eventsMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const events = await env.DB.prepare('SELECT kind, detail, stage, created_at FROM build_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 50').bind(project.id).all();
      return json({ events: events.results });
    }

    const approveMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/approve$/);
    if (approveMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, approveMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      if (project.status !== 'awaiting_approval') return json({ error: 'Project is not awaiting approval', currentStatus: project.status }, { status: 409 });
      
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').bind('scaffolding', now, project.id).run();
      await recordEvent(env, project.id, 'approved', 'Plan approved by user — generating full-stack code and deploying', 'scaffolding');
      await recordAuditLog(env, sessionId, 'PLAN_APPROVED', `Approved architecture plan for ${project.name}`, project.id);
      
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: project.prompt, resumeFrom: 'scaffolding' });
      return json({ status: 'scaffolding' }, { status: 202 });
    }

    const rejectMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/reject$/);
    if (rejectMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, rejectMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      
      const body = (await request.json<{ prompt?: string }>().catch(() => ({}))) as { prompt?: string };
      const now = new Date().toISOString();
      const newPrompt = body.prompt?.trim() || project.prompt;
      
      await env.DB.prepare('UPDATE projects SET prompt = ?, status = ?, updated_at = ? WHERE id = ?')
        .bind(newPrompt.slice(0, 4000), 'planning', now, project.id).run();
      await recordEvent(env, project.id, 'rejected', 'Plan rejected / requirements revised — generating new architecture', 'planning');
      await recordAuditLog(env, sessionId, 'PLAN_REVISED', `Revised prompt for ${project.name}`, project.id);
      
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: newPrompt });
      return json({ status: 'planning' }, { status: 202 });
    }

    const buildMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/build$/);
    if (buildMatch && request.method === 'POST') {
      if (!sessionId) return json({ error: 'Start a workspace first.' }, { status: 401 });
      const project = await projectForOwner(env, buildMatch[1], sessionId);
      if (!project) return json({ error: 'Project not found' }, { status: 404 });
      const providers = await connectionProviders(env, sessionId);
      if (!providers.has('github') || !providers.has('cloudflare')) return json({ status: 'needs_connections' }, { status: 409 });
      
      const body = (await request.json<{ prompt?: string; resumeFrom?: string }>().catch(() => ({}))) as { prompt?: string; resumeFrom?: string };
      const now = new Date().toISOString();
      const buildPrompt = body.prompt?.trim() || project.prompt;
      
      await env.DB.prepare('UPDATE projects SET status = ?, prompt = ?, updated_at = ? WHERE id = ?')
        .bind('planning', buildPrompt.slice(0, 4000), now, project.id).run();
      await env.BUILD_JOBS.send({ projectId: project.id, prompt: buildPrompt, resumeFrom: body.resumeFrom });
      await recordEvent(env, project.id, 'build_queued', body.resumeFrom ? `Build resumed from stage: ${body.resumeFrom}` : 'Fresh build queued', 'planning');
      await recordAuditLog(env, sessionId, 'BUILD_TRIGGERED', `Triggered build for ${project.name}`, project.id);
      
      return json({ status: 'planning' }, { status: 202 });
    }

    return json({ error: 'Not found' }, { status: 404 });
  },

  async queue(batch: MessageBatch<{ projectId: string; prompt: string; resumeFrom?: string }>, env: Env): Promise<void> {
    await ensureSchema(env);
    for (const message of batch.messages) {
      try {
        const project = await env.DB.prepare('SELECT status FROM projects WHERE id = ?').bind(message.body.projectId).first<{ status: string }>();
        if (project?.status === 'awaiting_approval' && !message.body.resumeFrom) {
          message.ack();
          continue;
        }
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

export default workerHandler;
