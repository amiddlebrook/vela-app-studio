import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { transform } from 'esbuild';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const entry = read('src/mesh-entry.ts');
const runtime = read('src/mesh-runtime.ts');
const polish = read('src/mesh-polish.ts');
const config = read('wrangler.jsonc');
const deploy = read('.github/workflows/deploy.yml');

assert.match(config, /"main":\s*"src\/mesh-entry\.ts"/);
assert.match(config, /"binding":\s*"AI"/);
assert.match(config, /"binding":\s*"DB"/);
assert.match(entry, /polishMeshPage\(body\.replace\(oldAiClick, newAiClick\)\)/);
assert.match(runtime, /const order = active === 'openrouter' \? \['openrouter', 'workers-ai'\] : \['workers-ai', 'openrouter'\]/);
assert.match(runtime, /if \(!model\.endsWith\(':free'\)\) continue/);
assert.match(runtime, /No free AI inference is available/);
assert.match(runtime, /Crawler needs a public HTTPS URL/);
assert.match(deploy, /Runtime smoke test/);
assert.match(deploy, /Reconcile D1 schema/);

for (const file of ['src/mesh-entry.ts', 'src/mesh-runtime.ts', 'src/mesh-polish.ts', 'src/mesh-ai-ui.ts']) {
  await transform(read(file), { loader: 'ts', sourcefile: file });
}

const { code } = await transform(polish, { loader: 'ts', format: 'esm' });
const { polishMeshPage } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const fixture = '<html><head><title>Vela Mesh</title><style></style></head><body><div class="sub" style="color:#70d7ff">THE WHOLE INTERFACE</div><h1>Click things together.</h1><div id="notice" class="notice"></div><div class="toolbar"><div></div></div></main><div id="modal"></div><script>function render(){const g=1}async function togglePower(id){const l=1}</script></body></html>';
const improved = polishMeshPage(fixture);
assert.match(improved, /YOUR EDGE-NATIVE AUTOMATION STUDIO/);
assert.match(improved, /metric-ready/);
assert.match(improved, /Free-tier first/);
assert.match(improved, /AI settings/);
assert.match(improved, /Cloudflare App Studio/);
const scripts = [...improved.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 2, 'Dashboard should have original + safety script');
for (const script of scripts) new Script(script);
console.log('Vela production mesh contracts and UI JavaScript syntax: PASS');
