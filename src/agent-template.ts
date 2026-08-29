export const AGENT_WORKFLOW = [
  'name: Vela Procedural Agent Build',
  '',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      project_id:',
  '        required: true',
  '        type: string',
  '      build_id:',
  '        required: true',
  '        type: string',
  '      build_token:',
  '        required: true',
  '        type: string',
  '      control_plane:',
  '        required: true',
  '        type: string',
  '',
  'permissions:',
  '  contents: write',
  '',
  'concurrency:',
  '  group: vela-agent-${{ inputs.project_id }}',
  '  cancel-in-progress: false',
  '',
  'jobs:',
  '  engineer:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 330',
  '    env:',
  '      VELA_PROJECT_ID: ${{ inputs.project_id }}',
  '      VELA_BUILD_ID: ${{ inputs.build_id }}',
  '      VELA_BUILD_TOKEN: ${{ inputs.build_token }}',
  '      VELA_CONTROL_PLANE: ${{ inputs.control_plane }}',
  '      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  '    steps:',
  '      - name: Mask scoped build token',
  '        run: echo "::add-mask::${VELA_BUILD_TOKEN}"',
  '      - uses: actions/checkout@v4',
  '        with:',
  '          fetch-depth: 0',
  '      - uses: actions/setup-node@v4',
  '        with:',
  '          node-version: 22',
  '      - name: Create requested workspace path',
  '        shell: bash',
  '        run: |',
  '          set -euo pipefail',
  '          sudo mkdir -p /workspace',
  '          sudo rm -rf /workspace/smartgambler',
  '          sudo ln -s "$GITHUB_WORKSPACE" /workspace/smartgambler',
  '          chmod +x .vela/ab-project-validate',
  '          sudo ln -sf "$GITHUB_WORKSPACE/.vela/ab-project-validate" /usr/local/bin/ab-project-validate',
  '      - name: Configure checkpoint commits',
  '        run: |',
  '          git config user.name "Vela Engineering Agent"',
  '          git config user.email "vela-agent@users.noreply.github.com"',
  '      - name: Run procedural engineering loop',
  '        run: node .vela/agent-runner.mjs',
  '      - name: Push validated checkpoints',
  '        if: success()',
  '        run: git push origin HEAD:main',
  '      - name: Report workflow failure',
  '        if: failure()',
  '        shell: bash',
  '        run: |',
  '          curl -fsS -X POST "${VELA_CONTROL_PLANE}/internal/agent/fail" \
  '            -H "authorization: Bearer ${VELA_BUILD_TOKEN}" \
  '            -H "content-type: application/json" \
  '            --data "{\\"project_id\\":\\"${VELA_PROJECT_ID}\\",\\"build_id\\":\\"${VELA_BUILD_ID}\\",\\"error\\":\\"GitHub Actions procedural engineering job failed; inspect build events and workflow logs.\\"}" || true',
  '',
].join('\n');

export const AGENT_RUNNER = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

const ROOT = process.cwd();
const projectId = process.env.VELA_PROJECT_ID;
const buildId = process.env.VELA_BUILD_ID;
const token = process.env.VELA_BUILD_TOKEN;
const controlPlane = String(process.env.VELA_CONTROL_PLANE || '').replace(/\/$/, '');
const MAX_ATTEMPTS = 4;

if (!projectId || !buildId || !token || !controlPlane) throw new Error('Missing Vela build environment');

function read(file, fallback = '') {
  try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { return fallback; }
}

function readJson(file, fallback) {
  try { return JSON.parse(read(file)); } catch { return fallback; }
}

function write(file, content) {
  const full = path.resolve(ROOT, file);
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) throw new Error('Refusing path outside repository: ' + file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function remove(file) {
  const full = path.resolve(ROOT, file);
  if (!full.startsWith(ROOT + path.sep)) throw new Error('Refusing path outside repository: ' + file);
  fs.rmSync(full, { recursive: true, force: true });
}

function shell(command, timeoutMs = 180000) {
  try {
    const out = cp.execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env: process.env });
    return { ok: true, command, output: out.slice(-18000) };
  } catch (error) {
    const stdout = String(error.stdout || '');
    const stderr = String(error.stderr || error.message || '');
    return { ok: false, command, output: (stdout + '\n' + stderr).slice(-24000) };
  }
}

async function post(endpoint, body) {
  const response = await fetch(controlPlane + endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ project_id: projectId, build_id: buildId }, body || {})),
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = { error: text }; }
  if (!response.ok) throw new Error(endpoint + ' failed (' + response.status + '): ' + String(payload.error || payload.reason || text).slice(0, 1000));
  return payload;
}

async function event(kind, detail, stage, extra) {
  console.log('[VELA]', stage || 'engineering', kind, detail);
  try { await post('/internal/agent/event', Object.assign({ kind, detail, stage: stage || 'engineering' }, extra || {})); } catch (error) { console.warn('event callback warning:', error.message); }
}

async function llm(role, system, user) {
  const payload = await post('/internal/agent/llm', { role, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  if (!payload.content) throw new Error('LLM returned no content for role ' + role);
  console.log('[MODEL]', role, payload.model || 'unknown');
  return payload.content;
}

function extractJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  throw new Error('Model response was not valid JSON');
}

function trackedFiles() {
  const result = shell('git ls-files');
  return result.ok ? result.output.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : [];
}

function repoSummary() {
  const files = trackedFiles().filter(f => !f.startsWith('.vela/')).slice(0, 220);
  const packageJson = readJson('package.json', null);
  const wrangler = read('wrangler.jsonc') || read('wrangler.json');
  return JSON.stringify({ files, package_json: packageJson, wrangler: wrangler.slice(0, 10000) }, null, 2);
}

function relevantSource(maxChars = 75000) {
  const preferred = trackedFiles().filter(f => /^(src|app|lib|test|tests|migrations|scripts)\//.test(f) || /^(package\.json|wrangler\.jsonc?|README\.md)$/.test(f));
  let out = '';
  for (const file of preferred) {
    if (out.length >= maxChars) break;
    const text = read(file);
    if (!text || text.length > 30000) continue;
    out += '\n\n===== ' + file + ' =====\n' + text;
  }
  return out.slice(0, maxChars);
}

function applyOperations(result) {
  const files = Array.isArray(result.files) ? result.files : [];
  for (const operation of files) {
    const file = String(operation.path || '').replace(/^\/+/, '');
    if (!file || file.includes('..')) throw new Error('Invalid file operation path: ' + file);
    if (operation.mode === 'delete') remove(file);
    else if (typeof operation.content === 'string') write(file, operation.content);
    else throw new Error('Write operation missing content for ' + file);
  }
}

function runCommands(commands) {
  const results = [];
  for (const command of commands || []) {
    const cmd = String(command || '').trim();
    if (!cmd) continue;
    if (/\b(rm\s+-rf\s+\/|mkfs|shutdown|reboot|:(){|curl.+\|\s*(sh|bash))\b/.test(cmd)) throw new Error('Unsafe command refused: ' + cmd);
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
  let result = shell('git add -A && git commit -m ' + JSON.stringify(message), 120000);
  if (!result.ok) throw new Error('Checkpoint commit failed: ' + result.output);
}

const requirements = read('.vela/requirements.md');
const intent = readJson('.vela/intent.json', {});
const architecture = readJson('.vela/architecture.json', {});
const plan = readJson('.vela/task-plan.json', {});
const models = readJson('.vela/models.json', {});

if (!requirements) throw new Error('.vela/requirements.md is missing');
if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('Task plan contains no engineering tasks');

await event('agent_started', 'Procedural engineering workspace started with ' + plan.tasks.length + ' tasks', 'agent_running', { models });

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
      const system = [
        'You are the primary coding engineer inside a real GitHub Actions workspace.',
        'You are NOT writing an answer for a human. You are issuing precise file operations for the runner.',
        'Work only on the assigned task and preserve correct existing implementation.',
        'Never invent current external data. Never substitute a generic demo or placeholder for requested behavior.',
        'For Cloudflare Workers, D1 is env.DB and deployed worker modules must not import fake cloudflare/kv, cloudflare/r2, d1, Next.js server types, AWS Lambda, pg, or other incompatible packages.',
        'Return ONLY JSON with this exact shape:',
        '{"summary":"...","files":[{"path":"relative/path","mode":"write","content":"complete file content"}],"commands":["command"],"notes":["..."]}',
        'Use complete file contents for writes. Commands must be noninteractive and directly validate the task.',
      ].join('\n');

      const user = [
        'AUTHORITATIVE REQUIREMENTS:\n' + requirements.slice(0, 60000),
        'CONFIRMED INTENT:\n' + JSON.stringify(intent, null, 2),
        'CONFIRMED ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
        'ASSIGNED TASK:\n' + JSON.stringify(task, null, 2),
        'REPOSITORY SUMMARY:\n' + repoSummary(),
        'RELEVANT CURRENT SOURCE:\n' + relevantSource(65000),
        failureContext ? 'PREVIOUS ATTEMPT FAILURE:\n' + failureContext.slice(-22000) : '',
      ].filter(Boolean).join('\n\n');

      let result;
      try {
        result = extractJson(await llm(attempt === 1 ? 'coder' : 'debugger', system, user));
        applyOperations(result);
        shell('git add -N .');
      } catch (error) {
        failureContext = 'Model/apply failure: ' + error.message;
        await event('task_attempt_failed', task.id + ' attempt ' + attempt + ': ' + error.message, 'engineering', { task_id: task.id, attempt });
        continue;
      }

      const commands = Array.from(new Set([...(result.commands || []), ...(task.validation_commands || [])]));
      const commandResults = runCommands(commands);
      const failed = commandResults.find(x => !x.ok);
      if (failed) {
        failureContext = 'Command failed: ' + failed.command + '\n' + failed.output;
        await event('task_attempt_failed', task.id + ' attempt ' + attempt + ' command failed: ' + failed.command, 'engineering', { task_id: task.id, attempt });
        continue;
      }

      const reviewSystem = [
        'You are the independent senior reviewer for a procedural coding agent.',
        'Judge ONLY whether the assigned task satisfies the confirmed requirements and architecture in the CURRENT repository.',
        'Reject placeholders, fake current data, unimplemented handlers, incompatible runtime imports, tests that do not test behavior, and claims unsupported by code.',
        'Return ONLY JSON: {"pass":true|false,"issues":["..."],"required_repairs":["..."]}.',
      ].join('\n');
      const reviewUser = [
        'TASK:\n' + JSON.stringify(task, null, 2),
        'REQUIREMENTS:\n' + requirements.slice(0, 45000),
        'ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
        'GIT DIFF:\n' + shell('git diff -- . ":(exclude).vela"').output.slice(-65000),
        'RELEVANT SOURCE:\n' + relevantSource(45000),
      ].join('\n\n');
      let review;
      try { review = extractJson(await llm('reviewer', reviewSystem, reviewUser)); }
      catch (error) { review = { pass: false, issues: ['Reviewer parse failure: ' + error.message], required_repairs: [] }; }

      if (!review.pass) {
        failureContext = 'Independent review rejected task:\n' + JSON.stringify(review, null, 2);
        await event('task_review_rejected', task.id + ' attempt ' + attempt + ' rejected by reviewer', 'engineering', { task_id: task.id, attempt, issues: review.issues || [] });
        continue;
      }

      success = true;
    }

    if (!success) throw new Error('Task failed after repair loop: ' + task.id + '\n' + failureContext.slice(-10000));
    commitCheckpoint('vela: complete ' + task.id + ' ' + task.title);
    completed.add(task.id);
    await event('task_completed', task.id + ': ' + task.title + ' passed implementation and independent review', 'engineering', { task_id: task.id });
  }
}

await event('integration_started', 'Running whole-repository integration checks', 'integration');
let integrationResults = runCommands(standardChecks());
let integrationFailure = integrationResults.find(x => !x.ok);

for (let attempt = 1; integrationFailure && attempt <= MAX_ATTEMPTS; attempt++) {
  const repairSystem = [
    'You are the integration/debugging engineer for a production repository.',
    'Fix the actual repository using the supplied command failure. Preserve requirements and architecture.',
    'Return ONLY JSON: {"summary":"...","files":[{"path":"...","mode":"write","content":"complete content"}],"commands":["..."]}.',
    'Do not replace the application with a generic scaffold. Do not remove tests to make checks pass.',
  ].join('\n');
  const repairUser = [
    'REQUIREMENTS:\n' + requirements.slice(0, 55000),
    'ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
    'FAILED COMMAND:\n' + integrationFailure.command,
    'FAILURE OUTPUT:\n' + integrationFailure.output,
    'REPOSITORY:\n' + repoSummary(),
    'SOURCE:\n' + relevantSource(70000),
  ].join('\n\n');
  const repair = extractJson(await llm('debugger', repairSystem, repairUser));
  applyOperations(repair);
  shell('git add -N .');
  const requested = runCommands(repair.commands || []);
  if (requested.find(x => !x.ok)) {
    integrationFailure = requested.find(x => !x.ok);
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
  'Return ONLY JSON: {"pass":true|false,"implemented":["..."],"partial":["..."],"missing":["..."],"risks":["..."],"evidence":["file or command evidence"]}.',
  'A requirement is implemented only when repository evidence supports it. Never claim successful live deployment; deployment has not happened yet.',
].join('\n');
const finalReviewUser = [
  'REQUIREMENTS:\n' + requirements.slice(0, 65000),
  'ARCHITECTURE:\n' + JSON.stringify(architecture, null, 2),
  'TASK PLAN:\n' + JSON.stringify(plan, null, 2),
  'VALIDATOR:\n' + JSON.stringify(validationReport, null, 2),
  'REPOSITORY:\n' + repoSummary(),
  'SOURCE:\n' + relevantSource(85000),
].join('\n\n');
const finalReview = extractJson(await llm('reviewer', finalReviewSystem, finalReviewUser));
if (!finalReview.pass) throw new Error('Final independent review rejected build: ' + JSON.stringify(finalReview).slice(0, 12000));

write('.vela/final-review.json', JSON.stringify(finalReview, null, 2));
commitCheckpoint('vela: validated engineering build');
const shaResult = shell('git rev-parse HEAD');
const commitSha = shaResult.ok ? shaResult.output.trim() : '';

await event('engineering_complete', 'All procedural engineering tasks, integration checks, validator, and independent review passed', 'awaiting_deploy_approval', { commit_sha: commitSha });
await post('/internal/agent/complete', { commit_sha: commitSha, validation: validationReport, review: finalReview });
console.log('VELA_AGENT_BUILD_COMPLETE', commitSha);
`;

export const AGENT_VALIDATOR = String.raw`#!/usr/bin/env bash
set -euo pipefail
ROOT="${'
MODE="${'
cd "$ROOT"
node .vela/validator.mjs "$MODE"
`;

export const AGENT_VALIDATOR_JS = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

const root = process.cwd();
const mode = process.argv[2] || 'standard';
const failures = [];
const warnings = [];
const evidence = [];

function exists(p) { return fs.existsSync(path.join(root, p)); }
function read(p) { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } }
function walk(dir = '.') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['.git','node_modules','.next','dist','.wrangler'].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name).replace(/^\.\//, '');
    if (entry.isDirectory()) output.push(...walk(rel)); else output.push(rel);
  }
  return output;
}
function run(cmd) {
  try { return { ok: true, out: cp.execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 180000 }).slice(-12000) }; }
  catch (e) { return { ok: false, out: (String(e.stdout || '') + '\n' + String(e.stderr || e.message || '')).slice(-16000) }; }
}

const files = walk();
const sourceFiles = files.filter(f => /\.(mjs|js|cjs|ts|tsx|jsx|sql|css|html)$/.test(f) && !f.startsWith('.vela/'));
const testFiles = files.filter(f => /(^|\/)(test|tests|__tests__)(\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
const sourceBytes = sourceFiles.reduce((sum, f) => sum + Buffer.byteLength(read(f)), 0);
const allSource = sourceFiles.map(read).join('\n');
const requirements = read('.vela/requirements.md');

if (mode === 'complex') {
  if (sourceFiles.length < 8) failures.push('Complex project has fewer than 8 substantive source/schema files');
  if (sourceBytes < 30000) failures.push('Complex project has less than 30KB of substantive implementation source');
  if (!testFiles.length && !/self-test|selfTest|runSelfTests/.test(allSource)) failures.push('Complex project has no automated tests or executable self-test implementation');
}

if (!exists('src/worker.mjs')) failures.push('src/worker.mjs is required for the deployed Cloudflare application');
else {
  const check = run('node --check src/worker.mjs');
  if (!check.ok) failures.push('src/worker.mjs syntax check failed: ' + check.out);
  const worker = read('src/worker.mjs');
  if (/from\s+['"](?:cloudflare\/kv|cloudflare\/r2|d1|next|aws-lambda|pg)['"]/.test(worker)) failures.push('Worker contains incompatible bare/runtime imports');
  if (/\bnew\s+D1\s*\(/.test(worker)) failures.push('Worker instantiates fake D1 instead of using env.DB');
  if (!/export\s+default/.test(worker)) failures.push('Worker has no ES-module default export');
}

if (!exists('wrangler.jsonc') && !exists('wrangler.json')) failures.push('Wrangler configuration is missing');
if (!exists('schema.sql') && !files.some(f => /^migrations\/.+\.sql$/.test(f))) warnings.push('No standalone D1 schema/migrations file found');
if (/Fighter 1|Fighter 2|Fighter 3/.test(allSource) && !/DEMO DATA/.test(allSource)) failures.push('Suspicious unlabeled fake fighter seed data detected');
if (/TODO\s*:\s*implement|placeholder functionality|lorem ipsum|coming soon/i.test(allSource)) warnings.push('Placeholder/TODO language remains in implementation');

const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return null; } })();
if (pkg) {
  for (const name of ['lint','test','build']) {
    if (pkg.scripts && pkg.scripts[name]) {
      const result = run('npm run ' + name);
      if (!result.ok) failures.push('npm run ' + name + ' failed: ' + result.out);
      else evidence.push('npm run ' + name + ': PASS');
    }
  }
}

const wranglerDry = run('npx --yes wrangler@4.126.0 deploy --dry-run --outdir .vela/validator-dry-run');
if (!wranglerDry.ok) failures.push('Wrangler dry-run failed: ' + wranglerDry.out);
else evidence.push('wrangler deploy --dry-run: PASS');

const requirementTerms = [...new Set((requirements.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || []))]
  .filter(x => !['application','cloudflare','worker','should','using','create','build','project','implementation','available','analysis','support'].includes(x))
  .slice(0, 80);
const sourceLower = allSource.toLowerCase();
const coveredTerms = requirementTerms.filter(term => sourceLower.includes(term));
if (mode === 'complex' && requirementTerms.length >= 20 && coveredTerms.length / requirementTerms.length < 0.25) warnings.push('Low lexical evidence coverage of authoritative requirements: ' + coveredTerms.length + '/' + requirementTerms.length);

evidence.push('substantive files: ' + sourceFiles.length);
evidence.push('implementation bytes: ' + sourceBytes);
evidence.push('test files: ' + testFiles.length);
evidence.push('requirement signal coverage: ' + coveredTerms.length + '/' + requirementTerms.length);

const report = { mode, pass: failures.length === 0, failures, warnings, evidence, source_files: sourceFiles.length, source_bytes: sourceBytes, test_files: testFiles.length };
fs.mkdirSync(path.join(root, '.vela'), { recursive: true });
fs.writeFileSync(path.join(root, '.vela/validation-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
`;
}{1:-.}"
MODE="\${2:-standard}"
cd "$ROOT"
node .vela/validator.mjs "$MODE"
`;

export const AGENT_VALIDATOR_JS = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

const root = process.cwd();
const mode = process.argv[2] || 'standard';
const failures = [];
const warnings = [];
const evidence = [];

function exists(p) { return fs.existsSync(path.join(root, p)); }
function read(p) { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } }
function walk(dir = '.') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['.git','node_modules','.next','dist','.wrangler'].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name).replace(/^\.\//, '');
    if (entry.isDirectory()) output.push(...walk(rel)); else output.push(rel);
  }
  return output;
}
function run(cmd) {
  try { return { ok: true, out: cp.execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 180000 }).slice(-12000) }; }
  catch (e) { return { ok: false, out: (String(e.stdout || '') + '\n' + String(e.stderr || e.message || '')).slice(-16000) }; }
}

const files = walk();
const sourceFiles = files.filter(f => /\.(mjs|js|cjs|ts|tsx|jsx|sql|css|html)$/.test(f) && !f.startsWith('.vela/'));
const testFiles = files.filter(f => /(^|\/)(test|tests|__tests__)(\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
const sourceBytes = sourceFiles.reduce((sum, f) => sum + Buffer.byteLength(read(f)), 0);
const allSource = sourceFiles.map(read).join('\n');
const requirements = read('.vela/requirements.md');

if (mode === 'complex') {
  if (sourceFiles.length < 8) failures.push('Complex project has fewer than 8 substantive source/schema files');
  if (sourceBytes < 30000) failures.push('Complex project has less than 30KB of substantive implementation source');
  if (!testFiles.length && !/self-test|selfTest|runSelfTests/.test(allSource)) failures.push('Complex project has no automated tests or executable self-test implementation');
}

if (!exists('src/worker.mjs')) failures.push('src/worker.mjs is required for the deployed Cloudflare application');
else {
  const check = run('node --check src/worker.mjs');
  if (!check.ok) failures.push('src/worker.mjs syntax check failed: ' + check.out);
  const worker = read('src/worker.mjs');
  if (/from\s+['"](?:cloudflare\/kv|cloudflare\/r2|d1|next|aws-lambda|pg)['"]/.test(worker)) failures.push('Worker contains incompatible bare/runtime imports');
  if (/\bnew\s+D1\s*\(/.test(worker)) failures.push('Worker instantiates fake D1 instead of using env.DB');
  if (!/export\s+default/.test(worker)) failures.push('Worker has no ES-module default export');
}

if (!exists('wrangler.jsonc') && !exists('wrangler.json')) failures.push('Wrangler configuration is missing');
if (!exists('schema.sql') && !files.some(f => /^migrations\/.+\.sql$/.test(f))) warnings.push('No standalone D1 schema/migrations file found');
if (/Fighter 1|Fighter 2|Fighter 3/.test(allSource) && !/DEMO DATA/.test(allSource)) failures.push('Suspicious unlabeled fake fighter seed data detected');
if (/TODO\s*:\s*implement|placeholder functionality|lorem ipsum|coming soon/i.test(allSource)) warnings.push('Placeholder/TODO language remains in implementation');

const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return null; } })();
if (pkg) {
  for (const name of ['lint','test','build']) {
    if (pkg.scripts && pkg.scripts[name]) {
      const result = run('npm run ' + name);
      if (!result.ok) failures.push('npm run ' + name + ' failed: ' + result.out);
      else evidence.push('npm run ' + name + ': PASS');
    }
  }
}

const wranglerDry = run('npx --yes wrangler@4.126.0 deploy --dry-run --outdir .vela/validator-dry-run');
if (!wranglerDry.ok) failures.push('Wrangler dry-run failed: ' + wranglerDry.out);
else evidence.push('wrangler deploy --dry-run: PASS');

const requirementTerms = [...new Set((requirements.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || []))]
  .filter(x => !['application','cloudflare','worker','should','using','create','build','project','implementation','available','analysis','support'].includes(x))
  .slice(0, 80);
const sourceLower = allSource.toLowerCase();
const coveredTerms = requirementTerms.filter(term => sourceLower.includes(term));
if (mode === 'complex' && requirementTerms.length >= 20 && coveredTerms.length / requirementTerms.length < 0.25) warnings.push('Low lexical evidence coverage of authoritative requirements: ' + coveredTerms.length + '/' + requirementTerms.length);

evidence.push('substantive files: ' + sourceFiles.length);
evidence.push('implementation bytes: ' + sourceBytes);
evidence.push('test files: ' + testFiles.length);
evidence.push('requirement signal coverage: ' + coveredTerms.length + '/' + requirementTerms.length);

const report = { mode, pass: failures.length === 0, failures, warnings, evidence, source_files: sourceFiles.length, source_bytes: sourceBytes, test_files: testFiles.length };
fs.mkdirSync(path.join(root, '.vela'), { recursive: true });
fs.writeFileSync(path.join(root, '.vela/validation-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
`;
}{2:-standard}"
cd "$ROOT"
node .vela/validator.mjs "$MODE"
`;

export const AGENT_VALIDATOR_JS = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

const root = process.cwd();
const mode = process.argv[2] || 'standard';
const failures = [];
const warnings = [];
const evidence = [];

function exists(p) { return fs.existsSync(path.join(root, p)); }
function read(p) { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } }
function walk(dir = '.') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['.git','node_modules','.next','dist','.wrangler'].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name).replace(/^\.\//, '');
    if (entry.isDirectory()) output.push(...walk(rel)); else output.push(rel);
  }
  return output;
}
function run(cmd) {
  try { return { ok: true, out: cp.execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 180000 }).slice(-12000) }; }
  catch (e) { return { ok: false, out: (String(e.stdout || '') + '\n' + String(e.stderr || e.message || '')).slice(-16000) }; }
}

const files = walk();
const sourceFiles = files.filter(f => /\.(mjs|js|cjs|ts|tsx|jsx|sql|css|html)$/.test(f) && !f.startsWith('.vela/'));
const testFiles = files.filter(f => /(^|\/)(test|tests|__tests__)(\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
const sourceBytes = sourceFiles.reduce((sum, f) => sum + Buffer.byteLength(read(f)), 0);
const allSource = sourceFiles.map(read).join('\n');
const requirements = read('.vela/requirements.md');

if (mode === 'complex') {
  if (sourceFiles.length < 8) failures.push('Complex project has fewer than 8 substantive source/schema files');
  if (sourceBytes < 30000) failures.push('Complex project has less than 30KB of substantive implementation source');
  if (!testFiles.length && !/self-test|selfTest|runSelfTests/.test(allSource)) failures.push('Complex project has no automated tests or executable self-test implementation');
}

if (!exists('src/worker.mjs')) failures.push('src/worker.mjs is required for the deployed Cloudflare application');
else {
  const check = run('node --check src/worker.mjs');
  if (!check.ok) failures.push('src/worker.mjs syntax check failed: ' + check.out);
  const worker = read('src/worker.mjs');
  if (/from\s+['"](?:cloudflare\/kv|cloudflare\/r2|d1|next|aws-lambda|pg)['"]/.test(worker)) failures.push('Worker contains incompatible bare/runtime imports');
  if (/\bnew\s+D1\s*\(/.test(worker)) failures.push('Worker instantiates fake D1 instead of using env.DB');
  if (!/export\s+default/.test(worker)) failures.push('Worker has no ES-module default export');
}

if (!exists('wrangler.jsonc') && !exists('wrangler.json')) failures.push('Wrangler configuration is missing');
if (!exists('schema.sql') && !files.some(f => /^migrations\/.+\.sql$/.test(f))) warnings.push('No standalone D1 schema/migrations file found');
if (/Fighter 1|Fighter 2|Fighter 3/.test(allSource) && !/DEMO DATA/.test(allSource)) failures.push('Suspicious unlabeled fake fighter seed data detected');
if (/TODO\s*:\s*implement|placeholder functionality|lorem ipsum|coming soon/i.test(allSource)) warnings.push('Placeholder/TODO language remains in implementation');

const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return null; } })();
if (pkg) {
  for (const name of ['lint','test','build']) {
    if (pkg.scripts && pkg.scripts[name]) {
      const result = run('npm run ' + name);
      if (!result.ok) failures.push('npm run ' + name + ' failed: ' + result.out);
      else evidence.push('npm run ' + name + ': PASS');
    }
  }
}

const wranglerDry = run('npx --yes wrangler@4.126.0 deploy --dry-run --outdir .vela/validator-dry-run');
if (!wranglerDry.ok) failures.push('Wrangler dry-run failed: ' + wranglerDry.out);
else evidence.push('wrangler deploy --dry-run: PASS');

const requirementTerms = [...new Set((requirements.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || []))]
  .filter(x => !['application','cloudflare','worker','should','using','create','build','project','implementation','available','analysis','support'].includes(x))
  .slice(0, 80);
const sourceLower = allSource.toLowerCase();
const coveredTerms = requirementTerms.filter(term => sourceLower.includes(term));
if (mode === 'complex' && requirementTerms.length >= 20 && coveredTerms.length / requirementTerms.length < 0.25) warnings.push('Low lexical evidence coverage of authoritative requirements: ' + coveredTerms.length + '/' + requirementTerms.length);

evidence.push('substantive files: ' + sourceFiles.length);
evidence.push('implementation bytes: ' + sourceBytes);
evidence.push('test files: ' + testFiles.length);
evidence.push('requirement signal coverage: ' + coveredTerms.length + '/' + requirementTerms.length);

const report = { mode, pass: failures.length === 0, failures, warnings, evidence, source_files: sourceFiles.length, source_bytes: sourceBytes, test_files: testFiles.length };
fs.mkdirSync(path.join(root, '.vela'), { recursive: true });
fs.writeFileSync(path.join(root, '.vela/validation-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
`;
}{1:-.}"
MODE="\${2:-standard}"
cd "$ROOT"
node .vela/validator.mjs "$MODE"
`;

export const AGENT_VALIDATOR_JS = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

const root = process.cwd();
const mode = process.argv[2] || 'standard';
const failures = [];
const warnings = [];
const evidence = [];

function exists(p) { return fs.existsSync(path.join(root, p)); }
function read(p) { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } }
function walk(dir = '.') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['.git','node_modules','.next','dist','.wrangler'].includes(entry.name)) continue;
    const rel = path.join(dir, entry.name).replace(/^\.\//, '');
    if (entry.isDirectory()) output.push(...walk(rel)); else output.push(rel);
  }
  return output;
}
function run(cmd) {
  try { return { ok: true, out: cp.execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 180000 }).slice(-12000) }; }
  catch (e) { return { ok: false, out: (String(e.stdout || '') + '\n' + String(e.stderr || e.message || '')).slice(-16000) }; }
}

const files = walk();
const sourceFiles = files.filter(f => /\.(mjs|js|cjs|ts|tsx|jsx|sql|css|html)$/.test(f) && !f.startsWith('.vela/'));
const testFiles = files.filter(f => /(^|\/)(test|tests|__tests__)(\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
const sourceBytes = sourceFiles.reduce((sum, f) => sum + Buffer.byteLength(read(f)), 0);
const allSource = sourceFiles.map(read).join('\n');
const requirements = read('.vela/requirements.md');

if (mode === 'complex') {
  if (sourceFiles.length < 8) failures.push('Complex project has fewer than 8 substantive source/schema files');
  if (sourceBytes < 30000) failures.push('Complex project has less than 30KB of substantive implementation source');
  if (!testFiles.length && !/self-test|selfTest|runSelfTests/.test(allSource)) failures.push('Complex project has no automated tests or executable self-test implementation');
}

if (!exists('src/worker.mjs')) failures.push('src/worker.mjs is required for the deployed Cloudflare application');
else {
  const check = run('node --check src/worker.mjs');
  if (!check.ok) failures.push('src/worker.mjs syntax check failed: ' + check.out);
  const worker = read('src/worker.mjs');
  if (/from\s+['"](?:cloudflare\/kv|cloudflare\/r2|d1|next|aws-lambda|pg)['"]/.test(worker)) failures.push('Worker contains incompatible bare/runtime imports');
  if (/\bnew\s+D1\s*\(/.test(worker)) failures.push('Worker instantiates fake D1 instead of using env.DB');
  if (!/export\s+default/.test(worker)) failures.push('Worker has no ES-module default export');
}

if (!exists('wrangler.jsonc') && !exists('wrangler.json')) failures.push('Wrangler configuration is missing');
if (!exists('schema.sql') && !files.some(f => /^migrations\/.+\.sql$/.test(f))) warnings.push('No standalone D1 schema/migrations file found');
if (/Fighter 1|Fighter 2|Fighter 3/.test(allSource) && !/DEMO DATA/.test(allSource)) failures.push('Suspicious unlabeled fake fighter seed data detected');
if (/TODO\s*:\s*implement|placeholder functionality|lorem ipsum|coming soon/i.test(allSource)) warnings.push('Placeholder/TODO language remains in implementation');

const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return null; } })();
if (pkg) {
  for (const name of ['lint','test','build']) {
    if (pkg.scripts && pkg.scripts[name]) {
      const result = run('npm run ' + name);
      if (!result.ok) failures.push('npm run ' + name + ' failed: ' + result.out);
      else evidence.push('npm run ' + name + ': PASS');
    }
  }
}

const wranglerDry = run('npx --yes wrangler@4.126.0 deploy --dry-run --outdir .vela/validator-dry-run');
if (!wranglerDry.ok) failures.push('Wrangler dry-run failed: ' + wranglerDry.out);
else evidence.push('wrangler deploy --dry-run: PASS');

const requirementTerms = [...new Set((requirements.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || []))]
  .filter(x => !['application','cloudflare','worker','should','using','create','build','project','implementation','available','analysis','support'].includes(x))
  .slice(0, 80);
const sourceLower = allSource.toLowerCase();
const coveredTerms = requirementTerms.filter(term => sourceLower.includes(term));
if (mode === 'complex' && requirementTerms.length >= 20 && coveredTerms.length / requirementTerms.length < 0.25) warnings.push('Low lexical evidence coverage of authoritative requirements: ' + coveredTerms.length + '/' + requirementTerms.length);

evidence.push('substantive files: ' + sourceFiles.length);
evidence.push('implementation bytes: ' + sourceBytes);
evidence.push('test files: ' + testFiles.length);
evidence.push('requirement signal coverage: ' + coveredTerms.length + '/' + requirementTerms.length);

const report = { mode, pass: failures.length === 0, failures, warnings, evidence, source_files: sourceFiles.length, source_bytes: sourceBytes, test_files: testFiles.length };
fs.mkdirSync(path.join(root, '.vela'), { recursive: true });
fs.writeFileSync(path.join(root, '.vela/validation-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
`;
