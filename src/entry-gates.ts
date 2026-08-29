export { BuildCoordinator } from './index';

const runtime = import('./entry-runtime');

type RuntimeEnv = {
  DB?: D1Database;
};

type AgentRow = {
  project_id: string;
  phase: string;
  intent_json: string | null;
  architecture_json: string | null;
  task_plan_json: string | null;
  model_strategy_json: string | null;
  validation_json: string | null;
  build_commit_sha: string | null;
  live_url: string | null;
  last_error: string | null;
};

function parsed(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function agentPayload(row: AgentRow | undefined, fallbackPhase?: unknown): Record<string, unknown> | null {
  if (!row && typeof fallbackPhase !== 'string') return null;
  return {
    phase: row?.phase || fallbackPhase,
    intent: parsed(row?.intent_json || null),
    architecture: parsed(row?.architecture_json || null),
    task_plan: parsed(row?.task_plan_json || null),
    models: parsed(row?.model_strategy_json || null),
    validation: parsed(row?.validation_json || null),
    commit_sha: row?.build_commit_sha || null,
    live_url: row?.live_url || null,
    last_error: row?.last_error || null,
  };
}

async function forceAgentStateIntoProjects(response: Response, env: RuntimeEnv): Promise<Response> {
  if (!response.ok || !env.DB) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return response;

  let body: { projects?: Array<Record<string, unknown> & { id?: string; status?: string; agent?: unknown }> };
  try {
    body = await response.clone().json() as typeof body;
  } catch {
    return response;
  }

  const projects = body.projects || [];
  const ids = projects.map(project => project.id).filter((id): id is string => Boolean(id));
  if (!ids.length) return response;

  let byId = new Map<string, AgentRow>();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT project_id,phase,intent_json,architecture_json,task_plan_json,model_strategy_json,validation_json,build_commit_sha,live_url,last_error FROM agent_projects WHERE project_id IN (${placeholders})`)
      .bind(...ids).all<AgentRow>();
    byId = new Map((rows.results || []).map(row => [row.project_id, row]));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'confirmation_gate_agent_lookup_failed', reason: error instanceof Error ? error.message : String(error) }));
  }

  const gatePhases = new Set([
    'awaiting_intent_confirmation',
    'awaiting_architecture_confirmation',
    'awaiting_build_plan_confirmation',
    'bootstrapping_agent',
    'agent_running',
    'awaiting_deploy_approval',
    'awaiting_user_acceptance',
  ]);

  body.projects = projects.map(project => {
    const id = project.id || '';
    const row = byId.get(id);
    if (row) return { ...project, agent: agentPayload(row, project.status) };
    if (!project.agent && typeof project.status === 'string' && gatePhases.has(project.status)) {
      return { ...project, agent: agentPayload(undefined, project.status) };
    }
    return project;
  });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function stableGateUi(): string {
  return String.raw`
<style>
.vela-agent-gate{margin:14px 0;padding:16px;border:1px solid #334575;border-radius:14px;background:#090d1c}.vela-agent-gate h4{color:#46d0f7;margin:0 0 8px}.vela-agent-gate pre{max-height:340px;overflow:auto;white-space:pre-wrap}.vela-agent-note{font-size:12px;color:#aab5d8;line-height:1.5}.vela-agent-feedback{width:100%;min-height:78px;margin-top:10px}.vela-agent-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
</style>
<script>
(function(){
  function safe(v){return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function pretty(v){try{return JSON.stringify(v,null,2)}catch(e){return String(v == null ? '' : v)}}
  function gateButton(label,id,action,cls){return '<button class="'+(cls||'primary')+'" data-vela-agent-id="'+safe(id)+'" data-vela-agent-action="'+safe(action)+'">'+safe(label)+'</button>'}
  function feedback(id){return '<textarea class="vela-agent-feedback" id="vela-agent-feedback-'+safe(id)+'" placeholder="Add corrections, decisions, constraints, or revisions before continuing..."></textarea>'}
  function gate(p){
    var a=p.agent;if(!a)return '';
    var f=feedback(p.id),actions='';
    if(a.phase==='awaiting_intent_confirmation'){
      actions=gateButton('Confirm Intent',p.id,'confirm_intent')+gateButton('Revise Intent',p.id,'revise_intent','secondary');
      return '<div class="vela-agent-gate"><h4>1 / 5 — Confirm Product Intent</h4><div class="vela-agent-note">Vela cannot choose architecture until you confirm this interpretation.</div><pre>'+safe(pretty(a.intent))+'</pre>'+f+'<div class="vela-agent-actions">'+actions+'</div></div>';
    }
    if(a.phase==='awaiting_architecture_confirmation'){
      actions=gateButton('Confirm Architecture',p.id,'confirm_architecture')+gateButton('Revise Architecture',p.id,'revise_architecture','secondary');
      return '<div class="vela-agent-gate"><h4>2 / 5 — Confirm Architecture</h4><div class="vela-agent-note">Review the execution plane, Cloudflare components, data strategy, and material decisions before engineering begins.</div><pre>'+safe(pretty(a.architecture))+'</pre>'+f+'<div class="vela-agent-actions">'+actions+'</div></div>';
    }
    if(a.phase==='awaiting_build_plan_confirmation'){
      actions=gateButton('Approve Procedural Build',p.id,'confirm_plan')+gateButton('Revise Plan',p.id,'revise_plan','secondary');
      return '<div class="vela-agent-gate"><h4>3 / 5 — Confirm Engineering Plan + Free Models</h4><div class="vela-agent-note">The build will execute task-by-task in GitHub Actions with explicit OpenRouter :free models.</div><pre>'+safe(pretty({models:a.models,task_plan:a.task_plan}))+'</pre>'+f+'<div class="vela-agent-actions">'+actions+'</div></div>';
    }
    if(a.phase==='bootstrapping_agent'||a.phase==='agent_running')return '<div class="vela-agent-gate"><h4>Engineering Agents Running</h4><div class="vela-agent-note">GitHub Actions is operating the real repository: inspect → edit → run → debug → review → checkpoint → integrate → validate.</div><pre>'+safe(pretty({models:a.models,commit:a.commit_sha,validation:a.validation}))+'</pre></div>';
    if(a.phase==='awaiting_deploy_approval'){
      actions=gateButton('Approve Cloudflare Deployment',p.id,'deploy')+gateButton('Send Back for Changes',p.id,'continue','secondary');
      return '<div class="vela-agent-gate"><h4>4 / 5 — Engineering Passed; Confirm Deployment</h4><div class="vela-agent-note">No deployment occurs until you approve the validated commit.</div><pre>'+safe(pretty({commit:a.commit_sha,validation:a.validation}))+'</pre>'+f+'<div class="vela-agent-actions">'+actions+'</div></div>';
    }
    if(a.phase==='awaiting_user_acceptance'){
      actions=gateButton('Accept as Complete',p.id,'accept')+gateButton('Continue Engineering',p.id,'continue','secondary');
      return '<div class="vela-agent-gate"><h4>5 / 5 — Final User Acceptance</h4><div class="vela-agent-note">The deployed application passed live QA. You decide whether it is actually complete.</div><div class="vela-agent-actions"><a class="secondary" style="text-decoration:none" target="_blank" href="'+safe(a.live_url||'#')+'">Open Live App ↗</a>'+actions+'</div>'+f+'</div>';
    }
    if(a.phase==='complete')return '<div class="vela-agent-gate"><h4>COMPLETE — User Accepted</h4></div>';
    if(a.phase==='failed')return '<div class="vela-agent-gate"><h4>Agentic Build Failed</h4><pre>'+safe(a.last_error||'Unknown failure')+'</pre></div>';
    return '';
  }
  async function postAction(id,action){
    var routes={
      confirm_intent:'/projects/'+id+'/agent/intent/confirm',revise_intent:'/projects/'+id+'/agent/intent/revise',
      confirm_architecture:'/projects/'+id+'/agent/architecture/confirm',revise_architecture:'/projects/'+id+'/agent/architecture/revise',
      confirm_plan:'/projects/'+id+'/agent/plan/confirm',revise_plan:'/projects/'+id+'/agent/plan/revise',
      deploy:'/projects/'+id+'/agent/deploy/approve',accept:'/projects/'+id+'/agent/accept',continue:'/projects/'+id+'/agent/continue'
    };
    var node=document.getElementById('vela-agent-feedback-'+id);var feedback=node?node.value:'';
    var res=await fetch(routes[action],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({feedback:feedback})});
    if(!res.ok){var t=await res.text();throw new Error(t||('Request failed '+res.status))}
    if(typeof loadWorkspace==='function')await loadWorkspace();
  }
  document.addEventListener('click',function(event){
    var target=event.target instanceof Element?event.target.closest('[data-vela-agent-action]'):null;
    if(!target)return;
    event.preventDefault();
    postAction(target.getAttribute('data-vela-agent-id')||'',target.getAttribute('data-vela-agent-action')||'').catch(function(error){alert(error.message||String(error))});
  });
  function render(){
    if(typeof projects==='undefined')return;
    var root=document.getElementById('project-list');if(!root)return;
    if(!projects.length){root.innerHTML='<div style="padding:48px 0;text-align:center;color:var(--muted)">No applications built yet.</div>';return}
    root.innerHTML=projects.map(function(p){
      var a=p.agent;var status=(a&&a.phase)||p.status;
      var repo=p.github_repository?'<a href="https://github.com/'+safe(p.github_repository)+'" target="_blank" class="secondary" style="text-decoration:none">GitHub Repo ↗</a>':'';
      var live=a&&a.live_url?'<a href="'+safe(a.live_url)+'" target="_blank" class="secondary" style="text-decoration:none;color:var(--cyan)">Open Live App ↗</a>':'';
      var retry=(status==='failed'||status==='complete')?'<button class="secondary" data-vela-retry="'+safe(p.id)+'">'+(status==='complete'?'Start Change Request':'Restart Procedural Build')+'</button>':'';
      return '<article class="project-card"><div class="p-head"><div><h3>'+safe(p.name)+'</h3><div style="font-size:11px;color:var(--muted);margin-top:3px">ID: '+safe(String(p.id).slice(0,8))+' · Updated '+safe(new Date(p.updated_at).toLocaleTimeString())+'</div></div><span class="badge">● '+safe(String(status).replaceAll('_',' '))+'</span></div><p class="p-desc">'+safe(p.prompt)+'</p>'+(p.latest_event?'<div style="font-size:12px;color:var(--muted);margin-bottom:12px"><b>'+safe(p.latest_event.kind)+'</b>: '+safe(p.latest_event.detail)+'</div>':'')+gate(p)+'<div class="action-row">'+live+repo+retry+'<button class="danger" data-vela-delete="'+safe(p.id)+'" data-vela-name="'+safe(p.name)+'">Delete Build 🗑</button></div></article>';
    }).join('');
  }
  document.addEventListener('click',function(event){
    var el=event.target instanceof Element?event.target.closest('[data-vela-retry],[data-vela-delete]'):null;if(!el)return;
    var retry=el.getAttribute('data-vela-retry');if(retry&&typeof retryBuild==='function'){event.preventDefault();retryBuild(retry);return}
    var del=el.getAttribute('data-vela-delete');if(del&&typeof deleteProject==='function'){event.preventDefault();deleteProject(del,el.getAttribute('data-vela-name')||'project')}
  });
  try{renderProjects=render}catch(e){}
  try{window.renderProjects=render}catch(e){}
  if(typeof loadWorkspace==='function')loadWorkspace();else render();
})();
</script>`;
}

async function patchRootUi(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;
  let html = await response.text();
  html = html.replace('</body>', `${stableGateUi()}</body>`);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    const module = await runtime;
    let response = await module.default.fetch(request, env as never, ctx);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/projects') {
      response = await forceAgentStateIntoProjects(response, env);
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response = await patchRootUi(response);
    }
    return response;
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    const module = await runtime;
    return module.default.queue(batch as never, env as never);
  },
};
