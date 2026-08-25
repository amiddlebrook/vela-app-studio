export interface Env {
  DB: D1Database;
  BUILDS: DurableObjectNamespace;
  BUILD_JOBS: Queue<{ projectId: string; prompt: string }>;
  GOOGLE_CLIENT_ID: string;
  GITHUB_CLIENT_ID: string;
  CLOUDFLARE_CLIENT_ID: string;
  APP_ORIGIN: string;
}

export class BuildCoordinator {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const body = await request.json<{ id?: string; prompt?: string }>();
    if (!body.id || !body.prompt) return Response.json({ error: 'id and prompt are required' }, { status: 400 });
    await this.state.storage.put('build', { status: 'planned', prompt: body.prompt, updatedAt: new Date().toISOString() });
    return Response.json({ id: body.id, status: 'planned' });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'vela-control-plane' });
    const provider = url.pathname.match(/^\/auth\/(google|github|cloudflare)\/start$/)?.[1];
    if (provider) {
      const state = crypto.randomUUID();
      const callback = `${env.APP_ORIGIN}/auth/${provider}/callback`;
      const params = new URLSearchParams({ state, redirect_uri: callback });
      if (provider === 'google') {
        params.set('client_id', env.GOOGLE_CLIENT_ID);
        params.set('response_type', 'code');
        params.set('scope', 'openid email profile');
        return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
      }
      if (provider === 'github') {
        params.set('client_id', env.GITHUB_CLIENT_ID);
        params.set('scope', 'repo workflow read:user');
        return Response.redirect(`https://github.com/login/oauth/authorize?${params}`);
      }
      params.set('client_id', env.CLOUDFLARE_CLIENT_ID);
      params.set('response_type', 'code');
      return Response.redirect(`https://dash.cloudflare.com/oauth2/auth?${params}`);
    }
    if (url.pathname === '/projects' && request.method === 'POST') {
      const body = await request.json<{ name?: string; prompt?: string; ownerId?: string }>();
      if (!body.name || !body.prompt || !body.ownerId) return Response.json({ error: 'name, prompt, and ownerId are required' }, { status: 400 });
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO projects (id, owner_id, name, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, body.ownerId, body.name, body.prompt, 'planning', now, now).run();
      await env.BUILD_JOBS.send({ projectId: id, prompt: body.prompt });
      const build = env.BUILDS.getByName(id);
      const result = await build.fetch('https://build.internal/', { method: 'POST', body: JSON.stringify({ id, prompt: body.prompt }) });
      return new Response(result.body, { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
