export { BuildCoordinator } from './index';

const agentic = import('./entry-agentic');

function diagnostic(error: unknown): Response {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(JSON.stringify({ event: 'agentic_runtime_uncaught', reason }));
  return Response.json({
    ok: false,
    error: 'Procedural agent runtime failed',
    reason,
    mode: 'procedural-agentic',
  }, { status: 500, headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        mode: 'procedural-agentic',
        execution_plane: 'github-actions',
        llm_provider: 'openrouter',
        model_policy: 'explicit-:free-only',
        confirmation_gates: [
          'intent',
          'architecture',
          'engineering_plan',
          'deployment',
          'final_user_acceptance',
        ],
        timestamp: new Date().toISOString(),
      }, { headers: { 'cache-control': 'no-store' } });
    }
    try {
      const module = await agentic;
      return await module.default.fetch(request, env as never, ctx);
    } catch (error) {
      return diagnostic(error);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    const module = await agentic;
    return module.default.queue(batch as never, env as never);
  },
};