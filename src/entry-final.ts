export { BuildCoordinator } from './index';

const platformFetch = globalThis.fetch.bind(globalThis);
let workersDevSubdomain = 'averymiddlebrook2014';
let installed = false;

function bindRuntime(env: unknown): void {
  const value = (env as { WORKERS_DEV_SUBDOMAIN?: unknown } | null)?.WORKERS_DEV_SUBDOMAIN;
  if (typeof value === 'string' && value.trim()) workersDevSubdomain = value.trim();
}

function rewriteWorkersDevInput(input: RequestInfo | URL): RequestInfo | URL {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return input;
  }

  // Vela's core deployer historically returned/verified
  // https://<script>.workers.dev. Cloudflare account workers.dev URLs are
  // https://<script>.<account-subdomain>.workers.dev. Repair the legacy
  // one-label hostname at the lowest transport layer so verification cannot
  // accidentally probe an NXDOMAIN/wrong route again.
  if (/^[^.]+\.workers\.dev$/i.test(parsed.hostname)) {
    const script = parsed.hostname.slice(0, -'.workers.dev'.length);
    parsed.hostname = `${script}.${workersDevSubdomain}.workers.dev`;
    console.warn(JSON.stringify({
      event: 'workers_dev_hostname_repaired',
      script,
      hostname: parsed.hostname,
    }));

    if (input instanceof Request) return new Request(parsed.href, input);
    if (input instanceof URL) return parsed;
    return parsed.href;
  }

  return input;
}

function installWorkersDevTransportGuard(): void {
  if (installed) return;
  installed = true;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    return platformFetch(rewriteWorkersDevInput(input), init);
  };
}

installWorkersDevTransportGuard();

// Import the existing bootstrap only after the hostname guard is installed.
// Its own nativeFetch therefore inherits this repair, and entry-safe inherits
// the bootstrap guard in turn. This keeps all existing GitHub/Cloudflare source
// repair behavior while fixing the actual generated-worker verification URL.
const entry = import('./entry-bootstrap');

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
