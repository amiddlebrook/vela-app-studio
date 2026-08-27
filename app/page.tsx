'use client';

import React, { useEffect, useState } from 'react';

type Project = {
  id: string;
  name: string;
  prompt: string;
  status: string;
  github_repository: string | null;
  worker_name: string | null;
  scaffolding_json: string | null;
  plan_json: string | null;
  created_at: string;
  updated_at: string;
  features: Array<{ feature: string; enabled: boolean }>;
  latest_event: { kind: string; detail: string; stage: string; created_at: string } | null;
};

type AuditLog = {
  id: string;
  project_id: string | null;
  action: string;
  details: string | null;
  ip_address: string | null;
  created_at: string;
};

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

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [view, setView] = useState<'home' | 'apps' | 'activity' | 'audit' | 'toolbox'>('home');
  const [prompt, setPrompt] = useState('');
  const [appName, setAppName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [connections, setConnections] = useState<Set<string>>(new Set());
  const [usageCost, setUsageCost] = useState('$0.00');
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [selectedCode, setSelectedCode] = useState<{ frontend?: string; backend?: string; database?: string } | null>(null);
  const [codeModalOpen, setCodeModalOpen] = useState(false);

  // Settings State
  const [settings, setSettings] = useState<WorkspaceSettings>({
    active_provider: 'auto',
    openrouter_model: 'anthropic/claude-3.5-sonnet',
    openai_model: 'gpt-4o',
    gemini_model: 'gemini-2.0-flash',
    anthropic_model: 'claude-3-5-sonnet-20241022',
    cf_ai_model: '@cf/meta/llama-3.3-70b-instruct',
  });
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testingAI, setTestingAI] = useState(false);

  const api = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const res = await fetch(path, options);
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data?.reason || data?.error || 'Request failed'));
    return data as unknown as T;
  };

  const syncWorkspace = async () => {
    try {
      await api('/session', { method: 'POST' });
      const [connsRes, projsRes, usageRes, auditRes] = await Promise.all([
        api<{ connections: Array<{ provider: string }> }>('/connections').catch(() => ({ connections: [] })),
        api<{ projects: Project[] }>('/projects').catch(() => ({ projects: [] })),
        api<{ estimated_cost_cents: number }>('/usage').catch(() => ({ estimated_cost_cents: 0 })),
        api<{ audit_logs: AuditLog[] }>('/audit-logs').catch(() => ({ audit_logs: [] })),
      ]);

      setConnections(new Set<string>((connsRes.connections || []).map((c) => c.provider)));
      const projs: Project[] = projsRes.projects || [];
      setProjects(projs);
      setActiveProject((prev) => {
        if (!prev && projs.length > 0) return projs[0];
        if (prev) return projs.find((p) => p.id === prev.id) || prev;
        return null;
      });
      setUsageCost(`$${((usageRes.estimated_cost_cents || 0) / 100).toFixed(2)}`);
      setAuditLogs(auditRes.audit_logs || []);
    } catch (e) {
      console.warn('Sync warning:', e);
    }
  };

  const loadSettings = async () => {
    try {
      const data = await api<WorkspaceSettings>('/settings');
      setSettings(data);
    } catch (e) {
      console.warn('Settings load warning:', e);
    }
  };

  const saveSettings = async () => {
    try {
      setNote('Saving AI Toolbox settings...');
      await api('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      setNote('AI Toolbox settings saved successfully.');
    } catch (err: unknown) {
      setNote(err instanceof Error ? err.message : 'Save settings failed');
    }
  };

  const handleTestAI = async () => {
    setTestingAI(true);
    setTestResult('Testing active AI model generation...');
    try {
      const res = await api<{ ok: boolean; latency_ms: number; response: string }>('/settings/test-llm', { method: 'POST' });
      setTestResult(`✓ Operational (${res.latency_ms}ms): "${res.response}"`);
    } catch (err: unknown) {
      setTestResult(`✕ Test failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTestingAI(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        await api('/session', { method: 'POST' });
        const [connsRes, projsRes, usageRes, auditRes] = await Promise.all([
          api<{ connections: Array<{ provider: string }> }>('/connections').catch(() => ({ connections: [] })),
          api<{ projects: Project[] }>('/projects').catch(() => ({ projects: [] })),
          api<{ estimated_cost_cents: number }>('/usage').catch(() => ({ estimated_cost_cents: 0 })),
          api<{ audit_logs: AuditLog[] }>('/audit-logs').catch(() => ({ audit_logs: [] })),
        ]);

        if (!mounted) return;
        setConnections(new Set<string>((connsRes.connections || []).map((c) => c.provider)));
        const projs: Project[] = projsRes.projects || [];
        setProjects(projs);
        setActiveProject((prev) => {
          if (!prev && projs.length > 0) return projs[0];
          if (prev) return projs.find((p) => p.id === prev.id) || prev;
          return null;
        });
        setUsageCost(`$${((usageRes.estimated_cost_cents || 0) / 100).toFixed(2)}`);
        setAuditLogs(auditRes.audit_logs || []);
      } catch (e) {
        console.warn('Sync warning:', e);
      }
    };

    void poll();
    const interval = setInterval(poll, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleCreate = async () => {
    if (!prompt.trim()) {
      setNote('Please enter a description for your application.');
      return;
    }
    setBusy(true);
    setNote('Generating enterprise architecture plan, D1 schema, and security matrix...');
    try {
      const name = appName.trim() || prompt.trim().split(' ').slice(0, 3).join(' ');
      const res = await api<{ project: Project }>('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt }),
      });
      setPrompt('');
      setAppName('');
      setNote(`Architecture planned for ${res.project.name}. Review and approve below.`);
      await syncWorkspace();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Creation failed';
      setNote(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (id: string) => {
    try {
      setNote('Approving plan — generating full-stack code, GitHub repository, and Cloudflare Worker...');
      await api(`/projects/${id}/approve`, { method: 'POST' });
      await syncWorkspace();
    } catch (err: unknown) {
      setNote(err instanceof Error ? err.message : 'Approval failed');
    }
  };

  const handleReject = async (id: string) => {
    const revised = window.prompt('Enter your revised requirements:');
    if (!revised) return;
    try {
      setNote('Regenerating architecture with revised prompt...');
      await api(`/projects/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: revised }),
      });
      await syncWorkspace();
    } catch (err: unknown) {
      setNote(err instanceof Error ? err.message : 'Rejection failed');
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete build "${name}"? This action cannot be undone.`)) return;
    try {
      setNote(`Deleting build "${name}"...`);
      await api(`/projects/${id}`, { method: 'DELETE' });
      setNote(`Build "${name}" deleted.`);
      await syncWorkspace();
    } catch (err: unknown) {
      setNote(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const viewCode = async (id: string) => {
    try {
      const data = await api<{ frontend?: string; backend?: string; database?: string }>(`/projects/${id}/code`);
      setSelectedCode(data);
      setCodeModalOpen(true);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to load code');
    }
  };

  return (
    <main className="shell">
      <div className="orb one" />
      <div className="orb two" />

      {/* Sidebar */}
      <aside>
        <button className="logo" onClick={() => setView('home')}>
          <b>v</b>vela
        </button>
        <div className="space">
          <i>A</i>
          <span>Avery&apos;s Space</span>
          <b>⌄</b>
        </div>
        <nav>
          <Nav label="⌂" text="Overview" active={view === 'home'} onClick={() => setView('home')} />
          <Nav label="◫" text={`Apps (${projects.length})`} active={view === 'apps'} onClick={() => setView('apps')} />
          <Nav label="⚡" text="AI Toolbox" active={view === 'toolbox'} onClick={() => { setView('toolbox'); loadSettings(); }} />
          <Nav label="⌁" text="Activity" active={view === 'activity'} onClick={() => setView('activity')} />
          <Nav label="🛡" text="Audit & Compliance" active={view === 'audit'} onClick={() => setView('audit')} />
        </nav>
        <div className="lower">
          <Nav label="◈" text={`Usage · ${usageCost}`} onClick={() => setView('apps')} />
          <div className="user">
            <i>A</i>
            <span>
              <b>Avery</b>
              <small>amiddlebrook (Owner)</small>
            </span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <section className="content">
        <header>
          <div>
            <small>
              {view === 'home'
                ? 'ENTERPRISE APP STUDIO'
                : view === 'apps'
                ? 'APPLICATION PORTFOLIO'
                : view === 'toolbox'
                ? 'AI PROVIDER TOOLBOX'
                : view === 'audit'
                ? 'SECURITY & AUDIT'
                : 'BUILD PIPELINE'}
            </small>
            <h1>
              {view === 'home'
                ? 'What will you architect today?'
                : view === 'apps'
                ? 'Enterprise Edge Portfolio'
                : view === 'toolbox'
                ? 'Manageable AI Providers & Models'
                : view === 'audit'
                ? 'Compliance & Audit Log'
                : 'Real-Time Edge Telemetry'}
            </h1>
          </div>
          <div className="header-actions">
            <button
              className="connected"
              onClick={() => (window.location.href = connections.has('github') ? '#' : '/auth/github/start')}
            >
              GitHub {connections.has('github') ? '✓' : '⟳ Connect'}
            </button>
            <button
              className="connected"
              onClick={() => (window.location.href = connections.has('cloudflare') ? '#' : '/auth/cloudflare/start')}
            >
              Cloudflare {connections.has('cloudflare') ? '✓' : '⟳ Connect'}
            </button>
          </div>
        </header>

        {/* Home / Studio View */}
        {view === 'home' && (
          <>
            <section className="hero">
              <div className="copy">
                <small>✦ &nbsp; AUTONOMOUS EDGE BUILDER</small>
                <h2>Describe it once. Vela builds it right.</h2>
                <p>
                  Zero clarification hurdles. Generates complete React frontends, Cloudflare Worker REST APIs,
                  D1 SQLite schemas, and deploys to production under your GitHub account.
                </p>
              </div>
              <div className="composer">
                <input
                  type="text"
                  placeholder="Optional App Name (e.g. Operations Control Portal)"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  style={{
                    width: '100%',
                    border: 0,
                    outline: 0,
                    fontSize: '13px',
                    fontWeight: 600,
                    marginBottom: '8px',
                    color: '#141e2b',
                  }}
                />
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleCreate();
                  }}
                  placeholder="Describe the application, target workflows, security posture, and data model..."
                />
                <div>
                  <span>
                    <kbd>⌘</kbd>
                    <kbd>↵</kbd> to architect
                  </span>
                  <button onClick={handleCreate} disabled={busy}>
                    {busy ? 'Planning...' : 'Generate Plan ↗'}
                  </button>
                </div>
              </div>
            </section>

            {note && <p className="note" style={{ margin: '16px 0', padding: '10px 14px', background: '#eef3ff', borderRadius: '10px' }}>✦ {note}</p>}

            <Section title="Active Applications" action={() => setView('apps')} />
            <div className="cards">
              {projects.slice(0, 6).map((p) => (
                <article className="card" key={p.id}>
                  <div className="cardtop">
                    <span className="mark blue">{p.name[0]}</span>
                    <button onClick={() => { setActiveProject(p); setView('apps'); }}>↗</button>
                  </div>
                  <div className="scene"><i/><i/><i/></div>
                  <div className="meta">
                    <div>
                      <h3>{p.name}</h3>
                      <p>{p.status.replace('_', ' ')}</p>
                    </div>
                    <span className={`badge ${p.status === 'live' ? 'live' : ''}`}>● {p.status}</span>
                  </div>
                  {p.status === 'awaiting_approval' && (
                    <div style={{ marginTop: '12px', display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => handleApprove(p.id)}
                        style={{ flex: 1, padding: '6px 0', fontSize: '11px', fontWeight: 700, background: '#4262ff', color: '#fff', border: 0, borderRadius: '8px' }}
                      >
                        Approve Plan
                      </button>
                      <button
                        onClick={() => handleReject(p.id)}
                        style={{ padding: '6px 10px', fontSize: '11px', background: '#e7e8eb', border: 0, borderRadius: '8px' }}
                      >
                        Revise
                      </button>
                    </div>
                  )}
                  <footer>
                    <span>{usageCost}<small>monthly</small></span>
                    <button
                      onClick={() => handleDelete(p.id, p.name)}
                      style={{ background: 'none', border: 0, color: '#f87171', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Delete 🗑
                    </button>
                  </footer>
                </article>
              ))}
              {projects.length === 0 && (
                <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', background: '#fff', borderRadius: '16px', border: '1px solid #e7e8eb', color: '#788091' }}>
                  No applications created yet. Use the composer above to start planning.
                </div>
              )}
            </div>
          </>
        )}

        {/* AI Toolbox View */}
        {view === 'toolbox' && (
          <section className="portfolio" style={{ maxWidth: '800px' }}>
            <div style={{ background: '#fff', border: '1px solid #e7e8eb', borderRadius: '16px', padding: '24px', width: '100%' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 800, marginBottom: '6px' }}>AI Provider &amp; Model Toolbox</h2>
              <p style={{ fontSize: '13px', color: '#788091', marginBottom: '20px' }}>
                Configure and test multi-provider LLMs. Easily toggle between Cloudflare Workers AI, OpenRouter, OpenAI, and custom endpoints.
              </p>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '4px' }}>PRIMARY AI ROUTING</label>
                <select
                  value={settings.active_provider}
                  onChange={(e) => setSettings({ ...settings, active_provider: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px' }}
                >
                  <option value="auto">Auto (Failover: Custom → OpenRouter → Cloudflare AI → OpenAI → Gemini)</option>
                  <option value="cloudflare">Cloudflare Workers AI (Edge Native)</option>
                  <option value="openrouter">OpenRouter (Multi-Model Hub)</option>
                  <option value="openai">OpenAI (GPT-4o / o3-mini)</option>
                  <option value="gemini">Google Gemini (Gemini 2.0 Flash / Pro)</option>
                  <option value="anthropic">Anthropic Claude (Claude 3.5 Sonnet)</option>
                  <option value="custom">Custom Endpoint (Ollama, vLLM, Groq)</option>
                </select>
              </div>

              <hr style={{ border: 0, borderTop: '1px solid #e5e7eb', margin: '20px 0' }} />

              <h3 style={{ fontSize: '14px', fontWeight: 800, marginBottom: '10px' }}>Cloudflare Workers AI</h3>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>MODEL ID</label>
                <input
                  type="text"
                  value={settings.cf_ai_model}
                  onChange={(e) => setSettings({ ...settings, cf_ai_model: e.target.value })}
                  placeholder="@cf/meta/llama-3.3-70b-instruct"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px' }}
                />
              </div>

              <hr style={{ border: 0, borderTop: '1px solid #e5e7eb', margin: '20px 0' }} />

              <h3 style={{ fontSize: '14px', fontWeight: 800, marginBottom: '10px' }}>OpenRouter Integration</h3>
              <div style={{ marginBottom: '10px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>API KEY</label>
                <input
                  type="password"
                  value={settings.openrouter_key || ''}
                  onChange={(e) => setSettings({ ...settings, openrouter_key: e.target.value })}
                  placeholder="sk-or-v1-..."
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px' }}
                />
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>MODEL</label>
                <input
                  type="text"
                  value={settings.openrouter_model}
                  onChange={(e) => setSettings({ ...settings, openrouter_model: e.target.value })}
                  placeholder="anthropic/claude-3.5-sonnet"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px' }}
                />
              </div>

              <hr style={{ border: 0, borderTop: '1px solid #e5e7eb', margin: '20px 0' }} />

              <h3 style={{ fontSize: '14px', fontWeight: 800, marginBottom: '10px' }}>Custom Endpoint (Ollama / Local / Groq)</h3>
              <div style={{ marginBottom: '10px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>BASE URL</label>
                <input
                  type="text"
                  value={settings.custom_endpoint || ''}
                  onChange={(e) => setSettings({ ...settings, custom_endpoint: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px' }}
                />
              </div>
              <div style={{ marginBottom: '10px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>API KEY (Optional)</label>
                <input
                  type="password"
                  value={settings.custom_key || ''}
                  onChange={(e) => setSettings({ ...settings, custom_key: e.target.value })}
                  placeholder="Bearer token"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px' }}
                />
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>MODEL NAME</label>
                <input
                  type="text"
                  value={settings.custom_model || ''}
                  onChange={(e) => setSettings({ ...settings, custom_model: e.target.value })}
                  placeholder="llama3.3"
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13px' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button
                  onClick={saveSettings}
                  style={{ padding: '10px 18px', background: '#4262ff', color: '#fff', border: 0, borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >
                  Save Settings
                </button>
                <button
                  onClick={handleTestAI}
                  disabled={testingAI}
                  style={{ padding: '10px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                >
                  {testingAI ? 'Testing...' : 'Test Active AI Provider ⚡'}
                </button>
              </div>

              {testResult && (
                <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '8px', fontSize: '12px', background: testResult.startsWith('✓') ? '#ecfdf5' : '#fef2f2', color: testResult.startsWith('✓') ? '#047857' : '#b91c1c' }}>
                  {testResult}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Portfolio / App Detail View */}
        {view === 'apps' && (
          <section className="portfolio">
            <div className="list">
              <Section title="Your Edge Applications" action={() => setView('home')} />
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={`row ${activeProject?.id === p.id ? 'chosen' : ''}`}
                  onClick={() => setActiveProject(p)}
                >
                  <span className="mark blue">{p.name[0]}</span>
                  <span>
                    <b>{p.name}</b>
                    <small>
                      <i className={p.status === 'live' ? 'live' : ''} /> {p.status.replace('_', ' ')}
                    </small>
                  </span>
                  <b>→</b>
                </button>
              ))}
            </div>

            {activeProject && (
              <div className="panel">
                <small>CONTROL PLANE</small>
                <div className="title">
                  <span className="mark big blue">{activeProject.name[0]}</span>
                  <div>
                    <h2>{activeProject.name}</h2>
                    <p>{activeProject.prompt.slice(0, 70)}...</p>
                  </div>
                </div>

                <div className="livebar">
                  <span>● STATUS: {activeProject.status.toUpperCase()}</span>
                  {activeProject.worker_name && activeProject.status === 'live' && (
                    <a
                      href={`https://${activeProject.worker_name}.workers.dev`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: '#6e9221', fontWeight: 800, textDecoration: 'none' }}
                    >
                      Open Live ↗
                    </a>
                  )}
                </div>

                {activeProject.status === 'awaiting_approval' && activeProject.plan_json && (
                  <div style={{ margin: '18px 0', padding: '14px', background: '#f6f8ff', borderRadius: '12px', border: '1px solid #dce4ff' }}>
                    <div style={{ fontSize: '11px', fontWeight: 800, color: '#4262ff', textTransform: 'uppercase' }}>
                      Architecture Blueprint Ready
                    </div>
                    <p style={{ fontSize: '12px', color: '#4d5561', marginTop: '4px' }}>
                      Security matrix, D1 schema, and Cloudflare Worker routes generated.
                    </p>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                      <button
                        onClick={() => handleApprove(activeProject.id)}
                        style={{ padding: '8px 14px', background: '#4262ff', color: '#fff', border: 0, borderRadius: '8px', fontSize: '11px', fontWeight: 700 }}
                      >
                        ✓ Approve &amp; Build
                      </button>
                      <button
                        onClick={() => handleReject(activeProject.id)}
                        style={{ padding: '8px 12px', background: '#e7e8eb', border: 0, borderRadius: '8px', fontSize: '11px', fontWeight: 600 }}
                      >
                        Revise Plan
                      </button>
                    </div>
                  </div>
                )}

                <div className="feature-head">
                  <span>ENTERPRISE MODULES</span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => viewCode(activeProject.id)}>Inspect Code ↗</button>
                    <button
                      onClick={() => handleDelete(activeProject.id, activeProject.name)}
                      style={{ color: '#dc2626', border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: '6px', padding: '2px 8px', fontSize: '11px' }}
                    >
                      Delete Build 🗑
                    </button>
                  </div>
                </div>

                {['RBAC Auth', 'D1 Database', 'Audit Logging', 'Rate Limiting', 'Edge CORS', 'Queues'].map((f) => (
                  <div className="feature" key={f}>
                    <span>{f}</span>
                    <i className="on"><b /></i>
                  </div>
                ))}

                {activeProject.github_repository && (
                  <div style={{ marginTop: '16px' }}>
                    <a
                      href={`https://github.com/${activeProject.github_repository}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: '12px', color: '#4262ff', fontWeight: 700, textDecoration: 'none' }}
                    >
                      View GitHub Repository ({activeProject.github_repository}) ↗
                    </a>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Activity Feed */}
        {view === 'activity' && (
          <section className="activity">
            <small>REAL-TIME TELEMETRY</small>
            <h2>Workspace Deployment Pipeline</h2>
            {projects.flatMap((p) => (p.latest_event ? [{ ...p.latest_event, projectName: p.name, id: p.id }] : [])).map((ev, i) => (
              <Event
                key={i}
                time={new Date(ev.created_at).toLocaleTimeString()}
                title={`${ev.projectName}: ${ev.kind}`}
                copy={ev.detail}
              />
            ))}
            {projects.length === 0 && <p style={{ color: '#788091' }}>No activity logged yet.</p>}
          </section>
        )}

        {/* Audit View */}
        {view === 'audit' && (
          <section className="activity" style={{ maxWidth: '900px' }}>
            <small>COMPLIANCE &amp; GOVERNANCE</small>
            <h2>Immutable Audit Log</h2>
            {auditLogs.map((log) => (
              <Event
                key={log.id}
                time={new Date(log.created_at).toLocaleString()}
                title={log.action}
                copy={`${log.details || ''} (IP: ${log.ip_address || 'edge'})`}
              />
            ))}
            {auditLogs.length === 0 && <p style={{ color: '#788091' }}>No audit events recorded yet.</p>}
          </section>
        )}
      </section>

      {/* Code Inspector Modal */}
      {codeModalOpen && selectedCode && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(6px)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 100,
            padding: '20px',
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: '16px',
              padding: '24px',
              maxWidth: '800px',
              width: '100%',
              maxHeight: '85vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>Generated Code Tree</h3>
              <button
                onClick={() => setCodeModalOpen(false)}
                style={{ background: 'none', border: 0, fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <h4 style={{ fontSize: '12px', color: '#4262ff', margin: '0 0 6px 0' }}>src/worker.mjs (Cloudflare Worker API)</h4>
              <pre style={{ background: '#0a0d14', color: '#8de8c5', padding: '12px', borderRadius: '8px', fontSize: '11px', overflowX: 'auto' }}>
                <code>{selectedCode.backend || 'No worker code'}</code>
              </pre>
            </div>
            <div>
              <h4 style={{ fontSize: '12px', color: '#4262ff', margin: '0 0 6px 0' }}>schema.sql (D1 SQLite Schema)</h4>
              <pre style={{ background: '#0a0d14', color: '#8de8c5', padding: '12px', borderRadius: '8px', fontSize: '11px', overflowX: 'auto' }}>
                <code>{selectedCode.database || 'No database schema'}</code>
              </pre>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Nav(p: { label: string; text: string; active?: boolean; onClick?: () => void }) {
  return (
    <button className={`nav ${p.active ? 'active' : ''}`} onClick={p.onClick}>
      <i>{p.label}</i>
      {p.text}
    </button>
  );
}

function Section(p: { title: string; action: () => void }) {
  return (
    <div className="section-title">
      <div>
        <small>IN MOTION</small>
        <h2>{p.title}</h2>
      </div>
      <button onClick={p.action}>View all →</button>
    </div>
  );
}

function Event(p: { time: string; title: string; copy: string }) {
  return (
    <article className="event">
      <i />
      <div>
        <small>{p.time}</small>
        <h3>{p.title}</h3>
        <p>{p.copy}</p>
      </div>
      <button>•••</button>
    </article>
  );
}
