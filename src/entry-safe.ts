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
          ) {
            normalizedValues = [normalizedValues[0], new Date().toISOString(), normalizedValues[1]];
          }
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
  return source.includes('ENTERPRISE MIDDLEWARE & UTILITIES') &&
    source.includes('function generateOpenAPISpec') &&
    source.includes("'/api/items'");
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

async function openRouterRepair(messages: Array<{ role: string; content: string }>): Promise<string | null> {
  if (!currentOpenRouterKey || !currentOpenRouterModel) return null;
  try {
    const response = await nativeFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${currentOpenRouterKey}`,
        'content-type': 'application/json',
        'x-title': 'Vela Worker Repair',
      },
      body: JSON.stringify({
        model: currentOpenRouterModel,
        messages,
        temperature: 0.1,
        max_tokens: 14000,
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

async function workersAiRepair(messages: Array<{ role: string; content: string }>): Promise<string | null> {
  if (!currentAI) return null;
  try {
    const result = await currentAI.run(currentCloudflareModel as Parameters<Ai['run']>[0], {
      messages,
      max_tokens: 8192,
      temperature: 0.1,
    } as never) as { response?: string } | string;
    return typeof result === 'string' ? result : result?.response || null;
  } catch {
    return null;
  }
}

async function repairWorkerWithAI(source: string, reason: string): Promise<string | null> {
  const appName = appNameFromSource(source);
  const requirements = sourceDescription(source);
  const cappedSource = source.slice(0, 70000);
  const cappedRequirements = requirements.slice(0, 30000);
  const messages = [
    {
      role: 'system',
      content: `You are Vela's production Cloudflare Worker repair engineer. Return ONLY one complete JavaScript ES-module Worker, no Markdown fences and no explanation. Preserve and implement the requested application rather than replacing it with a generic demo. The root route must render the actual usable application. Keep real domain-specific APIs, calculations, persistence, and data workflows. Never use eval or new Function. If D1 is used, guard missing bindings and create required tables idempotently before using them so / can still render. Use only APIs available in Cloudflare Workers. Exactly one export default is required.`,
    },
    {
      role: 'user',
      content: `Application: ${appName}\nRepair reason: ${reason}\n\nAuthoritative requirements:\n${cappedRequirements || 'Preserve every application-specific feature already present in the source.'}\n\nCurrent Worker source:\n${cappedSource}`,
    },
  ];

  for (const candidateText of [await openRouterRepair(messages), await workersAiRepair(messages)]) {
    if (!candidateText) continue;
    const candidate = repairGeneratedWorkerSource(candidateText);
    if (!obviousWorkerProblem(candidate) && !looksLikeGenericEnterpriseFallback(candidate)) {
      console.warn(JSON.stringify({ event: 'worker_ai_repair_succeeded', reason, bytes: candidate.length }));
      return candidate;
    }
  }
  console.warn(JSON.stringify({ event: 'worker_ai_repair_unavailable', reason }));
  return null;
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

async function prepareCloudflareWorkerUpload(url: string, init?: RequestInit): Promise<RequestInit | undefined> {
  if (!isCloudflareWorkerUpload(url, init)) return init;
  const module = init.body.get('worker.mjs');
  if (!(module instanceof Blob)) return init;

  const raw = await module.text();
  let source = repairGeneratedWorkerSource(raw);
  const previous = workerSourceCache.get(url);

  if (looksLikeGenericEnterpriseFallback(source)) {
    const basis = previous && !looksLikeGenericEnterpriseFallback(previous) ? previous : source;
    const repaired = await repairWorkerWithAI(
      basis,
      previous
        ? 'The app-specific Worker failed live verification and the legacy builder attempted to replace it with a generic fallback. Repair the real app instead.'
        : 'The legacy scaffolder produced a generic enterprise template instead of the requested application. Convert it into the actual application described by APP_DESC.',
    );
    if (repaired) source = repaired;
  } else {
    const problem = obviousWorkerProblem(source);
    if (problem) source = await repairWorkerWithAI(source, problem) || source;
  }

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
  if (
    !url.includes('api.github.com/repos/') ||
    !url.includes('/contents/src/worker.mjs') ||
    init?.method?.toUpperCase() !== 'PUT' ||
    typeof init.body !== 'string'
  ) return init;

  try {
    const payload = JSON.parse(init.body) as { content?: string } & Record<string, unknown>;
    if (!payload.content) return init;
    const raw = decodeBase64Utf8(payload.content);
    let source = repairGeneratedWorkerSource(raw);

    if (looksLikeGenericEnterpriseFallback(source)) {
      source = await repairWorkerWithAI(
        source,
        'The legacy scaffolder returned its generic enterprise fallback. Replace it with the substantial application specified by APP_DESC, with a real usable UI and domain-specific APIs.',
      ) || source;
    } else {
      const problem = obviousWorkerProblem(source);
      if (problem) source = await repairWorkerWithAI(source, problem) || source;
    }

    if (source === raw) return init;
    payload.content = base64Standard(encoder.encode(source));
    console.warn(JSON.stringify({ event: 'github_worker_write_repaired', bytes: source.length }));
    return { ...init, body: JSON.stringify(payload) };
  } catch (error) {
    console.warn(JSON.stringify({ event: 'github_worker_write_repair_failed', reason: error instanceof Error ? error.message : String(error) }));
    return init;
  }
}

function captureOpenRouterRuntime(init?: RequestInit): void {
  try {
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1] && match[1] !== OPENROUTER_FALLBACK_SENTINEL) currentOpenRouterKey = match[1];
    if (typeof init?.body === 'string') {
      const payload = JSON.parse(init.body) as { model?: string };
      if (typeof payload.model === 'string' && payload.model.trim()) currentOpenRouterModel = payload.model.trim();
    }
  } catch {}
}

function installFetchGuards(): void {
  if (fetchFallbackInstalled) return;
  fetchFallbackInstalled = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url === 'https://openrouter.ai/api/v1/chat/completions') captureOpenRouterRuntime(init);
    init = await repairGithubWorkerWrite(url, init);
    init = await prepareCloudflareWorkerUpload(url, init);

    if (isCloudflareWorkerUpload(url, init)) return cloudflareWorkerFetch(input, init);

    if (url !== 'https://openrouter.ai/api/v1/chat/completions') return nativeFetch(input, init);

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
      const payload = typeof init?.body === 'string' ? JSON.parse(init.body) as { messages?: unknown[] } : {};
      const result = await currentAI.run(currentCloudflareModel as Parameters<Ai['run']>[0], {
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        max_tokens: 8192,
      } as never) as { response?: string } | string;
      const content = typeof result === 'string' ? result : result?.response ?? '';
      return Response.json({
        id: `cf-${crypto.randomUUID()}`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      });
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
  currentCloudflareModel = typeof env.CLOUDFLARE_AI_MODEL === 'string' && env.CLOUDFLARE_AI_MODEL.trim()
    ? env.CLOUDFLARE_AI_MODEL.trim()
    : '@cf/meta/llama-3.1-8b-instruct-fast';
  if (typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim()) currentOpenRouterKey = env.OPENROUTER_API_KEY.trim();
  if (typeof env.OPENROUTER_MODEL === 'string' && env.OPENROUTER_MODEL.trim()) currentOpenRouterModel = env.OPENROUTER_MODEL.trim();
  installFetchGuards();

  if (typeof env.OPENROUTER_API_KEY !== 'string' || !env.OPENROUTER_API_KEY.trim()) {
    normalized.OPENROUTER_API_KEY = OPENROUTER_FALLBACK_SENTINEL as T['OPENROUTER_API_KEY'];
  }

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