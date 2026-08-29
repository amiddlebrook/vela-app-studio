export { BuildCoordinator } from './index';

type RuntimeEnv = {
  DB?: D1Database;
};

type BuildQueueBody = { projectId?: string; prompt?: string };

type CapturedPrompt = {
  prompt: string;
  projectId?: string;
  deriveIdFromResponse: boolean;
};

const SMARTGAMBLER_RECOVERY_PROMPT = `Build a comprehensive production-grade full-stack MMA fight-analysis and betting-research application called SmartGambler.

This must be a substantial working application, not a README, placeholder, static mock, fake demo, hardcoded fake-current-data dashboard, or superficial MVP. It is an analytical research application only and must NEVER place wagers or interact with sportsbook accounts.

ARCHITECTURE: Use an appropriate free-tier Cloudflare full-stack architecture: Cloudflare Worker serving the production UI and API plus D1 relational persistence. Use KV/R2/Queues only when genuinely useful. Do not enable paid services. The deployed root route must be the actual polished SmartGambler application.

DATA & PROVENANCE: Collect real publicly available MMA/UFC information through modular legal source adapters where possible (public HTTP/APIs, structured data, HTML, public promotion/statistics/fighter/journalism/interview/weigh-in/event/market sources). A failed source must degrade gracefully. Never bypass auth, paywalls, CAPTCHAs, or access controls. Store source URL, retrieval time, association, type, reliability, and extracted claims. Never invent fighters, fights, records, statistics, odds, injuries, quotes, results, news, source URLs, database IDs, repository URLs, or deployment URLs. Missing data must display UNAVAILABLE. Demo/seed data, if any, must be explicitly labeled DEMO DATA and never represented as current.

EVENTS: Discover/store upcoming events when practical: promotion, event name/date/timezone, venue/city/region/country/altitude, card status, main event, co-main, main card, prelims, early prelims, bout order, weight class, rounds, championship status. Support manual corrections and change detection for replacement/cancellation/missed weight/weight-class change/odds movement/injury/withdrawal/venue change; material changes make prior analysis stale.

FIGHTERS: Persistent normalized fighter profiles with aliases/source IDs, DOB/age, nationality, fighting-out-of, team/coaches, height/reach/stance, weight-class history, pro and UFC records, fight history/opponents/events/outcomes/methods/rounds/times, raw statistics, derived metrics, structured style traits, evidence, model observations, and analyst notes. Resolve identities across sources and avoid duplicates.

FIGHT ANALYSIS: Use available quantitative factors including recent form, opponent quality/strength of schedule, age/height/reach/stance/weight class/weigh-ins/missed weight, significant strikes landed/absorbed, accuracy/defense/differential/pace, knockdowns, takedown attempts/accuracy/defense, control time, submission attempts, finish/KO/submission/decision rates, durability/cardio, pace by round, late-round decline, five-round/championship-round experience. Represent style factors including pressure/counters/boxing/kickboxing/low kicks/body attacks/range/movement/guard/clinch/offensive and defensive wrestling/chain wrestling/reactive takedowns/cage wrestling/top control/scrambling/guard/submissions/get-ups/strength/explosiveness/athleticism/speed/power/composure/discipline/fight IQ/adaptability/predictability. Contextual claims such as camp changes, injuries, layoffs, short notice, travel, altitude, weight cut, career trajectory, confidence/motivation/title implications/interviews/coaches/training reporting require provenance or must be labeled inference.

DERIVED METRICS: Calculate useful deterministic or transparent derived metrics such as recent-form score, opponent-strength-adjusted performance, striking differential/efficiency/defense/damage efficiency, knockdown rate, durability, takedown pressure, wrestling effectiveness/defense, grappling/control/submission threat, cardio/pace trend, finishing threat, decision reliability, comeback/early/late danger, consistency, volatility, and performance against elite opposition. Use configurable recency weighting.

MATCHUP ENGINE: Analyze Fighter A against Fighter B, not independent rankings. Explicitly model interactions such as wrestler vs takedown defense, pressure vs low-output countering, power vs durability, kicker vs leg-kick vulnerability, range/height, grappler vs positional defense, cardio vs late decline, stance interaction, and clinch/cage dynamics. Every fight should expose both fighters' advantages, contested areas, likely geography/tactical plans, paths to victory/defeat, assumptions, unknowns, key variables, and invalidation risks.

PROBABILITY MODELS: Estimate A/B win probability plus KO/TKO, submission, decision, goes-distance and does-not-go-distance; optionally fighter-specific methods/rounds when evidence supports it. Store raw/final probability, confidence, uncertainty interval, evidence completeness, market probability and edge. Do not claim fake precision. Produce six meaningfully different perspectives: statistical, style-matchup, recent-form, market-value, risk-adjusted, and composite. Each returns pick, probability, confidence, reasoning, edge, and suggested wager or NO BET. Show model agreement/disagreement.

ODDS & VALUE: Store timestamped current public odds snapshots without overwriting history. Support American/decimal odds, implied probability, no-vig probability, best line, market average, opening/current line, movement, retrieval timestamp and stale-line detection. Never present stale odds as current. Deterministically calculate decimal payout, expected value, expected return %, edge %, break-even probability, and uncertainty-adjusted edge. Distinguish likely winner from good wager at current price. Classify value as strong/moderate/small/neutral/negative/avoid/insufficient information; NO BET should be common.

PARLAYS: Functional parlay engine with target payout profiles about 2x/5x/10x/100x (not guarantees), hypothetical stake, desired multiplier, max legs, minimum confidence/edge, allowed bet types, excluded fights/fighters. Calculate combined decimal/American odds, market implied probability, model-estimated combined probability, EV, payout and profit. Consider confidence, EV, uncertainty, correlation, volatility, overlapping assumptions and method volatility. Generate portfolios such as safest positive-EV, balanced, aggressive, long shot, highest-confidence, highest-EV. Clearly distinguish payout from probability of success.

BANKROLL: Hypothetical bankroll tools only; support flat units, fractional Kelly and confidence-weighted sizing, conservative fractional Kelly by default. Show units, bankroll %, max loss and projected EV. Never connect to bank/financial/sportsbook accounts.

RESEARCH: Every fight has a research feed with title, summary, source, URL, publication/retrieval dates, fighter/fight/event associations, category, reliability and extracted claims. Categories include injury/training/camp/interview/strategy/weigh-in/travel/replacement/retirement/career/statistics/performance/odds/matchup. Important claims must trace to evidence.

FRESHNESS & PIPELINE: Track last-updated timestamps for events/fighters/news/odds/analysis; flag stale data and allow refresh/reanalysis. Implement a refresh pipeline: discover events -> fights -> resolve fighters -> fighter data/history/stats -> research -> current odds -> normalize -> derive metrics -> matchup analysis -> probabilities -> value -> recommendations -> parlays -> persist. Stage/source failures degrade gracefully and are recorded.

DATABASE: Real normalized D1 schema with relationships/indexes for at least events, fights, fighters, aliases, source IDs, fight history, statistics, derived metrics, style traits, research items/sources, odds snapshots, analysis runs, model outputs, recommendations, parlays, parlay legs, analyst notes, settings, and pipeline runs/errors.

API: Real validated API routes for events/event details, fights/fight details, fighters/fighter details, odds, research, analysis, recommendations, parlays, notes, settings, refresh operations, pipeline status, health, and deterministic calculation utilities. Never expose secrets in frontend JavaScript.

CALCULATION ENGINE: Do not rely entirely on an LLM for numbers. Implement deterministic American<->decimal odds, implied probability, no-vig probability, EV/expected return/break-even, parlay odds/payout, Kelly/fractional Kelly, weighted scores and practical uncertainty calculations. Clearly distinguish raw data, derived data, deterministic calculations, heuristic scores, AI qualitative analysis, and final composite analysis.

UI: Polished responsive desktop/mobile interface, not an engineering console. Dashboard: next event, countdown, fights analyzed, strongest edges, highest-confidence picks, largest line movement, material changes, stale warnings. Event page: full card including prelims, odds, model picks/disagreement/confidence/EV/recommendations and sortable ranking. Fight page: side-by-side fighters, physical stats, performance trends, style matchup, script/geography, probabilities/methods, odds/movement/EV, model disagreement, evidence/citations and notes. Fighter page: profile/history/trends/metrics/style/research/notes. Parlay builder: target payout/stake/constraints/legs/candidates/combined odds/probability/EV/payout. Research page with filters. Settings for model weights, recency, min edge/confidence, fractional Kelly and refresh behavior. Use useful comparison/probability/odds movement/disagreement/uncertainty visualizations.

TESTING & VALIDATION: Include meaningful automated tests for odds conversions, implied/no-vig probability, EV, parlay odds/payout, Kelly sizing, fighter normalization/identity, derived metrics, model calculations, API validation/database operations, and important frontend behavior where practical. The production app and an important API endpoint must be live-validated. Do not claim PASS for anything not actually tested.

The finished application must be substantial enough to serve as the primary interface for UFC/MMA event research, fighter comparison, matchup analysis, probability analysis, current betting-market value analysis, and mathematically analyzed parlay construction.`;

async function ensureFullPromptTable(env: RuntimeEnv): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_full_prompts (
    project_id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`).run();
}

async function storeFullPrompt(env: RuntimeEnv, projectId: string, prompt: string): Promise<void> {
  if (!env.DB || !projectId || !prompt.trim()) return;
  await ensureFullPromptTable(env);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO project_full_prompts (project_id, prompt, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`)
    .bind(projectId, prompt, now).run();
  await env.DB.prepare('UPDATE projects SET prompt = ?, updated_at = ? WHERE id = ?')
    .bind(prompt, now, projectId).run();
}

async function restoreFullPrompt(env: RuntimeEnv, projectId: string): Promise<void> {
  if (!env.DB || !projectId) return;
  await ensureFullPromptTable(env);
  const row = await env.DB.prepare('SELECT prompt FROM project_full_prompts WHERE project_id = ?')
    .bind(projectId).first<{ prompt?: string }>();
  if (row?.prompt) {
    await env.DB.prepare('UPDATE projects SET prompt = ? WHERE id = ?').bind(row.prompt, projectId).run();
  }
}

async function recoverLegacySmartGamblerPrompt(env: RuntimeEnv): Promise<void> {
  if (!env.DB) return;
  await ensureFullPromptTable(env);
  const candidates = await env.DB.prepare(`SELECT id, prompt FROM projects
    WHERE lower(name) = 'mma gambling app'
      AND prompt LIKE 'Build a comprehensive production-grade full-stack MMA fight-analysis%'
      AND length(prompt) <= 4000`).all<{ id: string; prompt: string }>();
  for (const project of candidates.results || []) {
    await storeFullPrompt(env, project.id, SMARTGAMBLER_RECOVERY_PROMPT);
    console.warn(JSON.stringify({ event: 'legacy_smartgambler_prompt_recovered', projectId: project.id, previousLength: project.prompt?.length || 0, recoveredLength: SMARTGAMBLER_RECOVERY_PROMPT.length }));
  }
}

async function capturePromptBeforeDispatch(request: Request): Promise<CapturedPrompt | null> {
  if (request.method !== 'POST') return null;
  const url = new URL(request.url);
  const direct = url.pathname.match(/^\/projects\/([0-9a-f-]{36})\/(build|reject)$/);
  const create = url.pathname === '/projects';
  const duplicate = /^\/projects\/[0-9a-f-]{36}\/duplicate$/.test(url.pathname);
  if (!direct && !create && !duplicate) return null;

  try {
    const body = await request.clone().json() as { prompt?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) return null;
    return {
      prompt,
      projectId: direct?.[1],
      deriveIdFromResponse: create || duplicate,
    };
  } catch {
    return null;
  }
}

async function finishPromptCapture(captured: CapturedPrompt | null, response: Response, env: RuntimeEnv): Promise<void> {
  if (!captured) return;
  let projectId = captured.projectId || '';
  if (captured.deriveIdFromResponse && response.ok) {
    try {
      const body = await response.clone().json() as { project?: { id?: string } };
      projectId = body.project?.id || projectId;
    } catch {}
  }
  if (projectId) await storeFullPrompt(env, projectId, captured.prompt);
}

const entry = import('./entry-hardening');

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/projects')) {
      try { await recoverLegacySmartGamblerPrompt(env); } catch (error) {
        console.warn(JSON.stringify({ event: 'legacy_prompt_recovery_failed', reason: error instanceof Error ? error.message : String(error) }));
      }
    }

    const captured = await capturePromptBeforeDispatch(request);
    if (captured?.projectId) {
      try { await storeFullPrompt(env, captured.projectId, captured.prompt); } catch {}
    }

    const module = await entry;
    const response = await module.default.fetch(request, env as never);
    try {
      await finishPromptCapture(captured, response, env);
    } catch (error) {
      console.warn(JSON.stringify({ event: 'outer_full_prompt_capture_failed', reason: error instanceof Error ? error.message : String(error) }));
    }
    return response;
  },

  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    try {
      for (const message of batch.messages) {
        const body = message.body as BuildQueueBody;
        if (!body?.projectId) continue;
        if (typeof body.prompt === 'string' && body.prompt.trim()) {
          await storeFullPrompt(env, body.projectId, body.prompt);
        } else {
          await restoreFullPrompt(env, body.projectId);
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'outer_full_prompt_restore_failed', reason: error instanceof Error ? error.message : String(error) }));
    }
    const module = await entry;
    return module.default.queue(batch as never, env as never);
  },
};