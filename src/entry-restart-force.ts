export { BuildCoordinator } from './index';

const entry = import('./entry-procedural-final');
const SESSION_COOKIE = 'vela_session';
const encoder = new TextEncoder();

type RuntimeEnv = {
  DB?: D1Database;
  SESSION_SECRET?: string;
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function sessionHmac(value: string, rawSecret: string): Promise<string> {
  const normalized = base64Url(await sha256Bytes(rawSecret));
  const padded = normalized.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - normalized.length % 4) % 4);
  const raw = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function readSession(request: Request, secret: string): Promise<string | null> {
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!value) return null;
  const [id, signature] = value.split('.');
  if (!id || !signature) return null;
  return (await sessionHmac(id, secret)) === signature ? id : null;
}

async function normalizeExplicitRestart(request: Request, env: RuntimeEnv): Promise<void> {
  if (!env.DB || !env.SESSION_SECRET || request.method !== 'POST') return;
  const match = new URL(request.url).pathname.match(/^\/projects\/([0-9a-f-]{36})\/build$/);
  if (!match) return;

  const ownerId = await readSession(request, env.SESSION_SECRET);
  if (!ownerId) return;

  const project = await env.DB.prepare('SELECT id,status,github_repository FROM projects WHERE id=? AND owner_id=?')
    .bind(match[1], ownerId).first<{ id: string; status: string; github_repository: string | null }>();
  if (!project?.github_repository) return;

  const agent = await env.DB.prepare('SELECT phase,intent_json,architecture_json,task_plan_json FROM agent_projects WHERE project_id=?')
    .bind(project.id).first<{ phase: string; intent_json: string | null; architecture_json: string | null; task_plan_json: string | null }>();
  if (!agent?.intent_json || !agent.architecture_json || !agent.task_plan_json) return;
  if (agent.phase === 'complete' || agent.phase === 'awaiting_user_acceptance' || agent.phase === 'awaiting_deploy_approval') return;

  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE agent_projects SET phase=?,last_error=?,updated_at=? WHERE project_id=?')
    .bind('failed', 'Explicit procedural restart requested by user. Preserve confirmed intent, architecture, and task plan; dispatch a fresh engineering workflow from current main.', now, project.id).run();
  await env.DB.prepare('UPDATE projects SET status=?,updated_at=? WHERE id=?').bind('failed', now, project.id).run();
  try {
    await env.DB.prepare('INSERT INTO build_events(id,project_id,kind,detail,stage,created_at) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), project.id, 'manual_engineering_restart_requested', 'User explicitly forced a fresh procedural engineering run from the current repository and approved plan.', 'failed', now).run();
  } catch {}
}

function stuckRunRecoveryUi(): string {
  return String.raw`<script>
(function(){
  async function forceRestart(id, button){
    button.disabled=true;button.textContent='Restarting…';
    try{
      var res=await fetch('/projects/'+id+'/build',{method:'POST'});
      var text=await res.text();
      if(!res.ok)throw new Error(text||('Restart failed '+res.status));
      if(typeof loadWorkspace==='function')await loadWorkspace();
      else location.reload();
    }catch(error){button.disabled=false;button.textContent='Force Restart Engineering';alert(error.message||String(error));}
  }
  function addButtons(){
    document.querySelectorAll('.project-card').forEach(function(card){
      var gate=card.querySelector('.vela-agent-gate');
      if(!gate||!gate.textContent.includes('Engineering Agents Running'))return;
      var del=card.querySelector('[data-vela-delete]');
      var id=del&&del.getAttribute('data-vela-delete');
      var row=card.querySelector('.action-row');
      if(!id||!row||row.querySelector('[data-vela-force-restart]'))return;
      var b=document.createElement('button');
      b.className='secondary';b.textContent='Force Restart Engineering';b.setAttribute('data-vela-force-restart',id);
      b.addEventListener('click',function(){forceRestart(id,b)});
      row.insertBefore(b,row.lastElementChild||null);
    });
  }
  var observer=new MutationObserver(addButtons);observer.observe(document.documentElement,{subtree:true,childList:true});
  addButtons();setTimeout(addButtons,500);setTimeout(addButtons,1500);
})();
</script>`;
}

async function patchRoot(response: Response): Promise<Response> {
  if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) return response;
  const html = (await response.text()).replace('</body>', `${stuckRunRecoveryUi()}</body>`);
  const headers = new Headers(response.headers);headers.delete('content-length');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    await normalizeExplicitRestart(request, env);
    const module = await entry;
    let response = await module.default.fetch(request, env as never, ctx);
    if (request.method === 'GET' && new URL(request.url).pathname === '/') response = await patchRoot(response);
    return response;
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};
