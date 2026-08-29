import worker, { BuildCoordinator } from './index';

export { BuildCoordinator };

type RuntimeEnv = Record<string, unknown> & {
  DB?: D1Database;
  AI?: Ai;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string | CryptoKey;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  CLOUDFLARE_AI_MODEL?: string;
};

type ChatMessage = { role: string; content: string };
type ChatPayload = { model?: string; messages?: ChatMessage[]; max_tokens?: number; temperature?: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nativeFetch = globalThis.fetch.bind(globalThis);
const OPENROUTER_FALLBACK_SENTINEL = '__vela_cloudflare_ai_fallback__';
let currentAI: Ai | undefined;
let currentCloudflareModel = '@cf/meta/llama-3.1-8b-instruct-fast';
let currentOpenRouterKey: string | undefined;
let currentOpenRouterModel: string | undefined;
let fetchFallbackInstalled = false;
const workerSourceCache = new Map<string, string>();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64Standard(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  return decoder.decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
}

function normalizeBindValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

function normalizeD1(db: D1Database): D1Database {
  return {
    prepare(query: string) {
      const statement = db.prepare(query);
      return {
        bind(...values: unknown[]) {
          let normalizedValues = values.map(normalizeBindValue);
          if (
            query === 'UPDATE projects SET scaffolding_json = ?, updated_at = ? WHERE id = ?' &&
            normalizedValues.length === 2
          ) normalizedValues = [normalizedValues[0], new Date().toISOString(), normalizedValues[1]];
          return statement.bind(...normalizedValues);
        },
        first: statement.first.bind(statement),
        run: statement.run.bind(statement),
        all: statement.all.bind(statement),
        raw: statement.raw.bind(statement),
      } as D1PreparedStatement;
    },
    batch: db.batch.bind(db),
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
  } as D1Database;
}

function cleanWorkerCandidate(source: string): string {
  let cleaned = String(source || '').trim();
  const blocks = Array.from(cleaned.matchAll(/```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)```/g), match => match[1]);
  const workerBlock = blocks.find(block => /\bexport\s+default\b/.test(block));
  if (workerBlock) cleaned = workerBlock.trim();
  cleaned = cleaned.replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '').trim();
  return cleaned;
}

function cleanModuleText(source: string): string {
  let cleaned = String(source || '').trim();
  const fenced = cleaned.match(/^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenced?.[1]) cleaned = fenced[1].trim();
  return cleaned.replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '').trim();
}

function repairGeneratedWorkerSource(source: string): string {
  let repaired = cleanWorkerCandidate(source);
  repaired = repaired.replaceAll(".replace(///g, '_')", ".replaceAll('/', '_')");
  repaired = repaired.replaceAll('.replace(///g, "_")', '.replaceAll("/", "_")');
  repaired = repaired.replace(/\.replace\(\/\+\/g/g, '.replace(/[+]/g');
  repaired = repaired.replace(/\.replace\(\/\.\/g/g, '.replace(/[.]/g');
  repaired = repaired.replace(/\.replace\(\/\?\/g/g, '.replace(/[?]/g');
  repaired = repaired.replace(/\.replace\(\/\\w\+\/g/g, '.replace(/[a-zA-Z0-9_]+/g');
  repaired = repaired.replace(/\.replace\(\/\\s\+\/g/g, '.replace(/[\\s]+/g');
  return repaired.trim();
}

function obviousWorkerProblem(source: string): string | null {
  if (!source.trim()) return 'empty worker source';
  if (source.includes('```')) return 'markdown code fence remained in worker source';
  if (source.includes('.replace(///')) return 'malformed slash regular expression';
  const defaultExports = source.match(/\bexport\s+default\b/g)?.length ?? 0;
  if (defaultExports !== 1) return `expected exactly one default export, found ${defaultExports}`;
  if (/\bnew\s+Function\s*\(|\beval\s*\(/.test(source)) return 'runtime code generation is not allowed in Cloudflare Workers';
  return null;
}

function looksLikeGenericEnterpriseFallback(source: string): boolean {
  return (
    source.includes('ENTERPRISE MIDDLEWARE & UTILITIES') &&
    source.includes('function generateOpenAPISpec') &&
    source.includes("'/api/items'")
  ) || (
    source.includes('Active Records') &&
    source.includes('Security Posture') &&
    source.includes('RBAC Enforced')
  );
}

function sourceDescription(source: string): string {
  const match = source.match(/\bconst\s+APP_DESC\s*=\s*("(?:\\.|[^"\\])*")\s*;/);
  if (!match?.[1]) return '';
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

function appNameFromSource(source: string): string {
  const match = source.match(/\bconst\s+APP_NAME\s*=\s*("(?:\\.|[^"\\])*")\s*;/);
  if (!match?.[1]) return 'Vela application';
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : 'Vela application';
  } catch {
    return 'Vela application';
  }
}

function isComplexDemand(text: string): boolean {
  const lower = text.toLowerCase();
  return text.length > 7000 || /\b(complex|production-grade|comprehensive|full-stack)\b/.test(lower) &&
    /(database|d1|tests?|pipeline|analysis|dashboard|api)/.test(lower);
}

function domainTokens(text: string): string[] {
  const stop = new Set(['build','create','application','app','full','stack','production','grade','comprehensive','cloudflare','worker','database','real','data','user','using','with','from','that','this','must','should','support','implement']);
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [];
  const counts = new Map<string, number>();
  for (const word of words) if (!stop.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
  return [...counts.entries()].sort((a,b) => b[1] - a[1]).slice(0, 12).map(([word]) => word);
}

function appSpecificityProblem(source: string): string | null {
  const requirements = sourceDescription(source);
  if (!requirements || !isComplexDemand(requirements)) return null;
  if (looksLikeGenericEnterpriseFallback(source)) return 'generic enterprise fallback does not implement the requested complex application';
  if (source.length < 18000) return `complex application worker is implausibly small (${source.length} bytes)`;
  const tokens = domainTokens(requirements);
  const hits = tokens.filter(token => source.toLowerCase().includes(token)).length;
  if (tokens.length >= 6 && hits < Math.min(4, Math.ceil(tokens.length / 3))) return `worker lacks requested domain implementation (${hits}/${tokens.length} domain signals present)`;
  if (!/text\/html|<!doctype html|<html/i.test(source)) return 'complex application does not contain a production UI at the root route';
  if (!/\/api\//.test(source)) return 'complex application does not contain application APIs';
  return null;
}

async function requestOpenRouter(messages: ChatMessage[], maxTokens: number, temperature = 0.1): Promise<string | null> {
  if (!currentOpenRouterKey || !currentOpenRouterModel) return null;
  try {
    const response = await nativeFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${currentOpenRouterKey}`,
        'content-type': 'application/json',
        'x-title': 'Vela Modular Builder',
      },
      body: JSON.stringify({ model: currentOpenRouterModel, messages, temperature, max_tokens: maxTokens }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

async function requestWorkersAI(messages: ChatMessage[], maxTokens: number): Promise<string | null> {
  if (!currentAI) return null;
  try {
    const result = await currentAI.run(currentCloudflareModel as Parameters<Ai['run']>[0], {
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
    } as never) as { response?: string } | string;
    return typeof result === 'string' ? result : result?.response || null;
  } catch {
    return null;
  }
}

async function generateModule(messages: ChatMessage[], maxTokens: number): Promise<string | null> {
  return await requestOpenRouter(messages, maxTokens) || await requestWorkersAI(messages, Math.min(maxTokens, 8192));
}

async function repairWorkerWithAI(source: string, reason: string): Promise<string | null> {
  const appName = appNameFromSource(source);
  const requirements = sourceDescription(source);
  const cappedSource = source.slice(0, 75000);
  const cappedRequirements = requirements.slice(0, 50000);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are Vela's production Cloudflare Worker repair engineer. Return ONLY one complete JavaScript ES-module Worker, no Markdown fences and no explanation. Preserve and implement the requested application rather than replacing it with a generic demo. The root route must render the actual polished usable application. Keep real domain-specific APIs, deterministic calculations, persistence, research/evidence behavior and honest empty/unavailable states. Never invent current real-world data. Never use eval or new Function. If D1 is used, create required tables idempotently and gracefully handle missing bindings so / can render. Exactly one export default is required.`,
    },
    {
      role: 'user',
      content: `Application: ${appName}\nRepair reason: ${reason}\n\nAuthoritative requirements:\n${cappedRequirements || 'Preserve every application-specific feature already present in the source.'}\n\nCurrent Worker source:\n${cappedSource}`,
    },
  ];

  const candidateText = await generateModule(messages, 14000);
  if (!candidateText) return null;
  const candidate = repairGeneratedWorkerSource(candidateText);
  const problem = obviousWorkerProblem(candidate) || appSpecificityProblem(candidate);
  if (!problem && !looksLikeGenericEnterpriseFallback(candidate)) {
    console.warn(JSON.stringify({ event: 'worker_ai_repair_succeeded', reason, bytes: candidate.length }));
    return candidate;
  }
  console.warn(JSON.stringify({ event: 'worker_ai_repair_rejected', reason, problem }));
  return null;
}

function scaffoldRequest(payload: ChatPayload): { requirements: string; plan: string } | null {
  const messages = payload.messages || [];
  const system = messages.find(message => message.role === 'system')?.content || '';
  if (!/elite agentic full-stack app builder/i.test(system) || !/FRONTEND:.*BACKEND:.*DATABASE:/s.test(system)) return null;
  const user = messages.find(message => message.role === 'user')?.content || '';
  const match = user.match(/^Scaffold full-stack app for:\s*([\s\S]*?)\nPlan:\s*([\s\S]*)$/);
  return { requirements: (match?.[1] || user).trim(), plan: (match?.[2] || '{}').trim() };
}

async function generateModularScaffold(requirements: string, plan: string): Promise<string | null> {
  const req = requirements.slice(0, 52000);
  const common = `AUTHORITATIVE APPLICATION REQUIREMENTS:\n${req}\n\nARCHITECTURE PLAN:\n${plan.slice(0, 12000)}`;
  const complex = isComplexDemand(req);

  const backend = await generateModule([
    { role: 'system', content: `You are the backend/runtime engineer in a production app-builder pipeline. Return ONLY a complete JavaScript ES-module Cloudflare Worker, no Markdown. Exactly one export default. The Worker must itself serve the actual polished responsive production UI at / because this source is what Cloudflare deploys. Implement domain-specific APIs and deterministic business/calculation logic required by the demand. Use D1 through env.DB when appropriate; create required tables idempotently before use and degrade honestly if DB is unavailable. Do not use eval/new Function. Do not invent current real-world data; empty states must say unavailable/not yet ingested. Do not substitute a generic CRUD dashboard. Include /api/health and /api/self-test where /api/self-test executes deterministic calculation invariants and returns pass/fail details.` },
    { role: 'user', content: common },
  ], complex ? 15000 : 10000);
  if (!backend) return null;

  const cleanedBackend = repairGeneratedWorkerSource(backend);
  const backendProblem = obviousWorkerProblem(cleanedBackend) || appSpecificityProblem(cleanedBackend);
  if (backendProblem) {
    console.warn(JSON.stringify({ event: 'modular_backend_rejected', problem: backendProblem }));
    return null;
  }

  const database = await generateModule([
    { role: 'system', content: `You are the D1 schema engineer. Return ONLY executable SQLite/D1 SQL, no Markdown. Build a normalized domain-specific schema with relationships and indexes required by the application. CREATE TABLE/INDEX statements must be idempotent. Never add fake current production records; only schema and clearly safe configuration defaults.` },
    { role: 'user', content: common },
  ], 7000);

  const frontend = await generateModule([
    { role: 'system', content: `You are the frontend engineer. Return ONLY one self-contained React component source file, no Markdown. It must be a polished responsive interface for the actual requested domain, use the backend's domain APIs, show loading/error/empty/stale/unavailable states honestly, and contain no fake current data. Do not import nonexistent local modules or Supabase/NextAuth. React itself may be imported. This file is source ownership/reference; the Worker root UI remains the deployed production UI.` },
    { role: 'user', content: common },
  ], 8500);

  const config = `{
  "name": "vela-generated-app",
  "main": "src/worker.mjs",
  "compatibility_date": "2026-08-25",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{"binding":"DB","database_name":"provisioned-by-vela","database_id":"PROVISIONED_BY_VELA_AT_DEPLOY"}]
}`;

  const instructions = await generateModule([
    { role: 'system', content: `Write concise but serious Markdown documentation for the requested application. Cover implemented architecture, domain capabilities, API routes, D1 model, deterministic calculations, data ingestion/provenance, local/deployment notes, testing/self-test, security, free-tier constraints, and honest limitations. Do not claim unimplemented functionality or successful tests that were not actually run.` },
    { role: 'user', content: common },
  ], 4500);

  const sections = [
    `FRONTEND:\n${cleanModuleText(frontend || '// Frontend source is served directly by src/worker.mjs at runtime.')}`,
    `BACKEND:\n${cleanedBackend}`,
    `DATABASE:\n${cleanModuleText(database || 'CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);')}`,
    `CONFIG:\n${config}`,
    `INSTRUCTIONS:\n${cleanModuleText(instructions || '# Generated application\n\nSee src/worker.mjs and schema.sql.')}`,
  ];
  console.warn(JSON.stringify({ event: 'modular_scaffold_generated', complex, backendBytes: cleanedBackend.length, frontendBytes: frontend?.length || 0, databaseBytes: database?.length || 0 }));
  return sections.join('\n');
}

function openAiCompatibleResponse(content: string): Response {
  return Response.json({
    id: `vela-modular-${crypto.randomUUID()}`,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

function isCloudflareWorkerUpload(url: string, init?: RequestInit): init is RequestInit & { body: FormData } {
  return url.includes('api.cloudflare.com/client/v4/accounts/') &&
    url.includes('/workers/scripts/') &&
    init?.method?.toUpperCase() === 'PUT' &&
    init.body instanceof FormData;
}

async function replaceWorkerModule(init: RequestInit & { body: FormData }, source: string): Promise<RequestInit & { body: FormData }> {
  const form = new FormData();
  for (const [key, value] of init.body.entries()) {
    if (key === 'worker.mjs') continue;
    form.append(key, value);
  }
  form.set('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');
  return { ...init, body: form };
}

async function ensureApplicationSpecificSource(source: string, reasonPrefix: string): Promise<string> {
  let candidate = repairGeneratedWorkerSource(source);
  const problem = obviousWorkerProblem(candidate) || appSpecificityProblem(candidate);
  if (!problem && !looksLikeGenericEnterpriseFallback(candidate)) return candidate;

  const repaired = await repairWorkerWithAI(candidate, `${reasonPrefix}: ${problem || 'generic enterprise fallback'}`);
  if (repaired) return repaired;

  throw new Error(`Vela refused to publish a placeholder or invalid Worker: ${problem || 'generic fallback could not be repaired'}`);
}

async function prepareCloudflareWorkerUpload(url: string, init?: RequestInit): Promise<RequestInit | undefined> {
  if (!isCloudflareWorkerUpload(url, init)) return init;
  const module = init.body.get('worker.mjs');
  if (!(module instanceof Blob)) return init;
  const raw = await module.text();
  const previous = workerSourceCache.get(url);
  const basis = looksLikeGenericEnterpriseFallback(raw) && previous && !looksLikeGenericEnterpriseFallback(previous) ? previous : raw;
  const source = await ensureApplicationSpecificSource(basis, 'pre-deploy validation');
  if (!looksLikeGenericEnterpriseFallback(source)) workerSourceCache.set(url, source);
  if (source === raw) return init;
  console.warn(JSON.stringify({ event: 'worker_source_repaired_before_upload', bytes: source.length }));
  return replaceWorkerModule(init, source);
}

function isCloudflareSyntaxFailure(status: number, detail: string): boolean {
  return status === 400 && /10021|SyntaxError|Unexpected token|already been declared|parse|syntax|code generation from strings/i.test(detail);
}

async function cloudflareWorkerFetch(input: RequestInfo | URL, init: RequestInit & { body: FormData }): Promise<Response> {
  const first = await nativeFetch(input, init);
  if (first.ok) return first;
  const detail = await first.clone().text().catch(() => '');
  if (!isCloudflareSyntaxFailure(first.status, detail)) return first;
  const module = init.body.get('worker.mjs');
  if (!(module instanceof Blob)) return first;
  const rejectedSource = await module.text();
  const repaired = await repairWorkerWithAI(rejectedSource, `Cloudflare rejected the module: ${detail.slice(0, 1200)}`);
  if (!repaired) return first;
  const retryInit = await replaceWorkerModule(init, repaired);
  workerSourceCache.set(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, repaired);
  console.warn(JSON.stringify({ event: 'cloudflare_worker_rejected_then_ai_repaired', status: first.status }));
  return nativeFetch(input, retryInit);
}

async function repairGithubWorkerWrite(url: string, init?: RequestInit): Promise<RequestInit | undefined> {
  if (!url.includes('api.github.com/repos/') || !url.includes('/contents/src/worker.mjs') || init?.method?.toUpperCase() !== 'PUT' || typeof init.body !== 'string') return init;
  try {
    const payload = JSON.parse(init.body) as { content?: string } & Record<string, unknown>;
    if (!payload.content) return init;
    const raw = decodeBase64Utf8(payload.content);
    const source = await ensureApplicationSpecificSource(raw, 'pre-GitHub source validation');
    if (source === raw) return init;
    payload.content = base64Standard(encoder.encode(source));
    console.warn(JSON.stringify({ event: 'github_worker_write_repaired', bytes: source.length }));
    return { ...init, body: JSON.stringify(payload) };
  } catch (error) {
    console.error(JSON.stringify({ event: 'github_worker_write_blocked', reason: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}

function captureOpenRouterRuntime(init?: RequestInit): ChatPayload | null {
  try {
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1] && match[1] !== OPENROUTER_FALLBACK_SENTINEL) currentOpenRouterKey = match[1];
    if (typeof init?.body === 'string') {
      const payload = JSON.parse(init.body) as ChatPayload;
      if (typeof payload.model === 'string' && payload.model.trim()) currentOpenRouterModel = payload.model.trim();
      return payload;
    }
  } catch {}
  return null;
}

function installFetchGuards(): void {
  if (fetchFallbackInstalled) return;
  fetchFallbackInstalled = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    let openRouterPayload: ChatPayload | null = null;
    if (url === 'https://openrouter.ai/api/v1/chat/completions') openRouterPayload = captureOpenRouterRuntime(init);

    init = await repairGithubWorkerWrite(url, init);
    init = await prepareCloudflareWorkerUpload(url, init);
    if (isCloudflareWorkerUpload(url, init)) return cloudflareWorkerFetch(input, init);
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') return nativeFetch(input, init);

    const scaffold = openRouterPayload ? scaffoldRequest(openRouterPayload) : null;
    if (scaffold) {
      const generated = await generateModularScaffold(scaffold.requirements, scaffold.plan);
      if (generated) return openAiCompatibleResponse(generated);
      console.error(JSON.stringify({ event: 'modular_scaffold_generation_failed', requirementsLength: scaffold.requirements.length }));
    }

    const headers = new Headers(init?.headers);
    const fallbackOnly = headers.get('authorization') === `Bearer ${OPENROUTER_FALLBACK_SENTINEL}`;
    if (!fallbackOnly) {
      try {
        const primary = await nativeFetch(input, init);
        if (primary.ok || !currentAI) return primary;
        console.warn(JSON.stringify({ event: 'openrouter_primary_failed', status: primary.status, fallback: 'cloudflare-workers-ai' }));
      } catch (error) {
        if (!currentAI) throw error;
        console.warn(JSON.stringify({ event: 'openrouter_primary_error', reason: error instanceof Error ? error.message : String(error), fallback: 'cloudflare-workers-ai' }));
      }
    }

    if (!currentAI) return Response.json({ error: { message: 'Cloudflare Workers AI fallback is not configured' } }, { status: 503 });
    try {
      const payload = openRouterPayload || (typeof init?.body === 'string' ? JSON.parse(init.body) as ChatPayload : {});
      const result = await currentAI.run(currentCloudflareModel as Parameters<Ai['run']>[0], {
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        max_tokens: 8192,
      } as never) as { response?: string } | string;
      const content = typeof result === 'string' ? result : result?.response ?? '';
      return openAiCompatibleResponse(content);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'cloudflare_ai_fallback_failed', reason }));
      return Response.json({ error: { message: `Cloudflare Workers AI fallback failed: ${reason}` } }, { status: 502 });
    }
  };
}

async function normalizeRuntimeEnv<T extends RuntimeEnv>(env: T): Promise<T> {
  const normalized = { ...env } as T;
  if (env.DB) normalized.DB = normalizeD1(env.DB) as T['DB'];

  if (typeof env.SESSION_SECRET === 'string') {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.SESSION_SECRET));
    normalized.SESSION_SECRET = base64Url(new Uint8Array(digest));
  }
  if (typeof env.TOKEN_ENCRYPTION_KEY === 'string') {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.TOKEN_ENCRYPTION_KEY));
    normalized.TOKEN_ENCRYPTION_KEY = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  currentAI = env.AI;
  currentCloudflareModel = typeof env.CLOUDFLARE_AI_MODEL === 'string' && env.CLOUDFLARE_AI_MODEL.trim() ? env.CLOUDFLARE_AI_MODEL.trim() : '@cf/meta/llama-3.1-8b-instruct-fast';
  if (typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim()) currentOpenRouterKey = env.OPENROUTER_API_KEY.trim();
  if (typeof env.OPENROUTER_MODEL === 'string' && env.OPENROUTER_MODEL.trim()) currentOpenRouterModel = env.OPENROUTER_MODEL.trim();
  installFetchGuards();

  if (typeof env.OPENROUTER_API_KEY !== 'string' || !env.OPENROUTER_API_KEY.trim()) normalized.OPENROUTER_API_KEY = OPENROUTER_FALLBACK_SENTINEL as T['OPENROUTER_API_KEY'];
  (globalThis as typeof globalThis & { env?: T }).env = normalized;
  return normalized;
}

function runtimeError(error: unknown): Response {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: 'uncaught_request_error', reason }));
  return new Response(JSON.stringify({ error: 'Runtime request failed', reason }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    try {
      return await worker.fetch(request, await normalizeRuntimeEnv(env as never));
    } catch (error) {
      return runtimeError(error);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const normalized = await normalizeRuntimeEnv(env as never);
    try {
      await worker.queue(batch as never, normalized as never);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'uncaught_queue_error', reason }));
      throw error;
    }
  },
};