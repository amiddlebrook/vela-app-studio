export { BuildCoordinator } from './index';

const networkFetch = globalThis.fetch.bind(globalThis);
let installed = false;
let workersDevSubdomain = 'averymiddlebrook2014';
let cloudflareApiToken: string | undefined;
let cloudflareAccountId: string | undefined;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bindRuntime(env: unknown): void {
  const runtime = env as {
    WORKERS_DEV_SUBDOMAIN?: unknown;
    CLOUDFLARE_API_TOKEN?: unknown;
    CLOUDFLARE_ACCOUNT_ID?: unknown;
  } | null;

  const subdomain = runtime?.WORKERS_DEV_SUBDOMAIN;
  if (typeof subdomain === 'string' && subdomain.trim()) workersDevSubdomain = subdomain.trim();

  const token = runtime?.CLOUDFLARE_API_TOKEN;
  cloudflareApiToken = typeof token === 'string' && token.trim() ? token.trim() : undefined;

  const accountId = runtime?.CLOUDFLARE_ACCOUNT_ID;
  cloudflareAccountId = typeof accountId === 'string' && accountId.trim() ? accountId.trim() : undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBase64Utf8(value: string): string {
  return decoder.decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
}

function encodeBase64Utf8(value: string): string {
  let binary = '';
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hardenGeneratedWorkerSource(source: string): string {
  let hardened = source;

  // LLMs commonly emit an unescaped + inside a regex literal while building
  // base64url strings. That is invalid JavaScript (/+/: nothing to repeat).
  hardened = hardened.replaceAll(".replace(/+/g, '-')", ".replace(/\\+/g, '-')");
  hardened = hardened.replaceAll('.replace(/+/g, "-")', '.replace(/\\+/g, "-")');

  // Generated enterprise workers can be deployed without a D1 binding when
  // database provisioning is unavailable. Do not let optional rate limiting
  // make the public root route crash before the worker reaches its own handler.
  hardened = hardened.replace(
    "if (url.pathname !== '/api/health') {\n      const rl = await rateLimitMiddleware(env, request);",
    "if (url.pathname !== '/api/health' && env.DB) {\n      const rl = await rateLimitMiddleware(env, request);",
  );

  return hardened;
}

function isGithubWorkerWrite(url: string, init?: RequestInit): boolean {
  return /https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/src\/worker\.mjs(?:\?|$)/.test(url) &&
    init?.method?.toUpperCase() === 'PUT' &&
    typeof init.body === 'string';
}

function hardenGithubWorkerWrite(url: string, init?: RequestInit): RequestInit | undefined {
  if (!isGithubWorkerWrite(url, init) || typeof init?.body !== 'string') return init;

  try {
    const payload = JSON.parse(init.body) as { content?: string } & Record<string, unknown>;
    if (!payload.content) return init;
    const source = decodeBase64Utf8(payload.content);
    const hardened = hardenGeneratedWorkerSource(source);
    if (hardened === source) return init;
    payload.content = encodeBase64Utf8(hardened);
    console.warn(JSON.stringify({ event: 'generated_worker_github_source_hardened' }));
    return { ...init, body: JSON.stringify(payload) };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'generated_worker_github_hardening_failed',
      reason: error instanceof Error ? error.message : String(error),
    }));
    return init;
  }
}

function isCloudflareWorkerUpload(url: string, init?: RequestInit): init is RequestInit & { body: FormData } {
  return /https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/?]+/.test(url) &&
    init?.method?.toUpperCase() === 'PUT' &&
    init.body instanceof FormData;
}

async function hardenCloudflareWorkerUpload(url: string, init?: RequestInit): Promise<RequestInit | undefined> {
  if (!isCloudflareWorkerUpload(url, init)) return init;
  const module = init.body.get('worker.mjs');
  if (!(module instanceof Blob)) return init;

  const source = await module.text();
  const hardened = hardenGeneratedWorkerSource(source);
  if (hardened === source) return init;

  const form = new FormData();
  for (const [key, value] of init.body.entries()) {
    if (key === 'worker.mjs') continue;
    form.append(key, value);
  }
  form.set('worker.mjs', new Blob([hardened], { type: 'application/javascript+module' }), 'worker.mjs');
  console.warn(JSON.stringify({ event: 'generated_worker_upload_source_hardened' }));
  return { ...init, body: form };
}

function generatedWorkerScript(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const suffix = `.${workersDevSubdomain}.workers.dev`;
  if (!parsed.hostname.toLowerCase().endsWith(suffix.toLowerCase())) return null;
  const script = parsed.hostname.slice(0, -suffix.length);
  return script.startsWith('vela-') && script !== 'vela-control-plane' ? script : null;
}

async function enableGeneratedWorkerRoute(script: string): Promise<void> {
  if (!cloudflareApiToken || !cloudflareAccountId) return;

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccountId)}/workers/scripts/${encodeURIComponent(script)}/subdomain`;
  const response = await networkFetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cloudflareApiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ enabled: true, previews_enabled: true }),
  });

  if (!response.ok) {
    const detail = (await response.clone().text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    console.warn(JSON.stringify({ event: 'outer_generated_worker_route_enable_failed', script, status: response.status, detail }));
  } else {
    console.warn(JSON.stringify({ event: 'outer_generated_worker_route_enabled', script }));
  }
}

async function fetchGeneratedWorkerWithPatience(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  const script = generatedWorkerScript(url);
  if (!script) return networkFetch(input, init);

  let response: Response | undefined;
  let lastError: unknown;
  try {
    response = await networkFetch(input, init);
    if (response.status >= 200 && response.status < 400) return response;
    // A real application 5xx should be surfaced immediately so the existing
    // fallback deployer can repair the application rather than waiting on DNS.
    if (response.status >= 500 && response.status !== 530) return response;
  } catch (error) {
    lastError = error;
  }

  try {
    await enableGeneratedWorkerRoute(script);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'outer_generated_worker_route_enable_exception',
      script,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  // workers.dev route publication is eventually consistent. Give Cloudflare
  // a full minute instead of declaring a healthy upload dead after ~20 seconds.
  for (const waitMs of [500, 1000, 2000, 4000, 8000, 12000, 15000, 20000]) {
    await delay(waitMs);
    try {
      response = await networkFetch(input, init);
      if (response.status >= 200 && response.status < 400) {
        console.warn(JSON.stringify({ event: 'outer_generated_worker_verified_after_wait', script, status: response.status }));
        return response;
      }
      if (response.status >= 500 && response.status !== 530) return response;
    } catch (error) {
      lastError = error;
    }
  }

  if (response) return response;
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Generated Worker ${script} remained unreachable after route publication wait`);
}

function installHardeningGuard(): void {
  if (installed) return;
  installed = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = requestUrl(input);
    init = hardenGithubWorkerWrite(url, init);
    init = await hardenCloudflareWorkerUpload(url, init);
    return fetchGeneratedWorkerWithPatience(input, init);
  };
}

installHardeningGuard();

// Import the existing runtime only after the lowest-level hardening guard is
// installed. All nested GitHub, Cloudflare and workers.dev transports pass
// through this guard before reaching the network.
const entry = import('./entry-final');

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    bindRuntime(env);
    const module = await entry;
    return module.default.fetch(request, env as never);
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    bindRuntime(env);
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
