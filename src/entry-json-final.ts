export { BuildCoordinator } from './index';

const entry = import('./entry-gates');
const GUARD_MARK = '__vela_openrouter_json_final_guard__';

type RuntimeEnv = { DB?: D1Database } & Record<string, unknown>;
type OpenRouterPayload = { choices?: Array<{ message?: { content?: string } }> };
type MarkedFetch = typeof fetch & { [GUARD_MARK]?: boolean };

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function parseStrictJsonRequest(init?: RequestInit): { strict: boolean; body?: Record<string, unknown> } {
  if (typeof init?.body !== 'string') return { strict: false };
  try {
    const body = JSON.parse(init.body) as Record<string, unknown> & { messages?: Array<{ content?: unknown }> };
    const strict = (body.messages || []).some(message => /return\s+only\s+json/i.test(String(message.content || '')));
    return { strict, body };
  } catch {
    return { strict: false };
  }
}

function firstBalancedJson(text: string): string | null {
  const source = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

async function normalizeStrictJsonResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;

  let outer: OpenRouterPayload;
  try {
    outer = await response.clone().json() as OpenRouterPayload;
  } catch {
    return response;
  }

  const content = outer.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return response;

  let normalized = content.trim();
  try {
    JSON.parse(normalized);
  } catch {
    const recovered = firstBalancedJson(normalized);
    if (!recovered) return response;
    normalized = recovered;
  }

  if (normalized === content) return response;
  if (outer.choices?.[0]?.message) outer.choices[0].message!.content = normalized;

  console.warn(JSON.stringify({
    event: 'openrouter_strict_json_normalized',
    original_chars: content.length,
    normalized_chars: normalized.length,
  }));

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(outer), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function installFinalJsonGuard(): void {
  const current = globalThis.fetch as MarkedFetch;
  if (current[GUARD_MARK]) return;

  const downstream = current.bind(globalThis);
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const parsed = parseStrictJsonRequest(init);
    let effectiveInit = init;

    if (url === 'https://openrouter.ai/api/v1/chat/completions' && parsed.strict && parsed.body && typeof init?.body === 'string') {
      // Ask OpenRouter/providers for JSON mode when supported, but the response normalizer below
      // remains authoritative because free providers may ignore or partially support this field.
      const body = { ...parsed.body, response_format: { type: 'json_object' } };
      effectiveInit = { ...init, body: JSON.stringify(body) };
    }

    const response = await downstream(input, effectiveInit);
    if (url === 'https://openrouter.ai/api/v1/chat/completions' && parsed.strict) {
      return normalizeStrictJsonResponse(response);
    }
    return response;
  }) as MarkedFetch;

  Object.defineProperty(guarded, GUARD_MARK, { value: true, enumerable: false });
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = guarded;
}

async function recoverStaleJsonFailure(env: RuntimeEnv): Promise<void> {
  if (!env.DB) return;
  try {
    const rows = await env.DB.prepare(`SELECT project_id,intent_json,architecture_json,task_plan_json,last_error
      FROM agent_projects
      WHERE phase='failed'
        AND last_error LIKE 'Unexpected non-whitespace character after JSON%'`).all<{
      project_id: string;
      intent_json: string | null;
      architecture_json: string | null;
      task_plan_json: string | null;
      last_error: string | null;
    }>();

    const now = new Date().toISOString();
    for (const row of rows.results || []) {
      let phase = 'analyzing_intent';
      if (row.task_plan_json) phase = 'awaiting_build_plan_confirmation';
      else if (row.architecture_json) phase = 'awaiting_architecture_confirmation';
      else if (row.intent_json) phase = 'awaiting_intent_confirmation';

      await env.DB.prepare('UPDATE agent_projects SET phase=?,last_error=NULL,updated_at=? WHERE project_id=?')
        .bind(phase, now, row.project_id).run();
      await env.DB.prepare('UPDATE projects SET status=?,updated_at=? WHERE id=?')
        .bind(phase, now, row.project_id).run();
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'stale_json_failure_recovery_failed',
      reason: error instanceof Error ? error.message : String(error),
    }));
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    // Important: wait for the complete downstream module graph to load first. Several legacy
    // compatibility layers install their own global fetch wrappers during module evaluation.
    // Installing here makes this JSON guard the final/outermost transport wrapper.
    const module = await entry;
    installFinalJsonGuard();

    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/projects')) {
      await recoverStaleJsonFailure(env);
    }
    return module.default.fetch(request, env as never, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    installFinalJsonGuard();
    return module.default.queue(batch as never, env as never);
  },
};