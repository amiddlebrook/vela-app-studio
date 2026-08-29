export { BuildCoordinator } from './index';

const entry = import('./entry-engineering-final');
const MARK = '__vela_strict_json_retry__';

type MarkedFetch = typeof fetch & { [MARK]?: boolean };
type RuntimeEnv = Record<string, unknown>;
type ChatMessage = { role?: string; content?: string };
type ChatBody = { model?: string; messages?: ChatMessage[]; response_format?: unknown } & Record<string, unknown>;
type OpenRouterPayload = { choices?: Array<{ message?: { content?: string } }>; model?: string };

const STRICT_FALLBACKS = [
  'z-ai/glm-5.2:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'inclusionai/ring-2.6-1t:free',
];

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function parseBody(init?: RequestInit): ChatBody | null {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body) as ChatBody; } catch { return null; }
}

function requiresJson(body: ChatBody | null): boolean {
  return !!body?.messages?.some(message => /return\s+only\s+(?:one\s+)?json|exact\s+shape|json\s+with/i.test(String(message.content || '')));
}

function firstBalancedValue(text: string): string | null {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  for (let start = 0; start < source.length; start++) {
    const opener = source[start];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
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
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch { break; }
        }
      }
    }
  }
  return null;
}

function normalizeJsonText(text: string): string | null {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { JSON.parse(cleaned); return cleaned; } catch {}
  return firstBalancedValue(cleaned);
}

async function readOpenRouter(response: Response): Promise<{ outer: OpenRouterPayload; content: string } | null> {
  if (!response.ok) return null;
  try {
    const outer = await response.clone().json() as OpenRouterPayload;
    const content = outer.choices?.[0]?.message?.content;
    return typeof content === 'string' ? { outer, content } : null;
  } catch {
    return null;
  }
}

function normalizedResponse(response: Response, outer: OpenRouterPayload, content: string, model?: string): Response {
  if (outer.choices?.[0]?.message) outer.choices[0].message!.content = content;
  if (model) outer.model = model;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  if (model) headers.set('x-vela-effective-model', model);
  return new Response(JSON.stringify(outer), { status: response.status, statusText: response.statusText, headers });
}

function retryBody(body: ChatBody, model: string, strictRetry: boolean): ChatBody {
  const messages = (body.messages || []).map(message => ({ ...message }));
  if (strictRetry) {
    messages.push({
      role: 'system',
      content: 'STRICT JSON RETRY: the prior provider response was not parseable JSON. Return exactly one syntactically valid JSON value matching the requested schema. No Markdown, prose, comments, trailing text, or second JSON object. Escape every quote, backslash, newline, tab, and control character inside JSON strings correctly.',
    });
  }
  return { ...body, model, messages, response_format: { type: 'json_object' } };
}

async function strictJsonFetch(input: RequestInfo | URL, init: RequestInit | undefined, downstream: typeof fetch): Promise<Response> {
  const body = parseBody(init);
  if (!body || !requiresJson(body)) return downstream(input, init);

  const requested = String(body.model || '').trim();
  const candidates = [requested, requested, ...STRICT_FALLBACKS].filter((model, index, all) => model && (index < 2 || all.indexOf(model) === index));
  let lastResponse: Response | null = null;
  let lastReason = 'provider returned no parseable JSON';

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const effective = retryBody(body, model, i > 0);
    let response: Response;
    try {
      response = await downstream(input, { ...init, body: JSON.stringify(effective) });
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      continue;
    }
    lastResponse = response;
    if (!response.ok) {
      lastReason = `HTTP ${response.status}`;
      continue;
    }

    const decoded = await readOpenRouter(response);
    if (!decoded) {
      lastReason = 'OpenRouter envelope was not valid JSON';
      continue;
    }
    const normalized = normalizeJsonText(decoded.content);
    if (!normalized) {
      lastReason = `model ${model} returned non-JSON content`;
      console.warn(JSON.stringify({ event: 'strict_json_model_rejected', model, chars: decoded.content.length }));
      continue;
    }

    if (i > 0) console.warn(JSON.stringify({ event: 'strict_json_model_recovered', requested, effective: model, attempt: i + 1 }));
    return normalizedResponse(response, decoded.outer, normalized, model);
  }

  if (lastResponse && !lastResponse.ok) return lastResponse;
  return Response.json({ error: { message: `OpenRouter strict JSON validation failed after explicit free-model retries: ${lastReason}` } }, { status: 502 });
}

function installGuard(): void {
  const current = globalThis.fetch as MarkedFetch;
  if (current[MARK]) return;
  const downstream = current.bind(globalThis);
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (requestUrl(input) === 'https://openrouter.ai/api/v1/chat/completions') {
      return strictJsonFetch(input, init, downstream);
    }
    return downstream(input, init);
  }) as MarkedFetch;
  Object.defineProperty(wrapped, MARK, { value: true, enumerable: false });
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = wrapped;
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const module = await entry;
    installGuard();
    return module.default.fetch(request, env as never, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    installGuard();
    return module.default.queue(batch as never, env as never);
  },
};
