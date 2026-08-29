export const AGENT_RUNNER_V2 = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const projectId = process.env.VELA_PROJECT_ID;
const buildId = process.env.VELA_BUILD_ID;
const token = process.env.VELA_BUILD_TOKEN;
const controlPlane = String(process.env.VELA_CONTROL_PLANE || '').replace(/\/$/, '');
const MAX_ATTEMPTS = 5;

if (!projectId || !buildId || !token || !controlPlane) throw new Error('Missing Vela build environment');

function read(file, fallback = '') {
  try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { return fallback; }
}

function readJson(file, fallback) {
  try { return JSON.parse(read(file)); } catch { return fallback; }
}

function resolveSafe(file) {
  const relative = String(file || '').replace(/^\/+/, '');
  if (!relative || relative.includes('..')) throw new Error('Invalid repository path: ' + file);
  const full = path.resolve(ROOT, relative);
  if (!full.startsWith(ROOT + path.sep)) throw new Error('Refusing path outside repository: ' + file);
  return { relative, full };
}

function write(file, content) {
  const { full } = resolveSafe(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function remove(file) {
  const { full } = resolveSafe(file);
  fs.rmSync(full, { recursive: true, force: true });
}

function shell(command, timeoutMs = 180000) {
  try {
    const out = cp.execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env: process.env });
    return { ok: true, command, output: out.slice(-20000) };
  } catch (error) {
    const stdout = String(error.stdout || '');
    const stderr = String(error.stderr || error.message || '');
    return { ok: false, command, output: (stdout + '\n' + stderr).slice(-28000) };
  }
}

async function post(endpoint, body) {
  const url = controlPlane + endpoint;
  const requestBody = JSON.stringify(Object.assign({ project_id: projectId, build_id: buildId }, body || {}));
  const attempts = endpoint === '/internal/agent/event' ? 2 : 4;
  const timeoutMs = endpoint === '/internal/agent/llm' ? 90000 : 30000;
  let last = 'unknown transport failure';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = {};
      try { payload = JSON.parse(text); } catch { payload = { error: text }; }
      if (response.ok) return payload;
      last = endpoint + ' failed (' + response.status + '): ' + String(payload.error || payload.reason || text).slice(0, 1600);
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 429) break;
    } catch (error) {
      const cause = error && error.cause ? ' | cause=' + String(error.cause) : '';
      last = (error instanceof Error ? error.message : String(error)) + cause;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) {
      const wait = Math.min(1500 * (2 ** (attempt - 1)), 8000);
      console.warn('[VELA_TRANSPORT_RETRY]', endpoint, 'attempt', attempt, last.slice(0, 700));
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw new Error(last);
}

async function event(kind, detail, stage, extra) {
  console.log('[VELA]', stage || 'engineering', kind, detail);
  try { await post('/internal/agent/event', Object.assign({ kind, detail, stage: stage || 'engineering' }, extra || {})); }
  catch (error) { console.warn('event callback warning:', error.message); }
}

async function llm(role, system, user) {
  const payload = await post('/internal/agent/llm', { role, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  if (!payload.content) throw new Error('LLM returned no content for role ' + role);
  console.log('[MODEL]', role, payload.model || 'unknown');
  return String(payload.content);
}

function balancedJson(text) {
  const source = String(text || '').trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\x60\x60\x60\s*$/, '').trim();
  try { return JSON.parse(source); } catch {}
  for (let start = 0; start < source.length; start++) {
    const opener = source[start];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { break; }
        }
      }
    }
  }
  throw new Error('Model did not return parseable JSON');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function opsProtocol(nonce) {
  return [
    'Return ONLY VELA_OPS_V2 frames. Do NOT JSON-encode source files.',
    'Every file write must use:',
    '<<<VELA_FILE_' + nonce + ':relative/path>>>',
    'RAW COMPLETE FILE CONTENT EXACTLY AS IT SHOULD EXIST',
    '<<<VELA_END_FILE_' + nonce + '>>>',
    'To delete a file use one line: <<<VELA_DELETE_' + nonce + ':relative/path>>>',
    'For each noninteractive validation command use:',
    '<<<VELA_COMMAND_' + nonce + '>>>',
    'command text',
    '<<<VELA_END_COMMAND_' + nonce + '>>>',
    'Optionally include a short summary between <<<VELA_SUMMARY_' + nonce + '>>> and <<<VELA_END_SUMMARY_' + nonce + '>>>.',
    'Do not wrap the response in Markdown fences. Do not emit JSON. The raw file blocks eliminate JSON escaping failures.',
  ].join('\n');
}

function parseOps(text, nonce) {
  const source = String(text || '');
  const n = escapeRegex(nonce);
  const files = [];
  const deletes = [];
  const commands = [];

  const fileRe = new RegExp('<<<VELA_FILE_' + n + ':([^>\\r\\n]+)>>>(?:\\r?\\n)?([\\s\\S]*?)(?:\\r?\\n)?<<<VELA_END_FILE_' + n + '>>>', 'g');
  for (const match of source.matchAll(fileRe)) files.push({ path: match[1].trim(), content: match[2] });

  const deleteRe = new RegExp('<<<VELA_DELETE_' + n + ':([^>\\r\\n]+)>>>', 'g');
  for (const match of source.matchAll(deleteRe)) deletes.push(match[1].trim());

  const commandRe = new RegExp('<<<VELA_COMMAND_' + n + '>>>(?:\\r?\\n)?([\\s\\S]*?)(?:\\r?\\n)?<<<VELA_END_COMMAND_' + n + '>>>', 'g');
  for (const match of source.matchAll(commandRe)) {
    const command = match[1].trim();
    if (command) commands.push(command);
  }

  const summaryRe = new RegExp('<<<VELA_SUMMARY_' + n + '>>>(?:\\r?\\n)?([\\s\\S]*?)(?:\\r?\\n)?<<<VELA_END_SUMMARY_' + n + '>>>');
  const summary = source.match(summaryRe)?.[1]?.trim() || '';

  if (!files.length && !deletes.length) throw new Error('Model returned no VELA file operations');
  return { files, deletes, commands, summary };
}

function applyOps(ops) {
  for (const file of ops.files) write(file.path, file.content);
  for (const file of ops.deletes) remove(file);
}

function trackedFiles() {
  const result = shell('git ls-files');
  return result.ok ? result.output.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : [];
}

function repoSummary() {
  const files = trackedFiles().filter(f => !f.startsWith('.vela/')).slice(0, 260);
  const packageJson = readJson('package.json', null);
  const wrangler = read('wrangler.jsonc') || read('wrangler.json');
  return JSON.stringify({ files, package_json: packageJson, wrangler: wrangler.slice(0, 12000) }, null, 2);
}

function relevantSource(maxChars = 90000) {
  const preferred = trackedFiles().filter(f => /^(src|app|lib|test|tests|migrations|scripts)\//.test(f) || /^(package\.json|wrangler\.jsonc?|README\.md|schema\.sql)$/.test(f));
  let out = '';
  for (const file of preferred) {
    if (out.length >= maxChars) break;
    const text = read(file);
    if (!text || text.length > 40000) continue;
    out += '\n\n===== ' + file + ' =====\n' + text;
  }
  return out.slice(0, maxChars);
}

function allowedCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (/\b(rm\s+-rf\s+\/|mkfs|shutdown|reboot|curl.+\|\s*(?:sh|bash))\b/i.test(cmd)) return false;
  if (/^git\s+(add|commit|push|pull|checkout|switch|reset|clean|rm|merge|rebase|tag)\b/i.test(cmd)) return false;
  if (/^wrangler\s+deploy\b/i.test(cmd) && !/--dry-run\b/i.test(cmd)) return false;
  if (/^npx\b.*\bwrangler\b.*\bdeploy\b/i.test(cmd) && !/--dry-run\b/i.test(cmd)) return false;
  if (/^npm\s+run\s+(start|dev|serve)\b/i.test(cmd)) return false;
  return /^(npm|npx|node|python3?|pytest|bash|sh|test|sqlite3|git)\b/.test(cmd);
}

function runCommands(commands) {
  const results = [];
  for (const command of commands || []) {
    const cmd = String(command || '').trim();
    if (!allowedCommand(cmd)) {
      results.push({ ok: false, command: cmd, output: 'Command rejected by procedural validation policy' });
      break;
    }
    const result = shell(cmd, 300000);
    results.push(result);
    console.log(result.ok ? '[PASS]' : '[FAIL]', cmd);
    if (!result.ok) break;
  }
  return results;
}

function standardChecks() {
  const commands = [];
  const pkg = readJson('package.json', null);
  if (pkg) {
    if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) commands.push('npm ci');
    else commands.push('npm install --ignore-scripts');
    const scripts = pkg.scripts || {};
    for (const name of ['lint', 'typecheck', 'test', 'build']) if (scripts[name]) commands.push('npm run ' + name);
  }
  if (fs.existsSync(path.join(ROOT, 'src/worker.mjs'))) commands.push('node --check src/worker.mjs');
  if (fs.existsSync(path.join(ROOT, 'wrangler.jsonc')) || fs.existsSync(path.join(ROOT, 'wrangler.json'))) commands.push('npx --yes wrangler@4.126.0 deploy --dry-run --outdir .vela/dry-run');
  return commands;
}

function commitCheckpoint(message) {
  const status = shell('git status --porcelain');
  if (!status.ok || !status.output.trim()) return;
  const result = shell('git add -A && git commit -m ' + JSON.stringify(message), 120000);
  if (!result.ok) throw new Error('Checkpoint commit failed: ' + result.output);
}

const requirements = read('.vela/requirements.md');
const intent = readJson('.vela/intent.json', {});
const architecture = readJson('.vela/architecture.json', {});
const plan = readJson('.vela/task-plan.json', {});
const models = readJson('.vela/models.json', {});

if (!requirements) throw new Error('.vela/requirements.md is missing');
if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('Task plan contains no engineering tasks');

await event('agent_started', 'Procedural engineering workspace started with ' + plan.tasks.length + ' product tasks using raw-file operation protocol V2', 'agent_running', { models });

const completed = new Set();
const pending = new Map(plan.tasks.map(task => [task.id, task]));

while (pending.size) {
  const ready = [...pending.values()].filter(task => (task.depends_on || []).every(dep => completed.has(dep)));
  if (!ready.length) throw new Error('Task dependency graph is cyclic or references missing tasks');

  for (const task of ready) {
    pending.delete(task.id);
    await event('task_started', task.id + ': ' + task.title, 'engineering', { task_id: task.id });

    let success = false;
    let failureContext = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !success; attempt++) {
      const nonce = crypto.randomBytes(8).toString('hex');
      const system = [
        'You are the primary coding engineer inside a real GitHub Actions checkout with a shell and iterative failure feedback.',
        'Implement ONLY the assigned product task while preserving correct existing implementation.',
        'Never invent current external data. Never replace requested behavior with a generic demo, placeholder, or fake success.',
        'For Cloudflare Workers, D1 is env.DB. Never import fake cloudflare/kv, cloudflare/r2, d1, Next.js server types, AWS Lambda, pg, or other incompatible runtimes.',
        'Create complete production source files and real tests appropriate to the task.',
        opsProtocol(nonce),
      ].join('\n');

      const user = [
        'AUTHORITATIVE REQUIREMENTS:\n' + requirements.slice(0, 65000),
        'CONFIRMED INTENT:\n' + JSON.stringify(intent, null, 2),
        'CONFIRMED ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
        'ASSIGNED TASK:\n' + JSON.stringify(task, null, 2),
        'REPOSITORY SUMMARY:\n' + repoSummary(),
        'RELEVANT CURRENT SOURCE:\n' + relevantSource(75000),
        failureContext ? 'PREVIOUS ATTEMPT FAILURE:\n' + failureContext.slice(-28000) : '',
      ].filter(Boolean).join('\n\n');

      let ops;
      try {
        const response = await llm(attempt === 1 ? 'coder' : 'debugger', system, user);
        ops = parseOps(response, nonce);
        applyOps(ops);
        shell('git add -N .');
      } catch (error) {
        failureContext = 'Model/apply failure: ' + error.message;
        await event('task_attempt_failed', task.id + ' attempt ' + attempt + ': ' + error.message, 'engineering', { task_id: task.id, attempt });
        continue;
      }

      const commands = Array.from(new Set([...(ops.commands || []), ...((task.validation_commands || []).filter(allowedCommand))]));
      const commandResults = runCommands(commands);
      const failed = commandResults.find(x => !x.ok);
      if (failed) {
        failureContext = 'Command failed: ' + failed.command + '\n' + failed.output;
        await event('task_attempt_failed', task.id + ' attempt ' + attempt + ' command failed: ' + failed.command, 'engineering', { task_id: task.id, attempt });
        continue;
      }

      const reviewSystem = [
        'You are the independent senior reviewer for a procedural coding agent.',
        'Judge only whether the assigned task satisfies the confirmed requirements and architecture in the CURRENT repository.',
        'Reject placeholders, fake current data, unimplemented handlers, incompatible runtime imports, tests that do not test behavior, and claims unsupported by code.',
        'Return ONLY one valid JSON object: {"pass":true|false,"issues":["..."],"required_repairs":["..."]}.',
      ].join('\n');
      const reviewUser = [
        'TASK:\n' + JSON.stringify(task, null, 2),
        'REQUIREMENTS:\n' + requirements.slice(0, 45000),
        'ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
        'GIT DIFF:\n' + shell('git diff -- . ":(exclude).vela"').output.slice(-70000),
        'RELEVANT SOURCE:\n' + relevantSource(55000),
      ].join('\n\n');

      let review;
      try { review = balancedJson(await llm('reviewer', reviewSystem, reviewUser)); }
      catch (error) { review = { pass: false, issues: ['Reviewer response failure: ' + error.message], required_repairs: [] }; }

      if (!review.pass) {
        failureContext = 'Independent review rejected task:\n' + JSON.stringify(review, null, 2);
        await event('task_review_rejected', task.id + ' attempt ' + attempt + ' rejected by reviewer', 'engineering', { task_id: task.id, attempt, issues: review.issues || [] });
        continue;
      }

      success = true;
    }

    if (!success) throw new Error('Task failed after repair loop: ' + task.id + '\n' + failureContext.slice(-14000));
    commitCheckpoint('vela: complete ' + task.id + ' ' + task.title);
    completed.add(task.id);
    await event('task_completed', task.id + ': ' + task.title + ' passed implementation, validation, and independent review', 'engineering', { task_id: task.id });
  }
}

await event('integration_started', 'Running whole-repository integration checks', 'integration');
let integrationResults = runCommands(standardChecks());
let integrationFailure = integrationResults.find(x => !x.ok);

for (let attempt = 1; integrationFailure && attempt <= MAX_ATTEMPTS; attempt++) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const repairSystem = [
    'You are the integration/debugging engineer for a production repository. Fix the actual repository using the supplied command failure.',
    'Preserve the authoritative requirements and architecture. Never delete tests or substitute a generic scaffold merely to make checks pass.',
    opsProtocol(nonce),
  ].join('\n');
  const repairUser = [
    'REQUIREMENTS:\n' + requirements.slice(0, 60000),
    'ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
    'FAILED COMMAND:\n' + integrationFailure.command,
    'FAILURE OUTPUT:\n' + integrationFailure.output,
    'REPOSITORY:\n' + repoSummary(),
    'SOURCE:\n' + relevantSource(85000),
  ].join('\n\n');

  try {
    const repair = parseOps(await llm('debugger', repairSystem, repairUser), nonce);
    applyOps(repair);
    shell('git add -N .');
    const requested = runCommands(repair.commands || []);
    const requestedFailure = requested.find(x => !x.ok);
    if (requestedFailure) { integrationFailure = requestedFailure; continue; }
  } catch (error) {
    integrationFailure = { ok: false, command: 'integration repair model/apply', output: error.message };
    continue;
  }

  integrationResults = runCommands(standardChecks());
  integrationFailure = integrationResults.find(x => !x.ok);
}

if (integrationFailure) throw new Error('Integration failed after repair loop: ' + integrationFailure.command + '\n' + integrationFailure.output);
commitCheckpoint('vela: integration checks passing');

await event('validation_started', 'Running ab-project-validate against the requested workspace', 'validation');
const validation = shell('ab-project-validate /workspace/smartgambler complex', 300000);
if (!validation.ok) throw new Error('ab-project-validate failed:\n' + validation.output);

let validationReport = {};
try { validationReport = JSON.parse(read('.vela/validation-report.json', '{}')); } catch { validationReport = { raw: validation.output }; }

const finalReviewSystem = [
  'You are the final QA architect. Review the full repository against the authoritative requirements and confirmed architecture.',
  'Return ONLY one valid JSON object: {"pass":true|false,"implemented":["..."],"partial":["..."],"missing":["..."],"risks":["..."],"evidence":["file or command evidence"]}.',
  'A requirement is implemented only when repository evidence supports it. Never claim successful live deployment; deployment has not happened yet.',
].join('\n');
const finalReviewUser = [
  'REQUIREMENTS:\n' + requirements.slice(0, 65000),
  'ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
  'TASK PLAN:\n' + JSON.stringify(plan, null, 2),
  'VALIDATOR:\n' + JSON.stringify(validationReport, null, 2),
  'REPOSITORY:\n' + repoSummary(),
  'SOURCE:\n' + relevantSource(90000),
].join('\n\n');
const finalReview = balancedJson(await llm('reviewer', finalReviewSystem, finalReviewUser));
if (!finalReview.pass) throw new Error('Final independent review rejected build: ' + JSON.stringify(finalReview).slice(0, 16000));

write('.vela/final-review.json', JSON.stringify(finalReview, null, 2));
commitCheckpoint('vela: validated engineering build');
const shaResult = shell('git rev-parse HEAD');
const commitSha = shaResult.ok ? shaResult.output.trim() : '';

await event('engineering_complete', 'All procedural product tasks, integration checks, validator, and independent review passed', 'awaiting_deploy_approval', { commit_sha: commitSha });
await post('/internal/agent/complete', { commit_sha: commitSha, validation: validationReport, review: finalReview });
console.log('VELA_AGENT_BUILD_COMPLETE', commitSha);
`;
