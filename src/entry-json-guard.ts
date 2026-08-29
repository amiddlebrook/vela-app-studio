export { BuildCoordinator } from './index';

const nativeFetch = globalThis.fetch.bind(globalThis);
let installed = false;

type RuntimeEnv = { DB?: D1Database } & Record<string, unknown>;

type OpenRouterPayload = {
  choices?: Array<{ message?: { content?: string } }>;
};

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function expectsStrictJson(init?: RequestInit): boolean {
  if (typeof init?.body !== 'string') return false;
  try {
    const payload = JSON.parse(init.body) as { messages?: Array<{ role?: string; content?: string }> };
    return (payload.messages || []).some(message => {
      const text = String(message.content || '');
      return /return\s+only\s+json/i.test(text) || /return\s+only\s+one\s+json/i.test(text);
    });
  } catch {
    return false;
  }
}

function firstBalancedJsonObject(text: string): string | null {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
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
      else if (ch === '}') {
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

async function normalizeOpenRouterResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  let payload: OpenRouterPayload;
  try {
    payload = await response.clone().json() as OpenRouterPayload;
  } catch {
    return response;
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return response;

  try {
    JSON.parse(content.trim());
    return response;
  } catch {}

  const recovered = firstBalancedJsonObject(content);
  if (!recovered) return response;
  if (payload.choices?.[0]?.message) payload.choices[0].message!.content = recovered;

  console.warn(JSON.stringify({
    event: 'openrouter_json_response_recovered',
    original_chars: content.length,
    recovered_chars: recovered.length,
  }));

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function installOpenRouterJsonGuard(): void {
  if (installed) return;
  installed = true;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (requestUrl(input) === 'https://openrouter.ai/api/v1/chat/completions' && expectsStrictJson(init)) {
      return normalizeOpenRouterResponse(response);
    }
    return response;
  };
}

async function recoverJsonParseGate(env: RuntimeEnv): Promise<void> {
  if (!env.DB) return;
  try {
    const rows = await env.DB.prepare(`SELECT project_id,intent_json,architecture_json,task_plan_json,last_error
      FROM agent_projects
      WHERE phase='failed'
        AND (last_error LIKE 'Unexpected non-whitespace character after JSON%'
          OR last_error LIKE 'Unexpected token%JSON%'
          OR last_error LIKE 'Model did not return valid JSON%')`).all<{
      project_id: string;
      intent_json: string | null;
      architecture_json: string | null;
      task_plan_json: string | null;
      last_error: string | null;
    }>();

    const now = new Date().toISOString();
    for (const row of rows.results || []) {
      let phase = 'analyzing_intent';
      if (row.architecture_json && !row.task_plan_json) phase = 'awaiting_architecture_confirmation';
      else if (row.intent_json && !row.architecture_json) phase = 'awaiting_intent_confirmation';
      await env.DB.prepare('UPDATE agent_projects SET phase=?,last_error=NULL,updated_at=? WHERE project_id=?')
        .bind(phase, now, row.project_id).run();
      await env.DB.prepare('UPDATE projects SET status=?,updated_at=? WHERE id=?')
        .bind(phase, now, row.project_id).run();
      console.warn(JSON.stringify({ event: 'json_parse_failure_returned_to_gate', project_id: row.project_id, phase }));
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'json_parse_gate_recovery_failed', reason: error instanceof Error ? error.message : String(error) }));
  }
}

installOpenRouterJsonGuard();
const entry = import('./entry-gates');

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/projects')) {
      await recoverJsonParseGate(env);
    }
    const module = await entry;
    return module.default.fetch(request, env as never, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
