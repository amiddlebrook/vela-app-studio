import { BuildCoordinator } from './index';

export { BuildCoordinator };

const nativeFetch = globalThis.fetch.bind(globalThis);
let githubBootstrapInstalled = false;
let currentCloudflareApiToken: string | undefined;

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

function bindRuntimeCredentials(env: unknown): void {
  const token = (env as { CLOUDFLARE_API_TOKEN?: unknown } | null)?.CLOUDFLARE_API_TOKEN;
  currentCloudflareApiToken = typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

async function githubLogin(headers: Headers): Promise<string | null> {
  try {
    const me = await nativeFetch('https://api.github.com/user', { headers });
    if (!me.ok) return null;
    const identity = await me.json() as { login?: string };
    return identity.login?.trim() || null;
  } catch {
    return null;
  }
}

function isGithubContentsUrl(url: string): boolean {
  return /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\//.test(url);
}

function sanitizeRepositoryDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 160);
  return cleaned || undefined;
}

async function retryGithubContentUpdateWithSha(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
): Promise<Response> {
  if (response.status !== 422 || !init || typeof init.body !== 'string') return response;

  const url = requestUrl(input);
  if (!isGithubContentsUrl(url)) return response;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return response;
  }

  if (typeof payload.sha === 'string' && payload.sha.trim()) return response;

  const detail = await response.clone().text().catch(() => '');
  if (detail && !/sha|already exists|invalid request/i.test(detail)) return response;

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const existing = await nativeFetch(url, { method: 'GET', headers });
  if (!existing.ok) return response;

  try {
    const current = await existing.json() as { sha?: string };
    if (!current.sha) return response;

    payload.sha = current.sha;
    console.warn(JSON.stringify({ event: 'github_contents_missing_sha_recovered', url }));
    return nativeFetch(input, { ...init, body: JSON.stringify(payload) });
  } catch {
    return response;
  }
}

async function existingGithubRepository(headers: Headers, name: string): Promise<Response | null> {
  const login = await githubLogin(headers);
  if (!login) return null;

  try {
    const existing = await nativeFetch(
      `https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}`,
      { headers },
    );
    return existing.ok ? existing : null;
  } catch {
    return null;
  }
}

async function recoverGithubRepositoryCreate(
  input: RequestInfo | URL,
  init: RequestInit,
  response: Response,
): Promise<Response> {
  if (response.status !== 422 || typeof init.body !== 'string') return response;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return response;
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) return response;

  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));

  const existing = await existingGithubRepository(headers, name);
  if (existing) {
    console.warn(JSON.stringify({ event: 'github_repository_create_recovered', repository: name }));
    return existing;
  }

  const initialDetail = await response.clone().text().catch(() => '');
  console.warn(JSON.stringify({
    event: 'github_repository_create_422',
    repository: name,
    detail: initialDetail.replace(/\s+/g, ' ').slice(0, 500),
  }));

  const attempts: Array<{ waitMs: number; payload: Record<string, unknown> }> = [
    { waitMs: 1200, payload: { ...payload, description: sanitizeRepositoryDescription(payload.description) } },
    {
      waitMs: 3000,
      payload: {
        name,
        description: sanitizeRepositoryDescription(payload.description),
        private: true,
        auto_init: true,
      },
    },
    {
      waitMs: 6000,
      payload: {
        name,
        private: true,
        auto_init: false,
      },
    },
  ];

  let latest = response;
  for (const attempt of attempts) {
    await delay(attempt.waitMs);
    const retryPayload = Object.fromEntries(Object.entries(attempt.payload).filter(([, value]) => value !== undefined));
    latest = await nativeFetch(input, { ...init, body: JSON.stringify(retryPayload) });
    if (latest.ok) {
      console.warn(JSON.stringify({ event: 'github_repository_create_retry_succeeded', repository: name, waitMs: attempt.waitMs }));
      return latest;
    }

    if (latest.status !== 422) return latest;

    const appeared = await existingGithubRepository(headers, name);
    if (appeared) {
      console.warn(JSON.stringify({ event: 'github_repository_create_recovered_after_retry', repository: name }));
      return appeared;
    }
  }

  return latest;
}

function installGithubBootstrapGuard(): void {
  if (githubBootstrapInstalled) return;
  githubBootstrapInstalled = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    let nextInput: RequestInfo | URL = input;
    let url = requestUrl(nextInput);
    const method = init?.method?.toUpperCase() || (input instanceof Request ? input.method.toUpperCase() : 'GET');
    let nextInit = init;

    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/') && currentCloudflareApiToken) {
      const headers = new Headers(nextInit?.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('authorization', `Bearer ${currentCloudflareApiToken}`);
      nextInit = { ...nextInit, headers };
    }

    if (url.startsWith('https://api.github.com/') && method === 'PUT') {
      const parsed = new URL(url);
      const ownerless = parsed.pathname.match(/^\/repos\/([^/]+)\/contents\/(.+)$/);
      if (ownerless) {
        const headers = new Headers(nextInit?.headers || (input instanceof Request ? input.headers : undefined));
        const login = await githubLogin(headers);
        if (login) {
          parsed.pathname = `/repos/${encodeURIComponent(login)}/${encodeURIComponent(ownerless[1])}/contents/${ownerless[2]}`;
          nextInput = parsed;
          url = parsed.href;
          console.warn(JSON.stringify({ event: 'github_ownerless_contents_path_repaired', repository: `${login}/${ownerless[1]}` }));
        }
      }
    }

    if (
      url === 'https://api.github.com/user/repos' &&
      method === 'POST' &&
      typeof init?.body === 'string'
    ) {
      try {
        const payload = JSON.parse(init.body) as Record<string, unknown>;
        const description = sanitizeRepositoryDescription(payload.description);
        if (description) payload.description = description;
        else delete payload.description;
        payload.auto_init = true;
        nextInit = { ...nextInit, body: JSON.stringify(payload) };
      } catch {}
    }

    let response = await nativeFetch(nextInput, nextInit);

    if (
      url === 'https://api.github.com/user/repos' &&
      method === 'POST' &&
      response.status === 422 &&
      nextInit
    ) {
      response = await recoverGithubRepositoryCreate(nextInput, nextInit, response);
    }

    if (method === 'PUT' && response.status === 422 && isGithubContentsUrl(url)) {
      response = await retryGithubContentUpdateWithSha(nextInput, nextInit, response);
    }

    if (
      response.status === 404 &&
      method === 'PUT' &&
      isGithubContentsUrl(url)
    ) {
      for (const waitMs of [150, 350, 750, 1500]) {
        await delay(waitMs);
        response = await nativeFetch(nextInput, nextInit);
        if (response.status !== 404) break;
      }
    }

    return response;
  };
}

installGithubBootstrapGuard();

const entry = import('./entry-safe');

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    bindRuntimeCredentials(env);
    const module = await entry;
    return module.default.fetch(request, env as never);
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    bindRuntimeCredentials(env);
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
