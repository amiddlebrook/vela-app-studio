import legacy, { BuildCoordinator } from './entry-watchdog';
import { handleMeshRequest } from './mesh-runtime';

export { BuildCoordinator };

type RuntimeEnv = Parameters<typeof handleMeshRequest>[1];

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const mesh = await handleMeshRequest(request, env);
      if (mesh) return mesh;
      return legacy.fetch(request, env as never, ctx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'mesh_entry_failure', reason }));
      return Response.json({ error: 'Universal mesh runtime failed', reason }, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    return legacy.queue(batch as never, env as never);
  },
  async scheduled(controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    return legacy.scheduled(controller, env as never, ctx);
  },
};
