import legacy, { BuildCoordinator } from './entry-watchdog';
import { handleMeshRequest } from './mesh-runtime';
import { meshAiSettingsPage } from './mesh-ai-ui';
import { polishMeshPage } from './mesh-polish';

export { BuildCoordinator };

type RuntimeEnv = Parameters<typeof handleMeshRequest>[1];

async function enhanceMeshHome(response: Response): Promise<Response> {
  const body = await response.text();
  const oldAiClick = "if(n.mode==='ai'){note('Open AI Toolbox settings in the legacy studio to add this provider, or use Workers AI which is native.');return}";
  const newAiClick = "if(n.mode==='ai'){location.href='/ai?provider='+encodeURIComponent(id);return}";
  const enhanced = polishMeshPage(body.replace(oldAiClick, newAiClick));
  if (enhanced === body) throw new Error('Mesh home AI connection routing marker was not found');
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(enhanced, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/ai' && request.method === 'GET') return meshAiSettingsPage(request);

      const mesh = await handleMeshRequest(request, env);
      if (mesh) return url.pathname === '/' && request.method === 'GET' ? enhanceMeshHome(mesh) : mesh;
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
