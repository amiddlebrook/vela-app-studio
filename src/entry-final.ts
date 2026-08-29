export { BuildCoordinator } from './index';

const platformFetch = globalThis.fetch.bind(globalThis);
let workersDevSubdomain = 'averymiddlebrook2014';
let cloudflareApiToken: string | undefined;
let cloudflareAccountId: string | undefined;
let installed = false;

type RuntimeEnv = {
  DB?: D1Database;
  WORKERS_DEV_SUBDOMAIN?: unknown;
  CLOUDFLARE_API_TOKEN?: unknown;
  CLOUDFLARE_ACCOUNT_ID?: unknown;
};

function bindRuntime(env: unknown): void {
  const runtime = env as RuntimeEnv | null;

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

function rewriteWorkersDevInput(input: RequestInfo | URL): RequestInfo | URL {
  const raw = requestUrl(input);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return input;
  }

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

function generatedWorkerScript(input: RequestInfo | URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl(input));
  } catch {
    return null;
  }

  const suffix = `.${workersDevSubdomain}.workers.dev`;
  if (!parsed.hostname.toLowerCase().endsWith(suffix.toLowerCase())) return null;
  const script = parsed.hostname.slice(0, -suffix.length);
  return script.startsWith('vela-') && script !== 'vela-control-plane' ? script : null;
}

function healthy(response: Response): boolean {
  return response.status >= 200 && response.status < 400;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generatedWorkerFetch(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 7000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('generated worker verification timeout'), timeoutMs);
  try {
    return await platformFetch(input, { ...init, signal: init?.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureGeneratedWorkerRoute(script: string): Promise<void> {
  if (!cloudflareApiToken || !cloudflareAccountId) return;

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccountId)}/workers/scripts/${encodeURIComponent(script)}/subdomain`;
  const response = await platformFetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cloudflareApiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ enabled: true, previews_enabled: true }),
  });

  if (!response.ok) {
    const detail = (await response.clone().text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    console.warn(JSON.stringify({
      event: 'generated_worker_route_repair_failed',
      script,
      status: response.status,
      detail,
    }));
    return;
  }

  console.warn(JSON.stringify({ event: 'generated_worker_route_repaired', script }));
}

async function fetchWithGeneratedWorkerRepair(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rewritten = rewriteWorkersDevInput(input);
  const script = generatedWorkerScript(rewritten);
  if (!script) return platformFetch(rewritten, init);

  let response: Response | undefined;
  let lastError: unknown;
  try {
    response = await generatedWorkerFetch(rewritten, init);
    if (healthy(response)) return response;
  } catch (error) {
    lastError = error;
  }

  try {
    await ensureGeneratedWorkerRoute(script);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'generated_worker_route_repair_exception',
      script,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  for (const waitMs of [400, 1000, 2000, 4000]) {
    await delay(waitMs);
    try {
      response = await generatedWorkerFetch(rewritten, init);
      if (healthy(response)) {
        console.warn(JSON.stringify({ event: 'generated_worker_verified_after_route_repair', script, status: response.status }));
        return response;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (response) return response;
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Generated Worker ${script} could not be reached after route repair`);
}

async function reconcileStuckDeployments(env: unknown): Promise<void> {
  const db = (env as RuntimeEnv | null)?.DB;
  if (!db) return;

  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  let projects: { id: string; worker_name: string; updated_at: string }[] = [];
  try {
    const result = await db.prepare(
      "SELECT id, worker_name, updated_at FROM projects WHERE status = 'deploying_worker' AND worker_name IS NOT NULL AND updated_at < ? ORDER BY updated_at ASC LIMIT 5",
    ).bind(cutoff).all<{ id: string; worker_name: string; updated_at: string }>();
    projects = result.results;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'stuck_deployment_scan_failed',
      reason: error instanceof Error ? error.message : String(error),
    }));
    return;
  }

  for (const project of projects) {
    const workerUrl = `https://${project.worker_name}.${workersDevSubdomain}.workers.dev/`;
    try {
      await ensureGeneratedWorkerRoute(project.worker_name);
      const response = await generatedWorkerFetch(workerUrl, { redirect: 'manual' }, 7000);
      if (!healthy(response)) continue;

      const now = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE projects SET status = 'live', updated_at = ? WHERE id = ? AND status = 'deploying_worker'").bind(now, project.id),
        db.prepare('INSERT INTO build_events (id, project_id, kind, detail, stage, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), project.id, 'live', `Recovered live deployment after successful edge probe: ${workerUrl}`, 'live', now),
      ]);
      console.warn(JSON.stringify({ event: 'stuck_deployment_reconciled', projectId: project.id, worker: project.worker_name }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'stuck_deployment_probe_failed',
        projectId: project.id,
        worker: project.worker_name,
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function rewriteWorkersDevText(text: string): string {
  let rewritten = text.replace(
    /https:\/\/([a-z0-9-]+)\.workers\.dev\b/gi,
    (_match, script: string) => `https://${script}.${workersDevSubdomain}.workers.dev`,
  );

  rewritten = rewritten.replaceAll(
    'https://${esc(p.worker_name)}.workers.dev',
    `https://\${esc(p.worker_name)}.${workersDevSubdomain}.workers.dev`,
  );

  return rewritten;
}

async function rewriteWorkersDevResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type') || '';
  if (!/text\/html|application\/json|text\/plain/i.test(contentType)) return response;

  const text = await response.text();
  const rewritten = rewriteWorkersDevText(text);
  if (rewritten === text) return new Response(text, response);

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function installWorkersDevTransportGuard(): void {
  if (installed) return;
  installed = true;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    return fetchWithGeneratedWorkerRepair(input, init);
  };
}

installWorkersDevTransportGuard();

const entry = import('./entry-bootstrap');

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    bindRuntime(env);
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/projects')) {
      await reconcileStuckDeployments(env);
    }
    const module = await entry;
    const response = await module.default.fetch(request, env as never);
    return rewriteWorkersDevResponse(response);
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    bindRuntime(env);
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
