export { BuildCoordinator } from './index';

const entry = import('./entry-root');

function copyHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => headers.append(key, value));
  return headers;
}

async function patchDashboard(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  let html = await response.text();
  html = html.replace(
    "const retryBtn = p.status === 'failed' ?",
    "const retryBtn = (p.status === 'failed' || p.status === 'live') ?",
  );
  html = html.replace(
    '>Retry Build</button>',
    ">${p.status === 'live' ? 'Rebuild App' : 'Retry Build'}</button>",
  );

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers: copyHeaders(response.headers),
  });
}

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const module = await entry;
    const response = await module.default.fetch(request, env as never);
    if (request.method === 'GET' && new URL(request.url).pathname === '/') {
      return patchDashboard(response);
    }
    return response;
  },

  async queue(batch: MessageBatch<unknown>, env: unknown): Promise<void> {
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};