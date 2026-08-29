export { BuildCoordinator } from './index';

// Capture the platform transport before any legacy compatibility layer installs fetch wrappers.
const platformFetch = globalThis.fetch.bind(globalThis);
const entry = import('./entry-json-final');
const MARK = '__vela_agent_resilience__';

type MarkedFetch = typeof fetch & { [MARK]?: boolean };
type RuntimeEnv = Record<string, unknown>;
type ChatMessage = { role?: string; content?: string };
type ChatBody = { model?: string; messages?: ChatMessage[]; response_format?: unknown } & Record<string, unknown>;
type OpenRouterPayload = { choices?: Array<{ message?: { content?: string } }>; model?: string };

const FREE_FALLBACKS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'inclusionai/ring-2.6-1t:free',
];

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeBase64(value: string): string {
  const clean = value.replace(/\s/g, '');
  const bytes = Uint8Array.from(atob(clean), ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function strictJson(body: ChatBody | null): boolean {
  return !!body?.messages?.some(message => /return\s+only\s+(?:one\s+)?json/i.test(String(message.content || '')));
}

function firstBalancedJson(text: string): string | null {
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
      if (ch === '}') {
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

async function normalizeOpenRouter(response: Response, isStrict: boolean, effectiveModel?: string): Promise<Response> {
  if (!response.ok) return response;
  let outer: OpenRouterPayload;
  try { outer = await response.clone().json() as OpenRouterPayload; } catch { return response; }
  const content = outer.choices?.[0]?.message?.content;
  if (isStrict && typeof content === 'string') {
    let normalized = content.trim();
    try { JSON.parse(normalized); }
    catch {
      const recovered = firstBalancedJson(normalized);
      if (recovered) normalized = recovered;
    }
    if (outer.choices?.[0]?.message && normalized !== content) outer.choices[0].message!.content = normalized;
  }
  if (effectiveModel) outer.model = effectiveModel;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  if (effectiveModel) headers.set('x-vela-effective-model', effectiveModel);
  return new Response(JSON.stringify(outer), { status: response.status, statusText: response.statusText, headers });
}

function parseChatBody(init?: RequestInit): ChatBody | null {
  if (typeof init?.body !== 'string') return null;
  try { return JSON.parse(init.body) as ChatBody; } catch { return null; }
}

function isRetryableOpenRouter(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function openRouterWithFailover(input: RequestInfo | URL, init: RequestInit | undefined, downstream: typeof fetch): Promise<Response> {
  const body = parseChatBody(init);
  const isStrict = strictJson(body);
  const primary = await downstream(input, init);
  if (!isRetryableOpenRouter(primary.status) || !body) return primary;

  const current = String(body.model || '');
  const candidates = FREE_FALLBACKS.filter(model => model !== current);
  const retryAfter = Number(primary.headers.get('retry-after') || 0);
  if (retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 6000));

  for (const model of candidates) {
    const fallbackBody: ChatBody = { ...body, model };
    // Some free endpoints do not support response_format. Balanced JSON recovery below is authoritative.
    delete fallbackBody.response_format;
    const fallbackInit: RequestInit = { ...init, body: JSON.stringify(fallbackBody) };
    const response = await platformFetch(input, fallbackInit);
    if (response.ok) {
      console.warn(JSON.stringify({ event: 'openrouter_free_model_failover', from: current, to: model, primary_status: primary.status }));
      return normalizeOpenRouter(response, isStrict, model);
    }
    if (!isRetryableOpenRouter(response.status)) return response;
    const wait = Number(response.headers.get('retry-after') || 0);
    if (wait > 0) await sleep(Math.min(wait * 1000, 5000));
  }
  return primary;
}

function allowedValidationCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/^wrangler\s+db\s+(migrate|seed)\b/i.test(cmd)) return false;
  if (/^github\s+actions\b/i.test(cmd)) return false;
  if (/^npm\s+run\s+start\b/i.test(cmd)) return false;
  if (/^wrangler\s+deploy\s*$/i.test(cmd)) return false;
  if (/\b(rm\s+-rf\s+\/|mkfs|shutdown|reboot|curl.+\|\s*(?:sh|bash))\b/i.test(cmd)) return false;
  return /^(npm|npx|node|python3?|pytest|bash|sh|test|sqlite3|git)\b/.test(cmd);
}

function sanitizePlan(plan: unknown): unknown {
  if (!plan || typeof plan !== 'object') return plan;
  const copy = structuredClone(plan) as { tasks?: Array<Record<string, unknown>>; milestones?: Array<Record<string, unknown>> };
  for (const group of [copy.tasks, copy.milestones]) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const commands = Array.isArray(item.validation_commands) ? item.validation_commands.map(String) : [];
      item.validation_commands = commands.filter(allowedValidationCommand);
    }
  }
  return copy;
}

function strengthenModels(models: unknown): unknown {
  if (!models || typeof models !== 'object') return models;
  const copy = structuredClone(models) as Record<string, unknown>;
  copy.fallbacks = FREE_FALLBACKS;
  copy.policy = 'Only explicit OpenRouter :free models may execute engineering work. On upstream rate limits or provider failures, Vela automatically rotates through the approved explicit free fallback models. Cloudflare Workers AI and generic scaffolds are forbidden coding fallbacks.';
  return copy;
}

function isGithubContentsPut(url: string, init?: RequestInit): boolean {
  return /https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\//.test(url) && init?.method?.toUpperCase() === 'PUT' && typeof init.body === 'string';
}

function transformGithubBootstrap(url: string, init?: RequestInit): RequestInit | undefined {
  if (!isGithubContentsPut(url, init) || typeof init?.body !== 'string') return init;
  let payload: Record<string, unknown> & { content?: string };
  try { payload = JSON.parse(init.body) as typeof payload; } catch { return init; }
  if (!payload.content) return init;
  let decoded: string;
  try { decoded = decodeBase64(payload.content); } catch { return init; }

  if (url.includes('/contents/.vela/task-plan.json')) {
    try {
      const plan = JSON.parse(decoded);
      payload.content = encodeBase64(JSON.stringify(sanitizePlan(plan), null, 2));
      console.warn(JSON.stringify({ event: 'agent_task_plan_validation_commands_sanitized' }));
    } catch {}
  }
  if (url.includes('/contents/.vela/models.json')) {
    try {
      const models = JSON.parse(decoded);
      payload.content = encodeBase64(JSON.stringify(strengthenModels(models), null, 2));
      console.warn(JSON.stringify({ event: 'agent_free_model_fallbacks_injected', fallbacks: FREE_FALLBACKS }));
    } catch {}
  }
  return { ...init, body: JSON.stringify(payload) };
}

function installResilience(): void {
  const current = globalThis.fetch as MarkedFetch;
  if (current[MARK]) return;
  const downstream = current.bind(globalThis);
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const effectiveInit = transformGithubBootstrap(url, init);
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      return openRouterWithFailover(input, effectiveInit, downstream);
    }
    return downstream(input, effectiveInit);
  }) as MarkedFetch;
  Object.defineProperty(wrapped, MARK, { value: true, enumerable: false });
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = wrapped;
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const module = await entry;
    installResilience();
    return module.default.fetch(request, env as never, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    installResilience();
    return module.default.queue(batch as never, env as never);
  },
};
