import { BuildCoordinator } from './index';

export { BuildCoordinator };

type BootstrapEnv = {
  APP_ORIGIN?: string;
  WORKERS_DEV_SUBDOMAIN?: string;
  DB?: D1Database;
};

const nativeFetch = globalThis.fetch.bind(globalThis);
let githubBootstrapInstalled = false;
let workersDevSuffix: string | null = null;

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

function configureWorkersDevSuffix(env: unknown): void {
  const runtime = (env || {}) as BootstrapEnv;
  const explicit = runtime.WORKERS_DEV_SUBDOMAIN?.trim();
  if (explicit) {
    workersDevSuffix = explicit.endsWith('.workers.dev') ? explicit : `${explicit}.workers.dev`;
    return;
  }

  if (!runtime.APP_ORIGIN) return;
  try {
    const host = new URL(runtime.APP_ORIGIN).hostname;
    const parts = host.split('.');
    if (host.endsWith('.workers.dev') && parts.length >= 4) {
      workersDevSuffix = parts.slice(1).join('.');
    }
  } catch {}
}

function correctWorkersDevUrl(value: string): string {
  if (!workersDevSuffix) return value;
  try {
    const parsed = new URL(value);
    const parts = parsed.hostname.split('.');
    if (parts.length === 3 && parts[1] === 'workers' && parts[2] === 'dev') {
      parsed.hostname = `${parts[0]}.${workersDevSuffix}`;
      return parsed.href.replace(/\/$/, parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : '/');
    }
  } catch {}
  return value;
}

function rewriteWorkerTarget(input: RequestInfo | URL): RequestInfo | URL {
  if (!workersDevSuffix) return input;
  const value = requestUrl(input);
  const corrected = correctWorkersDevUrl(value);
  if (corrected === value) return input;
  console.warn(JSON.stringify({ event: 'workers_dev_account_subdomain_repaired', from: value, to: corrected }));
  return new URL(corrected);
}

async function repairStoredWorkerUrls(env: unknown): Promise<void> {
  const runtime = (env || {}) as BootstrapEnv;
  if (!runtime.DB || !workersDevSuffix) return;

  try {
    const result = await runtime.DB.prepare(
      'SELECT id, worker_url FROM project_deployments WHERE worker_url IS NOT NULL ORDER BY created_at DESC LIMIT 100'
    ).all();
    const rows = (result.results || []) as Array<{ id?: string; worker_url?: string }>;
    for (const row of rows) {
      if (!row.id || !row.worker_url) continue;
      const corrected = correctWorkersDevUrl(row.worker_url);
      if (corrected !== row.worker_url) {
        await runtime.DB.prepare('UPDATE project_deployments SET worker_url = ? WHERE id = ?')
          .bind(corrected, row.id)
          .run();
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'stored_worker_url_repair_failed', reason: error instanceof Error ? error.message : String(error) }));
  }
}

async function repairProjectResponse(request: Request, response: Response): Promise<Response> {
  if (!workersDevSuffix || !response.headers.get('content-type')?.includes('application/json')) return response;
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/projects')) return response;

  try {
    const accountLabel = workersDevSuffix.replace(/\.workers\.dev$/, '');
    let text = await response.text();
    text = text.replace(/https:\/\/([a-z0-9-]+)\.workers\.dev/gi, `https://$1.${workersDevSuffix}`);
    text = text.replace(/"worker_name":"([a-z0-9-]+)"/gi, `"worker_name":"$1.${accountLabel}"`);
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    return response;
  }
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

function installGithubBootstrapGuard(): void {
  if (githubBootstrapInstalled) return;
  githubBootstrapInstalled = true;

  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    let nextInput: RequestInfo | URL = rewriteWorkerTarget(input);
    let url = requestUrl(nextInput);
    const method = init?.method?.toUpperCase() || (input instanceof Request ? input.method.toUpperCase() : 'GET');
    let nextInit = init;

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
        payload.auto_init = true;
        nextInit = { ...init, body: JSON.stringify(payload) };
      } catch {}
    }

    let response = await nativeFetch(nextInput, nextInit);

    if (
      workersDevSuffix &&
      /^https:\/\/[^/.]+\.[^/.]+\.workers\.dev\/?$/.test(url) &&
      method === 'GET' &&
      response.status >= 400
    ) {
      for (const waitMs of [800, 1600, 2400]) {
        await delay(waitMs);
        response = await nativeFetch(nextInput, nextInit);
        if (response.status >= 200 && response.status < 400) break;
      }
    }

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
          const login = await githubLogin(headers);
          if (login) {
            const existing = await nativeFetch(`https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}`, { headers });
            if (existing.ok) {
              console.warn(JSON.stringify({ event: 'github_repository_create_recovered', repository: `${login}/${name}` }));
              return existing;
            }
          }
        }
      } catch {}
    }

    if (method === 'PUT' && response.status === 422 && isGithubContentsUrl(url)) {
      response = await retryGithubContentUpdateWithSha(nextInput, nextInit, response);
    }

    if (
      response.status === 404 &&
      method === 'PUT' &&
      isGithubContentsUrl(url)
    ) {
      for (const waitMs of [150, 350, 750]) {
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
    configureWorkersDevSuffix(env);
    const module = await entry;
    const response = await module.default.fetch(request, env as never);
    return repairProjectResponse(request, response);
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    configureWorkersDevSuffix(env);
    const module = await entry;
    await module.default.queue(batch as never, env as never);
    await repairStoredWorkerUrls(env);
  },
};
