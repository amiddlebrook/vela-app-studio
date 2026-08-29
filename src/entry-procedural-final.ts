import { BuildCoordinator } from './index';
import { AGENT_RUNNER_V3 } from './agent-runner-v3';

export { BuildCoordinator };

const entry = import('./entry-strict-json-retry');
const MARK = '__vela_procedural_final__';

type MarkedFetch = typeof fetch & { [MARK]?: boolean };
type RuntimeEnv = Record<string, unknown>;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, '')), ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function transformGithubWrite(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const url = requestUrl(input);
  if (!/https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/\.vela\/agent-runner\.mjs/.test(url) || init?.method?.toUpperCase() !== 'PUT' || typeof init.body !== 'string') return init;

  let payload: Record<string, unknown> & { content?: string };
  try { payload = JSON.parse(init.body) as typeof payload; } catch { return init; }
  if (!payload.content) return init;

  try {
    const existing = decodeBase64(payload.content);
    if (existing !== AGENT_RUNNER_V3) {
      payload.content = encodeBase64(AGENT_RUNNER_V3);
      console.warn(JSON.stringify({ event: 'procedural_runner_v3_forced', previous_chars: existing.length, replacement_chars: AGENT_RUNNER_V3.length }));
      return { ...init, body: JSON.stringify(payload) };
    }
  } catch {
    payload.content = encodeBase64(AGENT_RUNNER_V3);
    return { ...init, body: JSON.stringify(payload) };
  }

  return init;
}

function installGuard(): void {
  const current = globalThis.fetch as MarkedFetch;
  if (current[MARK]) return;
  const downstream = current.bind(globalThis);
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return downstream(input, transformGithubWrite(input, init));
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
