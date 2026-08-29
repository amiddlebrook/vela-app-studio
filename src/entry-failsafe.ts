export { BuildCoordinator } from './index';

type RuntimeEnv = {
  DB?: D1Database;
};

type QueueBody = { projectId?: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const realFetch = globalThis.fetch.bind(globalThis);

const SMARTGAMBLER_PROMPT = `Build a comprehensive production-grade full-stack MMA fight-analysis and betting-research application called SmartGambler.

This must be a substantial working application, not a README, placeholder, pseudocode, landing page, static mock dashboard, fake demo, hardcoded fake-current-data interface, or superficial MVP. It is an analytical research application only and must NEVER place wagers, interact with sportsbook accounts, connect to bank accounts, or perform financial transactions.

ARCHITECTURE: Use a free-tier Cloudflare full-stack architecture: Cloudflare Worker serving the real production UI and API plus D1 relational persistence. Use KV, R2, Queues, Browser Rendering/Browser Run only when genuinely useful and available. Do not enable paid services. The deployed root route must be the actual polished SmartGambler application. Use wrangler configuration appropriate to the actual Worker deployment. D1 is a runtime binding exposed as env.DB; NEVER import a package/module named d1, D1Database, @cloudflare/workers-types, or any other package in the single-file deployed Worker. The Worker must be self-contained JavaScript with no unresolved/bare package imports.

DATA & PROVENANCE: Collect real publicly available MMA/UFC information through modular legal source adapters where possible using public HTTP/APIs, structured data, HTML, public promotion/statistics/fighter/journalism/interview/weigh-in/event/market sources. A failed source must degrade gracefully. Never bypass authentication, paywalls, CAPTCHAs, or access controls. Store source URL, retrieval time, association, type, reliability, and extracted claims. Never invent fighters, fights, cards, records, statistics, odds, injuries, quotes, results, news, source URLs, database IDs, repository URLs, or deployment URLs. Missing information must display UNAVAILABLE or an equivalent honest state. Any seed/demo records must be explicitly labeled DEMO DATA and never represented as current.

EVENT DISCOVERY: Automatically discover upcoming UFC/MMA events when practical. Persist promotion, event name/date/timezone, venue, city, region/state, country, altitude when relevant, card status, main event, co-main, main-card fights, prelims, early prelims, bout ordering, weight class, scheduled rounds, and championship status. Support manual corrections. Detect opponent replacements, cancellations, missed weight, changed weight class, major odds movement, reported injury, withdrawals, and venue changes; material changes mark old analysis stale.

FIGHTER DATABASE: Persistent normalized fighter profiles with canonical name, aliases, external source IDs, DOB/age, nationality, fighting-out-of, gym/team, coaches, height, reach, stance, weight-class history, professional and UFC records, fight history, opponents, event dates, outcomes, methods, rounds/times, statistics, derived metrics, structured style traits, research evidence, model observations, and manual analyst notes. Resolve fighter identity across sources and avoid duplicates.

QUANTITATIVE FIGHT ANALYSIS: For every fight use as much genuinely obtainable evidence as possible: professional record, UFC record, recent form, opponent quality, strength of schedule, age, height, reach, stance, weight class, weigh-in result, missed-weight history, significant strikes landed/absorbed, striking accuracy/defense/differential/pace, knockdowns, takedown attempts/accuracy/defense, control time, submission attempts, finish/KO/submission/decision rates, durability indicators, cardio indicators, pace by round, late-round performance, deterioration, five-round experience, and championship-round experience.

STYLE & CONTEXT: Represent pressure, counter striking, boxing, kickboxing, low kicks, body attacks, kicking range, distance management, defensive movement, guard reliance, clinch, offensive/defensive/chain wrestling, reactive takedowns, cage wrestling, top control, scrambling, guard work, submission offense/defense, get-up ability, physical strength, explosiveness, athleticism, speed, power, composure, discipline, fight IQ, tactical adaptability, and predictability. When credible evidence exists consider training camp/gym/coach changes, injuries/surgeries, layoffs, short notice, replacement opponents, travel, altitude, time zones, hometown conditions, weight cuts/class changes, career trajectory, prospect-veteran dynamics, confidence, motivation, title implications, publicly documented contract/career context, retirement discussion, fighter/coach interviews, press conferences, public training footage information, and recent reporting. Never invent qualitative claims; each must have provenance or be explicitly labeled analyst/model inference with confidence.

HISTORICAL PERFORMANCE: Calculate derived metrics instead of merely showing raw data: recency-weighted form, opponent-strength-adjusted performance, striking differential/efficiency/defense/damage efficiency, knockdown rate, durability, takedown pressure, wrestling effectiveness/defense, grappling threat, control efficiency, submission threat, cardio trend, pace trend, finishing threat, decision reliability, comeback ability, early/late-round danger, consistency, volatility, and performance against elite opposition. Recency weighting must be configurable.

MATCHUP ENGINE: Analyze Fighter A AGAINST Fighter B, not independent rankings. Model interactions such as wrestler versus weak takedown defense, pressure striker versus low-output counter striker, power versus durability, kicking versus leg-kick vulnerability, tall outside striker versus short pressure boxer, grappler versus weak positional defense, cardio-heavy fighter versus late-round decline, southpaw/orthodox tendencies, and clinch specialist versus weak cage defense. Every fight exposes each fighter's advantages, contested areas, likely geography, tactical plans, paths to victory/defeat, key assumptions, unknowns, important variables, and factors that could invalidate the prediction.

PROBABILITY ENGINE: Estimate Fighter A/B win probability plus KO/TKO, submission, decision, goes-distance and does-not-go-distance; optionally fighter-specific methods and round-specific finish probabilities when evidence supports them. Store raw model probability, calibrated/final probability, confidence, uncertainty range, evidence completeness, market probability and estimated edge. Do not claim fake precision. Clearly distinguish model confidence from betting value.

SIX ANALYTICAL MODELS: Produce six meaningfully different perspectives: statistical, style-matchup, recent-form, market-value, risk-adjusted, and composite. Each independently returns selected winner, win probability, confidence, reasoning, estimated edge, and suggested wager or NO BET. Do not copy the same output six times. Display model agreement/disagreement.

ODDS ENGINE: Use CURRENT publicly accessible odds for current analysis and store timestamped snapshots without overwriting history. Support American/decimal odds, implied probability, no-vig probability where possible, best line, market average, opening/current lines, movement, retrieval time, and stale-line detection. Never present stale odds as current. Compare multiple accessible market sources when possible.

EXPECTED VALUE: Deterministically calculate estimated win probability, market implied probability, no-vig probability, decimal payout, expected value, expected return percentage, edge percentage, break-even probability, and uncertainty-adjusted edge. Clearly distinguish GOOD FIGHT PICK from GOOD BET AT THIS PRICE. Classify strong/moderate/small value, neutral, negative value, avoid, and insufficient information. NO BET is a valid and common result.

PARLAY ENGINE: Functional parlay analysis with approximate target payout profiles 2x, 5x, 10x, and 100x, explicitly not guarantees. Inputs include hypothetical stake, desired multiplier, maximum legs, minimum confidence, minimum edge, allowed bet types, excluded fights, and excluded fighters. Calculate combined decimal/American odds, market implied probability, model-estimated combined probability, EV, payout and profit. Do not merely select largest favorites. Consider confidence, EV, uncertainty, correlation, volatility, overlapping assumptions, and method volatility; avoid correlated legs unless understood and disclosed. Generate safest positive-EV, balanced, aggressive, long-shot, highest-confidence, and highest-EV candidate portfolios. Clearly distinguish potential payout from probability of success.

FULL-CARD VIEW: Rank every fight/market with fight, selected market, current odds, model probability, implied probability, edge, confidence, EV, risk, recommendation, main reason and primary risk. Sort by confidence, EV, edge, risk and fight order, including prelims and early prelims.

BANKROLL ANALYSIS: Hypothetical bankroll tools only. Support flat units, fractional Kelly and confidence-weighted sizing, conservative fractional Kelly by default. Show units, bankroll percentage, maximum loss and projected EV.

RESEARCH/EVIDENCE: Every fight has a research feed with title, summary, source, URL, publication/retrieval dates, fighter/fight/event associations, category, reliability and extracted claims. Categories include injury, training, camp, interview, strategy, weigh-in, travel, replacement, retirement, career, statistics, performance, odds and matchup. Important claims in final analysis must trace to evidence.

FRESHNESS & REFRESH PIPELINE: Track event/fighter/news/odds last updated and analysis generated timestamps; flag stale information and allow refresh/reanalysis. Implement a real pipeline: DISCOVER EVENTS -> DISCOVER FIGHTS -> RESOLVE FIGHTERS -> UPDATE FIGHTER DATA -> UPDATE FIGHT HISTORY -> UPDATE STATISTICS -> GATHER RESEARCH -> GATHER CURRENT ODDS -> NORMALIZE -> DERIVE METRICS -> RUN MATCHUP ANALYSIS -> RUN PROBABILITY MODELS -> RUN VALUE ANALYSIS -> GENERATE RECOMMENDATIONS -> GENERATE PARLAY CANDIDATES -> STORE RESULTS. Individual source/stage failures degrade gracefully and are recorded.

EXPLANATIONS & UNCERTAINTY: Fight pages provide SUMMARY, WHY FIGHTER A CAN WIN, WHY FIGHTER B CAN WIN, MOST LIKELY FIGHT SCRIPT, LIKELY FIGHT GEOGRAPHY, KEY VARIABLES, MODEL AGREEMENT/DISAGREEMENT, CURRENT MARKET, VALUE ANALYSIS, BEST BET, ALTERNATIVE BET, NO-BET REASON when applicable, CONFIDENCE, UNCERTAINTY, RISKS and SOURCES. Weak evidence widens uncertainty. Explicitly represent uncertainty sources such as UFC debut, small sample, regional competition, long layoff, injury, short notice, unknown cardio, poor stats coverage, conflicting reporting, unavailable odds/tape and weight-class transition.

MANUAL ANALYST TOOLS: Allow fighter/fight notes, subjective style rating adjustments, marking evidence important, rejecting incorrect scraped information, manually entering odds or missing fight information, force refresh and regenerate analysis. Machine-generated and manually entered information remain distinguishable.

UI: Build a polished responsive desktop/mobile interface, not an engineering console. Dashboard: next event/countdown, fights analyzed, strongest edges, highest-confidence picks, largest line movement, material changes, stale warnings. Event page: complete card including prelims, odds, model picks/disagreement/confidence/EV/recommendations, sortable ranking. Fight page: fighter comparison, physical stats, performance metrics/trends, style matchup, fight script/geography, probabilities/method probabilities, current odds/movement/EV, model disagreement, evidence/citations, analyst notes. Fighter page: profile/history/trends/metrics/style/research/notes. Parlay builder: target payout, stake, constraints, candidate legs/parlays, combined odds/probability/EV/payout. Research page: recent evidence and filters. Settings: model weights, recency weighting, minimum edge/confidence, fractional Kelly, refresh behavior. Add genuinely useful visualizations for fighter comparisons, trends, probabilities, odds movement, model disagreement, uncertainty and historical outcome distribution.

DATABASE: Use a real persistent normalized D1 database with appropriate relationships/indexes for at least events, fights, fighters, fighter aliases/source IDs, fight history, statistics, derived metrics, style traits, research items/sources, odds snapshots, analysis runs, model outputs, recommendations, parlays, parlay legs, analyst notes, settings, and pipeline runs/errors. Never invent a D1 ID; the control plane provisions/binds the actual database.

API: Implement validated backend/API routes for events/event details, fights/fight details, fighters/fighter details, odds, research, analysis, recommendations, parlays, notes, settings, refresh operations, pipeline status, health, and deterministic calculation/self-test utilities. Return useful error responses. Never expose secrets in frontend JavaScript.

DETERMINISTIC CALCULATIONS: Do not rely entirely on an LLM for numbers. Implement American odds -> decimal, decimal -> American, implied probability, no-vig probability, EV, expected return, break-even probability, parlay odds/payout, Kelly/fractional Kelly, weighted scores and practical uncertainty calculations. Clearly separate RAW DATA, DERIVED DATA, DETERMINISTIC CALCULATIONS, HEURISTIC SCORES, AI ANALYSIS and FINAL COMPOSITE ANALYSIS. Use AI primarily for qualitative synthesis and matchup reasoning.

TESTING & VALIDATION: Create meaningful automated/self tests that actually execute for odds conversions, implied/no-vig probability, EV, parlay combined odds/payout, Kelly sizing, fighter normalization/identity resolution, derived metrics, probability/model calculations, API validation, database operations and important frontend behavior where practical. Locally/runtime validate real endpoints and root UI. Never report PASS unless the corresponding real operation succeeded. Do not deploy a placeholder implementation. Live validation must verify the deployed application responds, SmartGambler UI loads, it is not an error page, and an important API endpoint works.

GITHUB/DEPLOYMENT: Reuse/update the existing private repository for this project. The Worker deployment must use the actual deployed URL and actual D1 binding. Lack of GitHub automatic deployment integration is not a failure. Never hardcode PASS lines, repository URLs, deployment URLs or substitute skipped/failed operations with PASS.

The finished application must be substantial enough to serve as the primary interface for UFC/MMA event research, fighter comparison, matchup analysis, probability analysis, current betting-market value analysis, evidence review, uncertainty analysis and mathematically analyzed parlay construction.`;

function decodeBase64(value: string): string {
  return decoder.decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)));
}

function encodeBase64(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function stripInvalidBindingImports(source: string): { source: string; changed: boolean } {
  let next = source;
  const before = next;
  next = next.replace(/^\s*import\s+(?:type\s+)?[^;\n]*\s+from\s+['"](?:d1|@cloudflare\/workers-types)['"]\s*;?\s*$/gmi, '');
  next = next.replace(/^\s*import\s+['"](?:d1|@cloudflare\/workers-types)['"]\s*;?\s*$/gmi, '');
  return { source: next.trim(), changed: next !== before };
}

function addWorkerGenerationRules(body: string): string {
  try {
    const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
    if (!Array.isArray(payload.messages)) return body;
    let changed = false;
    payload.messages = payload.messages.map(message => {
      if (message.role !== 'system' || typeof message.content !== 'string') return message;
      if (!/Cloudflare Worker|backend\/runtime engineer|production app-builder pipeline/i.test(message.content)) return message;
      changed = true;
      return {
        ...message,
        content: message.content + `\n\nMANDATORY MODULE RULES: The deployed worker.mjs is uploaded directly as ONE self-contained ES module. Do NOT import d1, D1Database, @cloudflare/workers-types, Hono, React, npm packages, Node packages, or any bare/external module. D1 is available ONLY as env.DB. Use only platform globals and code defined in this one file. Any unresolved import makes the build invalid.`,
      };
    });
    return changed ? JSON.stringify(payload) : body;
  } catch {
    return body;
  }
}

function installOuterFetchGuard(): void {
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url === 'https://openrouter.ai/api/v1/chat/completions' && typeof init?.body === 'string') {
      init = { ...init, body: addWorkerGenerationRules(init.body) };
    }

    if (url.includes('api.github.com/repos/') && url.includes('/contents/src/worker.mjs') && init?.method?.toUpperCase() === 'PUT' && typeof init.body === 'string') {
      try {
        const payload = JSON.parse(init.body) as { content?: string } & Record<string, unknown>;
        if (payload.content) {
          const original = decodeBase64(payload.content);
          const cleaned = stripInvalidBindingImports(original);
          if (cleaned.changed) {
            payload.content = encodeBase64(cleaned.source);
            init = { ...init, body: JSON.stringify(payload) };
            console.warn(JSON.stringify({ event: 'removed_invalid_d1_import_before_github_write' }));
          }
        }
      } catch {}
    }

    if (url.includes('api.cloudflare.com/client/v4/accounts/') && url.includes('/workers/scripts/') && init?.method?.toUpperCase() === 'PUT' && init.body instanceof FormData) {
      const module = init.body.get('worker.mjs');
      if (module instanceof Blob) {
        const original = await module.text();
        const cleaned = stripInvalidBindingImports(original);
        if (cleaned.changed) {
          const form = new FormData();
          for (const [key, value] of init.body.entries()) {
            if (key !== 'worker.mjs') form.append(key, value);
          }
          form.set('worker.mjs', new Blob([cleaned.source], { type: 'application/javascript+module' }), 'worker.mjs');
          init = { ...init, body: form };
          console.warn(JSON.stringify({ event: 'removed_invalid_d1_import_before_cloudflare_upload' }));
        }
      }
    }

    return realFetch(input, init);
  };
}

async function recoverSmartGambler(env: RuntimeEnv, projectId?: string): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_full_prompts (
    project_id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`).run();

  const where = projectId
    ? `id = ? AND prompt LIKE 'Build a comprehensive production-grade full-stack MMA fight-analysis%' AND length(prompt) <= 5000`
    : `prompt LIKE 'Build a comprehensive production-grade full-stack MMA fight-analysis%' AND length(prompt) <= 5000`;
  const stmt = env.DB.prepare(`SELECT id, prompt FROM projects WHERE ${where}`);
  const result = projectId
    ? await stmt.bind(projectId).all<{ id: string; prompt: string }>()
    : await stmt.all<{ id: string; prompt: string }>();

  for (const project of result.results || []) {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO project_full_prompts (project_id, prompt, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`)
      .bind(project.id, SMARTGAMBLER_PROMPT, now).run();
    await env.DB.prepare('UPDATE projects SET prompt = ?, updated_at = ? WHERE id = ?')
      .bind(SMARTGAMBLER_PROMPT, now, project.id).run();
    console.warn(JSON.stringify({ event: 'smartgambler_full_prompt_recovered', projectId: project.id, oldLength: project.prompt.length, newLength: SMARTGAMBLER_PROMPT.length }));
  }
}

installOuterFetchGuard();
const entry = import('./entry-ui');

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    const projectMatch = url.pathname.match(/^\/projects\/([0-9a-f-]{36})(?:\/|$)/);
    try {
      if (url.pathname === '/' || url.pathname === '/projects') await recoverSmartGambler(env);
      else if (projectMatch?.[1]) await recoverSmartGambler(env, projectMatch[1]);
    } catch (error) {
      console.warn(JSON.stringify({ event: 'smartgambler_recovery_guard_failed', reason: error instanceof Error ? error.message : String(error) }));
    }
    const module = await entry;
    return module.default.fetch(request, env as never);
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    try {
      for (const message of batch.messages) {
        const body = message.body as QueueBody;
        if (body?.projectId) await recoverSmartGambler(env, body.projectId);
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'smartgambler_queue_recovery_failed', reason: error instanceof Error ? error.message : String(error) }));
    }
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};