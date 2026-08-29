export { BuildCoordinator } from './index';

const entry = import('./entry-engineering-retry');
const MARK = '__vela_engineering_final_guard__';

type MarkedFetch = typeof fetch & { [MARK]?: boolean };
type RuntimeEnv = Record<string, unknown>;

const RUNNER_POST_ORIGINAL = [
  'async function post(endpoint, body) {',
  '  const response = await fetch(controlPlane + endpoint, {',
  "    method: 'POST',",
  "    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
  '    body: JSON.stringify(Object.assign({ project_id: projectId, build_id: buildId }, body || {})),',
  '  });',
  '  const text = await response.text();',
  '  let payload = {};',
  '  try { payload = JSON.parse(text); } catch { payload = { error: text }; }',
  "  if (!response.ok) throw new Error(endpoint + ' failed (' + response.status + '): ' + String(payload.error || payload.reason || text).slice(0, 1000));",
  '  return payload;',
  '}',
].join('\n');

const RUNNER_POST_RESILIENT = [
  'async function post(endpoint, body) {',
  '  const url = controlPlane + endpoint;',
  '  const requestBody = JSON.stringify(Object.assign({ project_id: projectId, build_id: buildId }, body || {}));',
  "  const maxTransportAttempts = endpoint === '/internal/agent/event' ? 2 : 3;",
  "  const timeoutMs = endpoint === '/internal/agent/llm' ? 75000 : 30000;",
  "  let lastError = 'unknown transport failure';",
  '  for (let attempt = 1; attempt <= maxTransportAttempts; attempt++) {',
  '    const controller = new AbortController();',
  '    const timer = setTimeout(() => controller.abort(), timeoutMs);',
  '    try {',
  '      const response = await fetch(url, {',
  "        method: 'POST',",
  "        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
  '        body: requestBody,',
  '        signal: controller.signal,',
  '      });',
  '      const text = await response.text();',
  '      let payload = {};',
  '      try { payload = JSON.parse(text); } catch { payload = { error: text }; }',
  '      if (response.ok) return payload;',
  "      lastError = endpoint + ' failed (' + response.status + '): ' + String(payload.error || payload.reason || text).slice(0, 1200);",
  '    } catch (error) {',
  "      const cause = error && error.cause ? ' | cause=' + String(error.cause) : '';",
  "      lastError = (error instanceof Error ? error.message : String(error)) + cause;",
  '    } finally {',
  '      clearTimeout(timer);',
  '    }',
  '    if (attempt < maxTransportAttempts) {',
  '      const waitMs = Math.min(1500 * (2 ** (attempt - 1)), 6000);',
  "      console.warn('[VELA_TRANSPORT_RETRY]', endpoint, 'attempt', attempt, 'reason', lastError.slice(0, 600));",
  '      await new Promise(resolve => setTimeout(resolve, waitMs));',
  '    }',
  '  }',
  "  throw new Error(endpoint + ' transport failed after ' + maxTransportAttempts + ' attempts: ' + lastError);",
  '}',
].join('\n');

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

function allowedValidationCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/^wrangler\s+db\s+(migrate|seed)\b/i.test(cmd)) return false;
  if (/^github\s+actions\b/i.test(cmd)) return false;
  if (/^npm\s+run\s+(start|dev|serve)\b/i.test(cmd)) return false;
  if (/^wrangler\s+deploy\b/i.test(cmd)) return /--dry-run\b/i.test(cmd);
  if (/^npx\b.*\bwrangler\b.*\bdeploy\b/i.test(cmd) && !/--dry-run\b/i.test(cmd)) return false;
  if (/^git\s+(add|commit|push|pull|checkout|switch|reset|clean|rm|merge|rebase|tag)\b/i.test(cmd)) return false;
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

function patchRunner(source: string): string {
  return source.includes(RUNNER_POST_ORIGINAL)
    ? source.replace(RUNNER_POST_ORIGINAL, RUNNER_POST_RESILIENT)
    : source;
}

function transformGithubWrite(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const url = requestUrl(input);
  if (!/https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\//.test(url) || init?.method?.toUpperCase() !== 'PUT' || typeof init.body !== 'string') return init;

  let payload: Record<string, unknown> & { content?: string };
  try { payload = JSON.parse(init.body) as typeof payload; } catch { return init; }
  if (!payload.content) return init;

  let decoded: string;
  try { decoded = decodeBase64(payload.content); } catch { return init; }

  if (url.includes('/contents/.vela/agent-runner.mjs')) {
    const patched = patchRunner(decoded);
    if (patched !== decoded) {
      payload.content = encodeBase64(patched);
      console.warn(JSON.stringify({ event: 'engineering_retry_runner_transport_hardened' }));
    }
  }

  if (url.includes('/contents/.vela/task-plan.json')) {
    try {
      payload.content = encodeBase64(JSON.stringify(sanitizePlan(JSON.parse(decoded)), null, 2));
      console.warn(JSON.stringify({ event: 'engineering_retry_plan_commands_sanitized' }));
    } catch {}
  }

  return { ...init, body: JSON.stringify(payload) };
}

function installFinalGuard(): void {
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
    installFinalGuard();
    return module.default.fetch(request, env as never, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    installFinalGuard();
    return module.default.queue(batch as never, env as never);
  },
};
