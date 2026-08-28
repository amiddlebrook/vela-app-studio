import { BuildCoordinator } from './index';

export { BuildCoordinator };

const nativeFetch = globalThis.fetch.bind(globalThis);
let githubBootstrapInstalled = false;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function installGithubBootstrapGuard(): void {
  if (githubBootstrapInstalled) return;
  githubBootstrapInstalled = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method?.toUpperCase() || (input instanceof Request ? input.method.toUpperCase() : 'GET');
    let nextInit = init;

    if (
      url === 'https://api.github.com/user/repos' &&
      method === 'POST' &&
      typeof init?.body === 'string'
    ) {
      try {
        const payload = JSON.parse(init.body) as Record<string, unknown>;
        payload.auto_init = true;
        nextInit = { ...init, body: JSON.stringify(payload) };
      } catch {}
    }

    let response = await nativeFetch(input, nextInit);

    // A failed build can leave the private repo created before Vela records it
    // in D1. Treat GitHub's "name already exists" response as an idempotent
    // create by resolving the just-created repository and continuing the build.
    if (
      url === 'https://api.github.com/user/repos' &&
      method === 'POST' &&
      response.status === 422 &&
      typeof nextInit?.body === 'string'
    ) {
      try {
        const payload = JSON.parse(nextInit.body) as { name?: string };
        const name = payload.name?.trim();
        if (name) {
          const headers = new Headers(nextInit.headers);
          const me = await nativeFetch('https://api.github.com/user', { headers });
          if (me.ok) {
            const identity = await me.json() as { login?: string };
            if (identity.login) {
              const existing = await nativeFetch(`https://api.github.com/repos/${encodeURIComponent(identity.login)}/${encodeURIComponent(name)}`, { headers });
              if (existing.ok) {
                console.warn(JSON.stringify({ event: 'github_repository_create_recovered', repository: `${identity.login}/${name}` }));
                return existing;
              }
            }
          }
        }
      } catch {}
    }

    // GitHub can briefly return 404 immediately after repository creation.
    // Retry content writes so repo propagation never turns into a failed build.
    if (
      response.status === 404 &&
      method === 'PUT' &&
      /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\//.test(url)
    ) {
      for (const waitMs of [150, 350, 750]) {
        await delay(waitMs);
        response = await nativeFetch(input, nextInit);
        if (response.status !== 404) break;
      }
    }

    return response;
  };
}

installGithubBootstrapGuard();

// Import entry-safe only after installing the GitHub bootstrap guard. This makes
// entry-safe capture this guarded fetch as its native transport, so its existing
// Cloudflare/source-repair guards compose on top instead of replacing it.
const entry = import('./entry-safe');

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
