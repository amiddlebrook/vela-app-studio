import worker, { BuildCoordinator } from './index';

export { BuildCoordinator };

type RuntimeEnv = Record<string, unknown> & {
  DB?: D1Database;
  AI?: Ai;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string | CryptoKey;
  OPENROUTER_API_KEY?: string;
  CLOUDFLARE_AI_MODEL?: string;
};

const encoder = new TextEncoder();
const nativeFetch = globalThis.fetch.bind(globalThis);
const OPENROUTER_FALLBACK_SENTINEL = '__vela_cloudflare_ai_fallback__';
let currentAI: Ai | undefined;
let currentCloudflareModel = '@cf/meta/llama-3.1-8b-instruct-fast';
let fetchFallbackInstalled = false;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
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

function installOpenRouterFallback(): void {
  if (fetchFallbackInstalled) return;
  fetchFallbackInstalled = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

    if (url !== 'https://openrouter.ai/api/v1/chat/completions') {
      return nativeFetch(input, init);
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

    if (!currentAI) {
      return Response.json({ error: { message: 'Cloudflare Workers AI fallback is not configured' } }, { status: 503 });
    }

    try {
      const payload = typeof init?.body === 'string' ? JSON.parse(init.body) as { messages?: unknown[] } : {};
      const result = await currentAI.run(currentCloudflareModel as Parameters<Ai['run']>[0], {
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        max_tokens: 4096,
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

  if (env.DB) {
    normalized.DB = normalizeD1(env.DB) as T['DB'];
  }

  if (typeof env.SESSION_SECRET === 'string') {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.SESSION_SECRET));
    normalized.SESSION_SECRET = base64Url(new Uint8Array(digest));
  }

  if (typeof env.TOKEN_ENCRYPTION_KEY === 'string') {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.TOKEN_ENCRYPTION_KEY));
    normalized.TOKEN_ENCRYPTION_KEY = await crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  currentAI = env.AI;
  currentCloudflareModel = typeof env.CLOUDFLARE_AI_MODEL === 'string' && env.CLOUDFLARE_AI_MODEL.trim()
    ? env.CLOUDFLARE_AI_MODEL.trim()
    : '@cf/meta/llama-3.1-8b-instruct-fast';
  installOpenRouterFallback();

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
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
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
