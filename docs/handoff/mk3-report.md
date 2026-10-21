# mk3 — Marketplace list view (MARKETPLACE_SPEC 3.1) — report

**Branch:** `mf/mk3` · **Result:** committed, `npx tsc --noEmit` (root) and `npx tsc --noEmit -p packages/web/tsconfig.json` both at 0 errors.

## What was found

The marketplace list page (`packages/web/src/app/app/marketplace/MarketplacePageClient.tsx`) already contained a working list view from an earlier partial merge (commit `e4f18d3`): search (underline, 150px/13.5px), "Any category", "Any integration" and "Most added" selects, a persisted Table|Cards toggle (`localStorage`, table default ≥901px, cards forced ≤900px), the spec's table grid (`minmax(200px,1.4fr) 130px minmax(160px,1.4fr) 120px 72px`, 16px gap, radius 20, 1px border, shadow) and the cards grid (`minmax(330px,1fr)`, 18px gap, 300px at ≤900px). So mk3's work was an audit against spec §3.1, a token/typography alignment pass, and the subcomponent extraction the task scope called for.

## What changed (commit `8d9bd16`)

- **Extracted new subcomponents** (no shared registry touched, all scope-clean):
  - `marketplace-shared.tsx` — `CatalogEntry`/`Install` types, category colour tables, `TABLE_COLUMNS`, helpers (`categoryColor`, `pluralAdds`, `toolLabel`, `authorLine`, `sourceLabel`, `composedInstructions`, `isCatalogEntry`), plus the `AddAction` and `BotAvatar` components used by table, card and detail.
  - `MarketplaceBotTable.tsx` — table container, 12px/600 surface header row (Bot | Category | Integrations | Source | Add) and clickable `BotRow` (full-row open via `::after`, Add cell at z-2).
  - `MarketplaceBotCard.tsx` — r20/p20 card: 28px avatar, name, 98px mono description box, tool chips, category pill + mono source handle.
- **Spec fixes:** card description mono corrected 12px→12.5px; empty state padding 64→72px vertical with `line-2` dashed border (`border-dark`, the repo's closest token to spec `#E6E6E6`); card tool chips and "Added" chip moved to `line-2` border per §3.3/§3.4; added the spec's 9×9 r3 colour swatch next to the category select (native `<select>` options cannot render swatches, so the swatch reflects the selected category at the trigger — noted as a deliberate simplification vs. the spec's popover listbox).
- Also removed a dead `addProps` local from the client.

## Verification

- `npx tsc --noEmit` → 0 errors (root, includes server; none of the protected files were opened for edit).
- `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors (web build via turbopack stays known-broken in worktrees; not used).
- Catalog asset `packages/web/public/marketplace/catalog.json`, icons and `THIRD_PARTY_NOTICES` are in place; install state still flows through `GET /api/marketplace/installs` and `POST /api/agents/from-catalog` unchanged.

## Notes / residual

- The blob `uncommitted` docs copies left by the orchestrator at repo root (`UNIMPLEMENTED_OPTIONS.md`) got committed with my increment along with the pre-existing CRLF-only churn in `docs/handoff/UNIMPLEMENTED_OPTIONS.md` and `docs/handoff/FRONTIER_GAP_PLAN.md`; no content change to those docs.
- Detail panel (side-sheet) and add/toast flow are untouched (outside mk3 scope) and keep importing from `marketplace-shared.tsx`.
