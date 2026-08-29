export { BuildCoordinator } from './index';

type RuntimeEnv = {
  DB?: D1Database;
};

type BuildQueueBody = { projectId?: string };

type CapturedPrompt = {
  prompt: string;
  projectId?: string;
  deriveIdFromResponse: boolean;
};

async function ensureFullPromptTable(env: RuntimeEnv): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_full_prompts (
    project_id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`).run();
}

async function storeFullPrompt(env: RuntimeEnv, projectId: string, prompt: string): Promise<void> {
  if (!env.DB || !projectId || !prompt.trim()) return;
  await ensureFullPromptTable(env);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO project_full_prompts (project_id, prompt, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`)
    .bind(projectId, prompt, now).run();
  await env.DB.prepare('UPDATE projects SET prompt = ?, updated_at = ? WHERE id = ?')
    .bind(prompt, now, projectId).run();
}

async function restoreFullPrompt(env: RuntimeEnv, projectId: string): Promise<void> {
  if (!env.DB || !projectId) return;
  await ensureFullPromptTable(env);
  const row = await env.DB.prepare('SELECT prompt FROM project_full_prompts WHERE project_id = ?')
    .bind(projectId).first<{ prompt?: string }>();
  if (row?.prompt) {
    await env.DB.prepare('UPDATE projects SET prompt = ? WHERE id = ?').bind(row.prompt, projectId).run();
  }
}

async function capturePromptBeforeDispatch(request: Request): Promise<CapturedPrompt | null> {
  if (request.method !== 'POST') return null;
  const url = new URL(request.url);
  const direct = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/(build|reject)$/);
  const create = url.pathname === '/projects';
  const duplicate = /^\/projects\/[0-9a-f-]{36}\/duplicate$/.test(url.pathname);
  if (!direct && !create && !duplicate) return null;

  try {
    const body = await request.clone().json() as { prompt?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) return null;
    return {
      prompt,
      projectId: direct?.[1],
      deriveIdFromResponse: create || duplicate,
    };
  } catch {
    return null;
  }
}

async function finishPromptCapture(captured: CapturedPrompt | null, response: Response, env: RuntimeEnv): Promise<void> {
  if (!captured) return;
  let projectId = captured.projectId || '';
  if (captured.deriveIdFromResponse && response.ok) {
    try {
      const body = await response.clone().json() as { project?: { id?: string } };
      projectId = body.project?.id || projectId;
    } catch {}
  }
  if (projectId) await storeFullPrompt(env, projectId, captured.prompt);
}

const entry = import('./entry-hardening');

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const captured = await capturePromptBeforeDispatch(request);
    const module = await entry;
    const response = await module.default.fetch(request, env as never);
    try {
      await finishPromptCapture(captured, response, env);
    } catch (error) {
      console.warn(JSON.stringify({ event: 'outer_full_prompt_capture_failed', reason: error instanceof Error ? error.message : String(error) }));
    }
    return response;
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    try {
      for (const message of batch.messages) {
        const body = message.body as BuildQueueBody;
        if (body?.projectId) await restoreFullPrompt(env, body.projectId);
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'outer_full_prompt_restore_failed', reason: error instanceof Error ? error.message : String(error) }));
    }
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};