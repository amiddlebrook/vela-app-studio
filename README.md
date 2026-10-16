# Vela App Studio

**Cloudflare-native automation studio** with a service catalog, directed links, explicit permissions, free-first AI reasoning and persisted run history.

**Production:** https://vela-control-plane.averymiddlebrook2014.workers.dev  
**Health:** https://vela-control-plane.averymiddlebrook2014.workers.dev/health

## Architecture

- Cloudflare Worker — production dashboard, HTTP API, automations and scheduled tasks. Deployed entry point: src/mesh-entry.ts from wrangler.jsonc.
- Cloudflare D1 — workspaces, connector settings, encrypted credentials, links and run history.
- Workers AI — native model with a daily free allocation; the automatic model uses Workers AI first and an optional OpenRouter model ending in :free second.
- Queues and SQLite-backed Durable Objects — existing app-build orchestration, both available in free allocations.
- GitHub Actions — pull request validation and deployment plus smoke tests on main.
- Production UI — src/mesh-runtime.ts enhanced by src/mesh-polish.ts. The separate Next.js app/ directory is a legacy prototype and **not** the deployed dashboard.

## Free-tier policy

The core infrastructure does not require payment when used within Cloudflare Workers Free, D1, Queues, Durable Objects and Workers AI allowances. Free use is quota-limited, not unlimited. Vela mesh does not invoke paid AI models. You can configure other AI connections separately, but these are not part of free mesh execution. External third-party services may have their own prices or limits and are entirely optional.

**Security:** Existing workspaces use anonymous signed cookies; this is not full user authentication. Do **not** expose a shared public deployment with powerful integrated API credentials. Protect personal installations with an access-control layer before storing live credentials. By default new links Observe and Analyze; external Create, Modify and Execute need explicit authorization, with a further confirmation before a write-enabled run.

## Local development

Requirements: Node.js 22+ and npm.

~~~bash
npm ci
npx wrangler d1 migrations apply vela-control-plane --local
npm run dev
npm run verify:mesh
~~~

The dev command runs the real Cloudflare Worker through Wrangler. To preview the old Next.js prototype, run npm run dev:legacy.

## Deploy to your own free Cloudflare account

1. Create the D1 database and Queue. Replace existing owner-specific account, database ID, APP_ORIGIN and workers.dev subdomain entries in wrangler.jsonc with your Cloudflare resources.
2. Create two long, independent runtime secrets SESSION_SECRET and TOKEN_ENCRYPTION_KEY. Keep them stable between deployments so existing sessions and stored credentials remain usable.
3. Add GitHub Actions repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Scope the token to only what the deployment requires. OPENROUTER_API_KEY is **optional** and only usable for a free :free model.
4. Deploy with npx wrangler deploy, or push to main to use .github/workflows/deploy.yml. That workflow provisions missing runtime secrets, reconciles D1 migrations, deploys and tests the endpoints.

The existing wrangler.jsonc resource IDs refer to the original owner's Cloudflare deployment, not resources that a new account can reuse.

## How to use

1. Open the Studio and allow the /session endpoint to initialize an anonymous workspace.
2. Click services to authorize or configure them; Workers AI is ready without another key. Most vendor integrations require separate access.
3. Enter a goal. For the public crawler, include a public HTTPS URL in the goal.
4. Select two ready nodes to make a directed connection. Observe and Analyze are preview-only by default.
5. Run the mesh and review Activity. A processed link can be *prepared-only* when the destination lacks permission or a configured target; inspect the run events before treating it as delivered.

## CI and validation

- Pull requests run source contract tests, parse the dashboard scripts and perform a Wrangler dry-run.
- Changes to main deploy the Cloudflare Worker, update D1 schema and smoke-test /health, /, /ai, /session, /connections and /mesh/state.
- To run source checks: npm run verify:mesh.

## Current limitations

This is a personal engineering-stage studio, not a secure multi-tenant SaaS. Some vendor cards are adapter placeholders unless a provider credential, endpoint and supported operation are configured. External integrations can require payment. Workers Free has daily request, CPU and AI quotas; exceeding them stops requests rather than guaranteeing limitless usage. Background workflows and external APIs may also hit their own rate limits.
