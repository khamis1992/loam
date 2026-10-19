# Self-planning: surface plan — revision 63

The first section-17 increment: «بناء خطة بحسب نوع التطبيق وسطحه» — an advisory planning engine that derives a suggested checklist from a finished assessment's own evidence.

## What it does

`src/security/planning.ts` — `buildPlan(run)` is a **pure read** of the finished run's evidence (discovered pages, OpenAPI operations, source routes/risks, cross-file flows) producing a `CampaignPlan`:

- **Surface classification** — the application is typed by the surfaces actually observed: `web` (discovered pages), `api` (OpenAPI operations), `source` (routes, static risks, flows) → e.g. `web+api+source application`, each surface with its evidence counts.
- **Suggestions derived from evidence** (≤50, deduplicated), each carrying `engine`, `surface`, `target`, `rationale`, and — critically — `operatorInput`: the explicit declaration still required before anything can run:
  - discovered page → `xssReflected` case (operator picks the parameter);
  - GET OpenAPI operation → `injection` case (operator declares field + baseline);
  - non-GET operation → `openapiFlow` (with the plan's own reason it could not be auto-exercised);
  - source route → `routeVerification`; static `source_sql/nosql/html` risk → the matching dynamic engine that can confirm or refute it;
  - cross-file flow → the engine matching the sink kind, noting that static→dynamic linking will join the proofs.
- **Limitations** carried with the plan: evidence-only derivation, bounded discovery/flows, and suggestion order ≠ risk ranking (hypothesis ranking is a separate open item).

## The separation between plan and execution

Structural, not just documented: `buildPlan` cannot execute anything (pure function over finished evidence), the plan object carries `execution: "none"`, and no suggestion creates a case, an event or a request. The gate pins this: the plan-producing run must show zero auto-added injection cases and zero POSTs executed on the plan's behalf. The plan is attached to the run at finish (`run.plan`) and served read-only via `GET /api/security/assessments/:id/plan` (409 while the run is live or for pre-planning runs).

## Honest limits

- The plan sees only what this assessment's bounded engines saw — undiscovered pages, undocumented operations and unscanned files are invisible to it; a stale plan from an old run misleads as evidence ages.
- Suggestion generation is rule-per-evidence (no impact/verifiability ranking, no budgeting between engines — items 3 and 6 of section 17 remain open, as do dynamic replanning on new roles/paths and execution-decision explanations).
- Engine names reference the platform's engine families; a suggestion is a starting point for operator declarations, never a substitute for them.

## Validation

`npm run check:security-planning` runs a unit check on synthetic evidence (surface typing, no-execution marker, operator-input presence) plus a real campaign over a fixture app (a linked page, an OpenAPI GET with path fixtures, a POST the plan must flag as unexercisable, and a workspace whose source declares a route and a SQL-shaped cross-file flow): it asserts the surfaces carry real counts, the suggestions reference the actual `/search` page, `/items/{id}` GET, `POST /orders` with its reason, the `/users` source route and the `routes.js → db.js` flow, every suggestion has rationale + operator input, and the plan added no cases or requests. During development the gate caught a fixture bug (a query-bearing link is invisible to scope-bounded discovery) and a plan-shape gap (the truncated flag), both fixed. All 37 `check:security*` gates via `verify:security`, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
