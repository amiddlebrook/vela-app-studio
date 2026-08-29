export { BuildCoordinator } from './index';

const networkFetch = globalThis.fetch.bind(globalThis);
let installed = false;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
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

function installHardeningGuard(): void {
  if (installed) return;
  installed = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = requestUrl(input);
    init = hardenGithubWorkerWrite(url, init);
    init = await hardenCloudflareWorkerUpload(url, init);
    return networkFetch(input, init);
  };
}

installHardeningGuard();

// Import the existing runtime only after the lowest-level source hardening
// guard is installed. All nested GitHub and Cloudflare transports eventually
// pass through this guard before reaching the network.
const entry = import('./entry-final');

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const module = await entry;
    return module.default.fetch(request, env as never);
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
