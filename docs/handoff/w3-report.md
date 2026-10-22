# W3 report — design-exploration phase + hero-image gen in build mode

## Commits (branch `mf/w3`, no push)
1. `254cde0` feat(build): design-exploration sub-phase + loam_design tool (W3)
2. `c44d789` test(w3): loam_design phase output shape with mock hero generator
3. `a2066a5` fix(w3): grant loam_design via ALWAYS_ON_TOOLS only; prompt directive test

## Files
- **New** `src/modes/buildPhases.ts` — build sub-phase config (`BUILD_SUBPHASES`: entry phase `design-explore` followed by `implement`, plus `BUILD_PHASE_PROMPT` directive).
- **New** `src/tools/designExplore.ts` — tool `loam_design` + `createDesignExploreTools({ heroGenerator? })`.
- **New** `src/tools/__tests__/designExplore.test.ts` — 10 unit tests (phase config, explore shape, determinism, count clamp, mock-hero injection, failure surfacing, effective-allowlist presence, system-prompt directive injection).
- **Localized edits** `src/server/runTools.ts` (+`loam_design` in `ALWAYS_ON_TOOLS`), `src/agent/prompt.ts` (one directive line keyed on `loam_design`), `src/index.ts` (import + one `registerAll`), `src/server/__tests__/runTools.test.ts` (register the always-on dummy).

## Tool: `loam_design` (agent tool, not an HTTP route — no route needed)
Request (`action=explore`): `{ action, brief, count? (1..3, default 3) }`
Response content (JSON string):
```json
{ "phase": "design-explore", "brief": "...", "count": 3,
  "directions": [ { "id": "quiet-clarity", "name": "Quiet Clarity",
    "concept": "...", "palette": {"background":"#faf9f5","surface":"...","foreground":"...","accent":"#9b8e3b"},
    "layout": "single-column narrative...", "heroConcept": "..." },
    { "id": "dark-foundry", ... }, { "id": "warm-editorial", ... } ] }
```
Deterministic per brief (FNV-1a hash seeds hue + layout rotation). Three original archetypes: Quiet Clarity (light minimal), Dark Foundry (dark high-contrast), Warm Editorial (cream editorial). No ArtCraft names/assets used anywhere; clean-room implementation of the behavioral spec only.

Request (`action=generate_hero`): `{ action, brief, directionId?, path?, title?, subtitle? }`
Response content (JSON string): `{ "phase": "design-hero", "direction": {"id","name"}, "palette": {...}, "path": "<directionId>-hero.svg", "title": ... }`. Failed generator → `ok:false` with the generator's message.

**Image generator injection**: `options.heroGenerator?: (args, ctx) => Promise<ToolResult>`; default is the repo's existing local image-generation tool `loam_canvas` (task-local SVG artwork, `src/tools/loam.ts:122`), injected with the direction's palette colors. Unit tests substitute a mock.

## Exposure (TOOL EXPOSURE RECIPE)
`loam_design` is low-risk (writes only task-workspace SVG) → added to `ALWAYS_ON_TOOLS` in `src/server/runTools.ts:27`; no mode-catalog entry was added deliberately: an existing test (`runTools.test.ts:108`) pins that always-on tools must NOT appear in the raw gateway allowlist. It therefore reaches every agent run across modes through `mergeAlwaysOnTools` + `registry.forAllowlist`. The system-prompt directive is injected by `src/agent/prompt.ts:76` whenever the tool is in the run's tool set: "Design phase: before writing any code, produce 2-3 design directions with loam_design ..."

## How to test live
- Unit: `npx tsx --test src/tools/__tests__/designExplore.test.ts src/server/__tests__/runTools.test.ts src/modes/__tests__/catalog.test.ts` (all green: 10 + 18 + 7).
- Real generator smoke (already run manually, passes): run the tool with `action=explore`, then `action=generate_hero` — the returned `path` is created in the task workspace.
- In an agent task: start a Loam Build task and observe the first tool call; the design-exploration directive is in the system prompt. Alternatively exercise the gateway with a prompt mentioning design exploration.

## Status
- `npx tsc --noEmit` (server): **0 errors**.
- All tests pass (`node:test` via `tsx --test`).
- Packages/web: `tsc` fails with pre-existing worktree `node_modules` gaps (`@testing-library/jest-dom`, `vitest/globals` missing; `next` not installed) — environmental, not related to this change; no web files were edited.

## Left / notes
- No HTTP route was needed; nothing to add to `src/server/http.ts`.
- The design directions are engine-side (tool) rather than a persistent UI artifact; a future task could surface explore results as a studio/canvas block.
