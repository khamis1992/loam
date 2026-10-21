# mk2 — Marketplace add flow report

## What was done

The marketplace seller spec §4 add flow is now fully live. The store module `src/server/marketplace.ts` (bundled-catalog loader, `MarketplaceInstall` SQLite state keyed by `catalog_id`, install/removal lifecycle) and the catalog asset `packages/web/public/marketplace/catalog.json` (819 entries) already existed in the branch, but **no endpoint was reachable**: `handleMarketplaceRoutes` was exported yet never dispatched. This task wired it into `src/server/http.ts` (one import + one dispatch line placed before the `/api/agents/:id` prefix catch-all, so `POST /api/agents/from-catalog` resolves to the exact-path handler), enriched `GET /api/marketplace/installs` with an `entry` projection (name, category, source, icon, tools, author, sourceUrl, license) so the UI can flip the Add button and render "Connect first" chips / Overview › Source without refetching the full catalog, and added a route-level test suite.

Spec §4 field mapping is honored by `installFromCatalog`: name with " 2"/" 3" collision suffix, `entry.description` trimmed to 300, instructions composed (botdirectory prompt body verbatim; x.ai entries built from description + `## Skills` + skills + `## Memory`, capped at 8000 chars), mode resolved from category/tools via `src/modes/detect.ts` (Engineering → `build`, Design → `media`, sheets → `data`, docs/slides → `write`, otherwise keyword detect), routines seeded **paused** (`enabled = false`, no cron — the user enables them, nothing auto-runs), memories seeded into companion memory, and a catalog-version-stamped `MarketplaceInstall`. The flow is idempotent (re-Add returns the existing agent with `already: true`); archiving the agent prunes the install so a later Add creates a fresh agent with the suffix-named title, keeping "Removing clears the Added state". Approval gates and the cathode-gated import behavior were left untouched — no imported step is ever executed automatically.

## Tests

- `src/server/__tests__/marketplace.test.ts` — 10 pass (module-level, pre-existing).
- `src/server/__tests__/marketplaceRoutes.test.ts` — 6 pass (new; add + idempotency, 404 unknown id, 400 empty body, 405 wrong method, installs-with-entry projection, catalog endpoint).
- `npx tsc --noEmit` and `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors.

## Deviations / notes

- Spec mode ids (`code/design/office/general`) don't exist in Loam; they were mapped onto the real mode catalog (`build/media/data/write` + detect fallback).
- Avatars: `AgentRecord` supports emoji only, so category emoji is used; the UI can still use `entry.icon` from the shipped asset.
- `metadata` from §4 is not denormalized onto the agent record (no metadata field on `AgentRecord`); it is joined via the installs `entry` projection instead.
- Pre-existing CRLF-only unstaged diffs on `docs/handoff/FRONTIER_GAP_PLAN.md` and `docs/handoff/UNIMPLEMENTED_OPTIONS.md` were left untouched (no content change).
