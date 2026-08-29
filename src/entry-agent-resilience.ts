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

const PLANNER_HARDENING = [
  'CRITICAL PROCEDURAL PLAN QUALITY RULES:',
  '- The GitHub repository, GitHub Actions execution plane, Vela control plane, OpenRouter access, and deployment gate already exist. NEVER create engineering tasks whose purpose is to create/configure those orchestration primitives.',
  '- Forbidden meta-task examples: Create GitHub Repository, Establish Cloudflare Control Plane, Configure OpenRouter, Configure GitHub Actions, Prepare for Deployment, generic Integrate Components, generic Conduct Testing.',
  '- Tasks must implement the requested PRODUCT inside the repository: real source modules, schemas/migrations, domain logic, ingestion/integrations, APIs, UI, tests, and validation that map directly to the confirmed requirements.',
  '- Complex products should normally decompose into roughly 8-20 concrete implementation tasks; simple products may use fewer. Do not compress a complex specification into generic labels.',
  '- Task titles, scope, acceptance criteria, and files_expected must contain domain-specific concepts from the requirements. A task that could fit almost any app is too generic.',
  '- files_expected must be real implementation files. Do not invent orchestration artifacts such as github-repository.json, cloudflare-control-plane.json, deployment-preparation.json, or test-results.json.',
  '- validation_commands are checks only. They must not deploy, push/commit, start long-running servers, create infrastructure, or invoke imaginary CLIs. Prefer node --check, npm test, npm run build, targeted test commands, and wrangler deploy --dry-run when applicable.',
  '- Do not include actual deployment. Deployment happens only after the later explicit user approval gate.',
].join('\n');

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

function isPlannerRequest(body: ChatBody | null): boolean {
  return !!body?.messages?.some(message => /engineering manager for an autonomous procedural coding system/i.test(String(message.content || '')));
}

function hardenPlannerBody(body: ChatBody): ChatBody {
  if (!isPlannerRequest(body)) return body;
  const messages = (body.messages || []).map(message => ({ ...message }));
  const systemIndex = messages.findIndex(message => message.role === 'system');
  if (systemIndex >= 0) {
    messages[systemIndex].content = `${String(messages[systemIndex].content || '')}\n\n${PLANNER_HARDENING}`;
  } else {
    messages.unshift({ role: 'system', content: PLANNER_HARDENING });
  }
  return { ...body, messages };
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

function planQualityIssue(plan: unknown): string | null {
  if (!plan || typeof plan !== 'object') return 'planner output is not an object';
  const tasks = (plan as { tasks?: Array<Record<string, unknown>> }).tasks;
  if (!Array.isArray(tasks) || tasks.length < 3) return 'task graph is missing or implausibly small';

  const ids = new Set<string>();
  for (const task of tasks) {
    const id = String(task.id || '').trim();
    if (!id) return 'a task is missing an id';
    if (ids.has(id)) return `duplicate task id ${id}`;
    ids.add(id);
  }

  const forbiddenMeta = /\b(create github repository|establish cloudflare control plane|configure openrouter|configure github actions|prepare for deployment|deployment preparation|integrate components|conduct thorough testing)\b/i;
  const forbiddenArtifacts = /(^|\/)(github-repository|cloudflare-control-plane|deployment-preparation|test-results)\.json$/i;
  let generic = 0;
  for (const task of tasks) {
    const title = String(task.title || '');
    if (forbiddenMeta.test(title)) return `orchestration/meta task leaked into product plan: ${title}`;
    if (/^(develop|create|implement)\s+(frontend application|backend application|application)$/i.test(title.trim())) generic++;
    const expected = Array.isArray(task.files_expected) ? task.files_expected.map(String) : [];
    if (expected.some(file => forbiddenArtifacts.test(file))) return `fake orchestration artifact leaked into files_expected for ${String(task.id || title)}`;
    const commands = Array.isArray(task.validation_commands) ? task.validation_commands.map(String) : [];
    const rejected = commands.filter(command => !allowedValidationCommand(command));
    if (rejected.length) return `non-validation command leaked into ${String(task.id || title)}: ${rejected[0]}`;
    const dependencies = Array.isArray(task.depends_on) ? task.depends_on.map(String) : [];
    for (const dep of dependencies) if (!ids.has(dep)) return `task ${String(task.id || title)} depends on missing task ${dep}`;
  }
  if (tasks.length >= 6 && generic >= Math.ceil(tasks.length / 3)) return 'too many generic cross-domain task titles';
  return null;
}

async function plannerIssueFromResponse(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  let outer: OpenRouterPayload;
  try { outer = await response.clone().json() as OpenRouterPayload; } catch { return 'OpenRouter response is not JSON'; }
  const content = outer.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return 'planner response has no assistant content';
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch {
    const recovered = firstBalancedJson(content);
    if (!recovered) return 'planner response content is not valid JSON';
    try { parsed = JSON.parse(recovered); } catch { return 'planner response JSON could not be recovered'; }
  }
  return planQualityIssue(parsed);
}

async function openRouterWithFailover(input: RequestInfo | URL, init: RequestInit | undefined, downstream: typeof fetch): Promise<Response> {
  const parsedBody = parseChatBody(init);
  if (!parsedBody) return downstream(input, init);

  const body = hardenPlannerBody(parsedBody);
  const planner = isPlannerRequest(body);
  const isStrict = strictJson(body);
  const primaryInit: RequestInit = { ...init, body: JSON.stringify(body) };
  const primaryRaw = await downstream(input, primaryInit);
  const primary = primaryRaw.ok ? await normalizeOpenRouter(primaryRaw, isStrict) : primaryRaw;
  let plannerIssue = planner && primary.ok ? await plannerIssueFromResponse(primary) : null;

  if (primary.ok && !plannerIssue) return primary;
  if (!plannerIssue && !isRetryableOpenRouter(primary.status)) return primary;

  if (plannerIssue) {
    console.warn(JSON.stringify({ event: 'engineering_plan_quality_rejected', reason: plannerIssue }));
  }

  const current = String(body.model || '');
  const candidates = FREE_FALLBACKS.filter(model => model !== current);
  const retryAfter = Number(primary.headers.get('retry-after') || 0);
  if (retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 6000));

  for (const model of candidates) {
    const fallbackBody: ChatBody = { ...body, model, messages: [...(body.messages || [])] };
    if (plannerIssue) {
      fallbackBody.messages = [
        ...(fallbackBody.messages || []),
        { role: 'system', content: `The previous engineering plan was rejected by Vela quality control: ${plannerIssue}. Produce a new plan that satisfies every procedural plan quality rule. Do not defend or lightly edit the rejected plan.` },
      ];
    }
    // Some free endpoints do not support response_format. Balanced JSON recovery remains authoritative.
    delete fallbackBody.response_format;
    const fallbackInit: RequestInit = { ...init, body: JSON.stringify(fallbackBody) };
    const responseRaw = await platformFetch(input, fallbackInit);
    if (responseRaw.ok) {
      const response = await normalizeOpenRouter(responseRaw, isStrict, model);
      const issue = planner ? await plannerIssueFromResponse(response) : null;
      if (!issue) {
        console.warn(JSON.stringify({ event: 'openrouter_free_model_failover', from: current, to: model, primary_status: primary.status, planner_repair: Boolean(plannerIssue) }));
        return response;
      }
      plannerIssue = issue;
      console.warn(JSON.stringify({ event: 'engineering_plan_fallback_quality_rejected', model, reason: issue }));
      continue;
    }
    const wait = Number(responseRaw.headers.get('retry-after') || 0);
    if (wait > 0) await sleep(Math.min(wait * 1000, 5000));
  }

  if (plannerIssue) {
    return new Response(JSON.stringify({ error: { message: `Vela rejected low-quality engineering plans from all available free planner models: ${plannerIssue}` } }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return primary;
}

function strengthenModels(models: unknown): unknown {
  if (!models || typeof models !== 'object') return models;
  const copy = structuredClone(models) as Record<string, unknown>;
  copy.fallbacks = FREE_FALLBACKS;
  copy.policy = 'Only explicit OpenRouter :free models may execute engineering work. On upstream rate limits or provider failures, Vela automatically rotates through the approved explicit free fallback models. Cloudflare Workers AI and generic scaffolds are forbidden coding fallbacks.';
  return copy;
}

function patchAgentRunner(source: string): string {
  let patched = source;
  if (patched.includes(RUNNER_POST_ORIGINAL)) {
    patched = patched.replace(RUNNER_POST_ORIGINAL, RUNNER_POST_RESILIENT);
  }
  return patched;
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
  if (url.includes('/contents/.vela/agent-runner.mjs')) {
    const patched = patchAgentRunner(decoded);
    if (patched !== decoded) {
      payload.content = encodeBase64(patched);
      console.warn(JSON.stringify({ event: 'agent_runner_transport_retries_injected' }));
    }
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
