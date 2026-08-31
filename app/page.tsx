'use client';

import React, { useEffect, useMemo, useState } from 'react';

type Connection = { provider: string; status?: string };
type WorkspaceSettings = {
  active_provider: string;
  openrouter_key?: string;
  openrouter_model: string;
  openai_key?: string;
  openai_model: string;
  gemini_key?: string;
  gemini_model: string;
  anthropic_key?: string;
  anthropic_model: string;
  cf_ai_model: string;
  custom_endpoint?: string;
  custom_key?: string;
  custom_model?: string;
};
type NodeDef = { id: string; name: string; group: string; icon: string; mode: 'oauth' | 'ai' | 'planned' | 'native' };
type Link = { id: string; from: string; to: string; capabilities: string[] };

const NODES: NodeDef[] = [
  { id: 'github', name: 'GitHub', group: 'Build', icon: 'GH', mode: 'oauth' },
  { id: 'cloudflare', name: 'Cloudflare', group: 'Build', icon: 'CF', mode: 'oauth' },
  { id: 'google', name: 'Google', group: 'Google', icon: 'G', mode: 'oauth' },
  { id: 'youtube', name: 'YouTube', group: 'Content', icon: 'YT', mode: 'planned' },
  { id: 'stripe', name: 'Stripe', group: 'Commerce', icon: '$', mode: 'planned' },
  { id: 'shopify', name: 'Shopify', group: 'Commerce', icon: 'S', mode: 'planned' },
  { id: 'amazon', name: 'Amazon', group: 'Commerce', icon: 'A', mode: 'planned' },
  { id: 'ebay', name: 'eBay', group: 'Commerce', icon: 'E', mode: 'planned' },
  { id: 'walmart', name: 'Walmart', group: 'Commerce', icon: 'W', mode: 'planned' },
  { id: 'reddit', name: 'Reddit', group: 'Content', icon: 'R', mode: 'planned' },
  { id: 'tiktok', name: 'TikTok', group: 'Content', icon: 'T', mode: 'planned' },
  { id: 'instagram', name: 'Instagram', group: 'Content', icon: 'IG', mode: 'planned' },
  { id: 'gmail', name: 'Gmail', group: 'Google', icon: 'M', mode: 'planned' },
  { id: 'drive', name: 'Drive', group: 'Google', icon: 'D', mode: 'planned' },
  { id: 'sheets', name: 'Sheets', group: 'Google', icon: 'SH', mode: 'planned' },
  { id: 'crawler', name: 'Web Crawler', group: 'Internet', icon: '◎', mode: 'native' },
  { id: 'webhook', name: 'Webhook / API', group: 'Internet', icon: '↗', mode: 'native' },
  { id: 'openrouter', name: 'OpenRouter', group: 'AI', icon: 'OR', mode: 'ai' },
  { id: 'openai', name: 'OpenAI', group: 'AI', icon: 'AI', mode: 'ai' },
  { id: 'anthropic', name: 'Anthropic', group: 'AI', icon: 'AN', mode: 'ai' },
  { id: 'gemini', name: 'Gemini', group: 'AI', icon: 'GM', mode: 'ai' },
  { id: 'workers-ai', name: 'Workers AI', group: 'AI', icon: 'CF', mode: 'ai' },
  { id: 'custom-ai', name: 'Custom AI', group: 'AI', icon: '+', mode: 'ai' },
];

const CAPABILITIES = ['Observe', 'Analyze', 'Create', 'Modify', 'Execute'];
const STORAGE_KEY = 'vela-universal-mesh-v1';

export default function Home() {
  const [connections, setConnections] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<WorkspaceSettings>({
    active_provider: 'auto',
    openrouter_model: 'openai/gpt-oss-120b',
    openai_model: 'gpt-5',
    gemini_model: 'gemini-2.5-flash',
    anthropic_model: 'claude-sonnet-4-20250514',
    cf_ai_model: '@cf/meta/llama-3.1-8b-instruct-fast',
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>(['Observe', 'Analyze']);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('All');
  const [panel, setPanel] = useState<'none' | 'ai' | 'planned' | 'native'>('none');
  const [panelNode, setPanelNode] = useState<NodeDef | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState('');
  const [apiUrl, setApiUrl] = useState('');

  const api = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const res = await fetch(path, options);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.reason || data.error || 'Request failed'));
    return data as T;
  };

  const refresh = async () => {
    try {
      await api('/session', { method: 'POST' });
      const [connData, settingsData] = await Promise.all([
        api<{ connections: Connection[] }>('/connections').catch(() => ({ connections: [] })),
        api<WorkspaceSettings>('/settings').catch(() => settings),
      ]);
      setConnections(new Set((connData.connections || []).filter(c => c.status !== 'disconnected').map(c => c.provider)));
      setSettings(settingsData);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load workspace');
    }
  };

  useEffect(() => {
    void refresh();
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { links?: Link[]; goal?: string };
        setLinks(Array.isArray(parsed.links) ? parsed.links : []);
        setGoal(parsed.goal || '');
      }
    } catch {}
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ links, goal })); } catch {}
  }, [links, goal]);

  const groups = useMemo(() => ['All', ...Array.from(new Set(NODES.map(n => n.group)))], []);
  const visibleNodes = useMemo(() => NODES.filter(n =>
    (group === 'All' || n.group === group) &&
    (!search.trim() || `${n.name} ${n.group}`.toLowerCase().includes(search.toLowerCase()))
  ), [group, search]);

  const aiConnected = (id: string) => {
    if (id === 'workers-ai') return true;
    if (id === 'openrouter') return Boolean(settings.openrouter_key && !settings.openrouter_key.includes('••'));
    if (id === 'openai') return Boolean(settings.openai_key && !settings.openai_key.includes('••'));
    if (id === 'anthropic') return Boolean(settings.anthropic_key && !settings.anthropic_key.includes('••'));
    if (id === 'gemini') return Boolean(settings.gemini_key && !settings.gemini_key.includes('••'));
    if (id === 'custom-ai') return Boolean(settings.custom_endpoint);
    return false;
  };

  const isConnected = (node: NodeDef) => node.mode === 'oauth' ? connections.has(node.id) : node.mode === 'ai' ? aiConnected(node.id) : node.mode === 'native';

  const clickNode = (node: NodeDef) => {
    if (!isConnected(node)) {
      setPanelNode(node);
      if (node.mode === 'oauth') {
        window.location.href = `/auth/${node.id}/start`;
        return;
      }
      setPanel(node.mode === 'ai' ? 'ai' : node.mode === 'native' ? 'native' : 'planned');
      return;
    }
    setSelected(prev => {
      if (prev.includes(node.id)) return prev.filter(x => x !== node.id);
      if (prev.length < 2) return [...prev, node.id];
      return [prev[1], node.id];
    });
  };

  const addLink = () => {
    if (selected.length !== 2) return;
    const [from, to] = selected;
    if (from === to) return;
    const existing = links.some(l => l.from === from && l.to === to);
    if (!existing) setLinks(prev => [...prev, { id: crypto.randomUUID(), from, to, capabilities }]);
    setSelected([]);
  };

  const saveAI = async () => {
    setBusy(true);
    try {
      await api('/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings),
      });
      setNotice('AI provider settings saved.');
      setPanel('none');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save AI settings');
    } finally { setBusy(false); }
  };

  const testAI = async () => {
    setBusy(true);
    try {
      const result = await api<{ response: string; latency_ms: number }>('/settings/test-llm', { method: 'POST' });
      setNotice(`AI operational · ${result.latency_ms}ms · ${result.response}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'AI test failed'); }
    finally { setBusy(false); }
  };

  const nodeName = (id: string) => NODES.find(n => n.id === id)?.name || id;

  return (
    <main style={{minHeight:'100vh',background:'#07090d',color:'#f5f7fb',fontFamily:'Inter,ui-sans-serif,system-ui,sans-serif'}}>
      <header style={{position:'sticky',top:0,zIndex:20,display:'flex',gap:16,alignItems:'center',justifyContent:'space-between',padding:'14px 20px',borderBottom:'1px solid #222834',background:'rgba(7,9,13,.94)',backdropFilter:'blur(14px)'}}>
        <div><div style={{fontWeight:900,fontSize:20,letterSpacing:'-.04em'}}>VELA</div><div style={{fontSize:11,color:'#8c96a8'}}>UNIVERSAL CONNECTION MESH</div></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{fontSize:12,color:'#8c96a8'}}>{links.length} links</span><button onClick={() => {setLinks([]);setSelected([])}} style={ghost}>Clear mesh</button></div>
      </header>

      <div style={{maxWidth:1320,margin:'0 auto',padding:'22px'}}>
        <section style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:16,marginBottom:18}}>
          <div style={{padding:'22px',border:'1px solid #222834',borderRadius:18,background:'#0d1118'}}>
            <div style={{fontSize:12,color:'#70d7ff',fontWeight:800,letterSpacing:'.08em'}}>THE USER EXPERIENCE</div>
            <h1 style={{fontSize:'clamp(28px,5vw,56px)',lineHeight:1,letterSpacing:'-.06em',margin:'8px 0 10px'}}>Click things together.</h1>
            <p style={{maxWidth:760,color:'#9aa5b8',lineHeight:1.6,margin:0}}>Connect the services you use. Click one, click another, choose how much authority the connection gets. Vela handles the workflow machinery underneath.</p>
            <textarea value={goal} onChange={e=>setGoal(e.target.value)} placeholder="Optional goal: e.g. Grow my YouTube channel, run my ecommerce business, build and deploy apps..." style={{width:'100%',boxSizing:'border-box',marginTop:16,minHeight:76,resize:'vertical',background:'#080b10',border:'1px solid #2a3240',borderRadius:12,padding:13,color:'#fff',fontSize:15}} />
          </div>
        </section>

        {notice && <div style={{marginBottom:16,padding:'11px 13px',border:'1px solid #304055',borderRadius:12,background:'#0d1721',color:'#b9e8ff',fontSize:13}}>{notice}</div>}

        <section style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:16}}>
          <div style={{border:'1px solid #222834',borderRadius:18,background:'#0b0e14',padding:16}}>
            <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search anything..." style={{flex:'1 1 220px',minHeight:44,background:'#080b10',border:'1px solid #29313e',borderRadius:10,padding:'0 12px',color:'#fff',fontSize:16}} />
              <select value={group} onChange={e=>setGroup(e.target.value)} style={{minHeight:44,background:'#080b10',border:'1px solid #29313e',borderRadius:10,padding:'0 12px',color:'#fff',fontSize:15}}>{groups.map(g=><option key={g}>{g}</option>)}</select>
            </div>

            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(142px,1fr))',gap:10}}>
              {visibleNodes.map(node => {
                const connected = isConnected(node);
                const chosen = selected.includes(node.id);
                return <button key={node.id} onClick={()=>clickNode(node)} style={{textAlign:'left',minHeight:88,padding:12,borderRadius:14,border:`1px solid ${chosen?'#69d5ff':connected?'#2f5b4a':'#29313e'}`,background:chosen?'#102330':connected?'#0d1915':'#0c1016',color:'#fff',cursor:'pointer'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}><span style={{display:'grid',placeItems:'center',width:34,height:34,borderRadius:9,background:'#161c26',fontWeight:900,fontSize:12}}>{node.icon}</span><span style={{fontSize:10,color:connected?'#77ddb1':'#7f8998'}}>{connected?'READY':node.mode==='planned'?'NEXT':'CONNECT'}</span></div>
                  <div style={{fontWeight:750,marginTop:8}}>{node.name}</div><div style={{fontSize:11,color:'#7f8998',marginTop:2}}>{node.group}</div>
                </button>;
              })}
            </div>
          </div>

          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))',gap:16}}>
            <div style={{border:'1px solid #222834',borderRadius:18,background:'#0b0e14',padding:16}}>
              <div style={eyebrow}>CREATE CONNECTION</div>
              <div style={{fontSize:20,fontWeight:800,margin:'6px 0 12px'}}>{selected.length === 2 ? `${nodeName(selected[0])} → ${nodeName(selected[1])}` : selected.length === 1 ? `${nodeName(selected[0])} → click another thing` : 'Click two ready things'}</div>
              <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>{CAPABILITIES.map(cap => <button key={cap} onClick={()=>setCapabilities(prev=>prev.includes(cap)?prev.filter(x=>x!==cap):[...prev,cap])} style={{...chip,background:capabilities.includes(cap)?'#153346':'#11161f',borderColor:capabilities.includes(cap)?'#3f9fc9':'#29313e'}}>{cap}</button>)}</div>
              <button disabled={selected.length!==2 || capabilities.length===0} onClick={addLink} style={{...primary,width:'100%',marginTop:14,opacity:selected.length===2&&capabilities.length?1:.45}}>Connect them</button>
            </div>

            <div style={{border:'1px solid #222834',borderRadius:18,background:'#0b0e14',padding:16}}>
              <div style={eyebrow}>AUTHORITY MODEL</div>
              <p style={{fontSize:13,color:'#919cad',lineHeight:1.55}}>Connections start conservative. Observe and Analyze are safe defaults. Create, Modify and Execute are explicit authority.</p>
              <div style={{display:'grid',gap:6,fontSize:12,color:'#aab3c2'}}>{CAPABILITIES.map((c,i)=><div key={c} style={{display:'flex',justifyContent:'space-between',borderBottom:'1px solid #1b2029',padding:'7px 0'}}><span>{c}</span><span style={{color:i<2?'#72dfb0':'#727e90'}}>{i<2?'LOW RISK':'USER GRANT'}</span></div>)}</div>
            </div>
          </div>

          <div style={{border:'1px solid #222834',borderRadius:18,background:'#0b0e14',padding:16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,marginBottom:10}}><div><div style={eyebrow}>ACTIVE MESH</div><div style={{fontWeight:800,fontSize:20,marginTop:4}}>What is connected to what</div></div><span style={{fontSize:12,color:'#7f8998'}}>{links.length} total</span></div>
            {!links.length ? <div style={{padding:'28px 0',textAlign:'center',color:'#707b8c'}}>Nothing connected yet. Click two ready services above.</div> : <div style={{display:'grid',gap:8}}>{links.map(link=><div key={link.id} style={{display:'grid',gridTemplateColumns:'1fr auto',gap:10,alignItems:'center',padding:12,border:'1px solid #252d39',borderRadius:12,background:'#0d1118'}}><div><div style={{fontWeight:800}}>{nodeName(link.from)} <span style={{color:'#58c6f3'}}>→</span> {nodeName(link.to)}</div><div style={{display:'flex',gap:5,flexWrap:'wrap',marginTop:7}}>{link.capabilities.map(c=><span key={c} style={{fontSize:10,padding:'3px 7px',border:'1px solid #2b3644',borderRadius:999,color:'#9da8b9'}}>{c}</span>)}</div></div><button onClick={()=>setLinks(prev=>prev.filter(x=>x.id!==link.id))} style={ghost}>Remove</button></div>)}</div>}
          </div>
        </section>
      </div>

      {panel !== 'none' && <div style={{position:'fixed',inset:0,zIndex:50,background:'rgba(0,0,0,.72)',display:'grid',placeItems:'center',padding:16}} onMouseDown={e=>{if(e.target===e.currentTarget)setPanel('none')}}>
        <div style={{width:'min(620px,100%)',maxHeight:'86vh',overflowY:'auto',background:'#0c1016',border:'1px solid #303947',borderRadius:18,padding:20}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}}><div><div style={eyebrow}>{panelNode?.group}</div><h2 style={{margin:'4px 0 0',fontSize:24}}>{panelNode?.name}</h2></div><button onClick={()=>setPanel('none')} style={ghost}>Close</button></div>

          {panel === 'planned' && <div style={{marginTop:18}}><p style={{color:'#a2adbd',lineHeight:1.6}}>This connector is represented in the mesh now, but its production OAuth/API adapter is not wired into this Worker yet. It will use the same click-to-connect model when its adapter lands.</p><div style={{padding:12,border:'1px solid #27313e',borderRadius:12,color:'#7edcb2',fontSize:13}}>Connector slot reserved: {panelNode?.name}</div></div>}

          {panel === 'native' && <div style={{marginTop:18}}><label style={label}>HTTP(S) endpoint or site</label><input value={apiUrl} onChange={e=>setApiUrl(e.target.value)} placeholder="https://example.com/api or https://example.com" style={input}/><p style={{fontSize:12,color:'#7f8998'}}>Native crawler/API nodes are available in the mesh. Production execution will enforce HTTPS, public-network targets, rate limits and bounded crawl depth.</p><button onClick={()=>{setNotice(`${panelNode?.name} node ready for ${apiUrl || 'configuration'}.`);setPanel('none')}} style={{...primary,width:'100%'}}>Add node</button></div>}

          {panel === 'ai' && <div style={{marginTop:18,display:'grid',gap:12}}>
            <label style={label}>Active provider</label><select value={settings.active_provider} onChange={e=>setSettings({...settings,active_provider:e.target.value})} style={input}><option value="auto">Auto</option><option value="cloudflare">Workers AI</option><option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="custom">Custom OpenAI-compatible</option></select>
            <label style={label}>OpenRouter API key</label><input type="password" value={settings.openrouter_key||''} onChange={e=>setSettings({...settings,openrouter_key:e.target.value})} style={input}/><input value={settings.openrouter_model} onChange={e=>setSettings({...settings,openrouter_model:e.target.value})} placeholder="OpenRouter model" style={input}/>
            <label style={label}>OpenAI API key</label><input type="password" value={settings.openai_key||''} onChange={e=>setSettings({...settings,openai_key:e.target.value})} style={input}/><input value={settings.openai_model} onChange={e=>setSettings({...settings,openai_model:e.target.value})} placeholder="OpenAI model" style={input}/>
            <label style={label}>Anthropic API key</label><input type="password" value={settings.anthropic_key||''} onChange={e=>setSettings({...settings,anthropic_key:e.target.value})} style={input}/><input value={settings.anthropic_model} onChange={e=>setSettings({...settings,anthropic_model:e.target.value})} placeholder="Anthropic model" style={input}/>
            <label style={label}>Gemini API key</label><input type="password" value={settings.gemini_key||''} onChange={e=>setSettings({...settings,gemini_key:e.target.value})} style={input}/><input value={settings.gemini_model} onChange={e=>setSettings({...settings,gemini_model:e.target.value})} placeholder="Gemini model" style={input}/>
            <label style={label}>Workers AI model</label><input value={settings.cf_ai_model} onChange={e=>setSettings({...settings,cf_ai_model:e.target.value})} style={input}/>
            <label style={label}>Custom AI endpoint</label><input value={settings.custom_endpoint||''} onChange={e=>setSettings({...settings,custom_endpoint:e.target.value})} placeholder="https://.../v1/chat/completions" style={input}/><input type="password" value={settings.custom_key||''} onChange={e=>setSettings({...settings,custom_key:e.target.value})} placeholder="API key" style={input}/><input value={settings.custom_model||''} onChange={e=>setSettings({...settings,custom_model:e.target.value})} placeholder="Model" style={input}/>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button disabled={busy} onClick={saveAI} style={{...primary,flex:1}}>Save AI connections</button><button disabled={busy} onClick={testAI} style={{...ghost,flex:1}}>Test active AI</button></div>
          </div>}
        </div>
      </div>}
    </main>
  );
}

const primary: React.CSSProperties = {minHeight:44,border:0,borderRadius:10,padding:'0 15px',fontWeight:800,cursor:'pointer',background:'#67d2ff',color:'#071019'};
const ghost: React.CSSProperties = {minHeight:40,border:'1px solid #2a3340',borderRadius:9,padding:'0 12px',fontWeight:700,cursor:'pointer',background:'#11161e',color:'#c7cfda'};
const chip: React.CSSProperties = {minHeight:36,border:'1px solid #29313e',borderRadius:999,padding:'0 11px',fontWeight:700,cursor:'pointer',color:'#cbd5e3'};
const eyebrow: React.CSSProperties = {fontSize:10,fontWeight:900,letterSpacing:'.1em',color:'#74d8ff'};
const label: React.CSSProperties = {fontSize:12,fontWeight:800,color:'#a8b2c0'};
const input: React.CSSProperties = {width:'100%',boxSizing:'border-box',minHeight:44,background:'#080b10',border:'1px solid #29313e',borderRadius:10,padding:'0 12px',color:'#fff',fontSize:16};
