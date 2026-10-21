# mk4 report — Marketplace licensing + attribution (MARKETPLACE_SPEC §5)

Branch `mf/mk4` (worktree mk4) added the licensing/attribution layer for the Bots
Marketplace on top of the existing page. `packages/web/public/marketplace/THIRD_PARTY_NOTICES`
now carries the botdirectory.ai MIT license text (Copyright (c) 2026 Inbox Zero Inc.)
plus an explicit **"BUILD NOTE — internal only"** section stating that x.ai
marketplace content is internal-only (collected under spec §5 option (a)), must not
ship bundled in a public build (which must use option (b)), and that x.ai share-link
configs stay linked, never rehosted; per-entry botdirectory attribution
(contributor + source URL + MIT) and x.ai attribution (creator + source URL +
"all rights reserved") are rendered in the detail panel's Source section. A new
reusable unit `packages/web/src/app/app/marketplace/attribution.ts` (`buildAttribution`,
`NOTICES_PATH`) normalizes a catalog entry into structred per-source attribution
(contributor/profile URL, listing URL, short license line, addHref, internalOnly
flag), `EntryAttribution.tsx` renders the whole Source section from it — including
the new "Internal build only" line that links to the bundled notices file — and
`MarketplacePageClient.tsx` now renders `<EntryAttribution entry={entry} />` instead
of inline JSX. New UI string is translated in `i18n/en.json` + `i18n/ar.json`, and
`attribution.test.ts` (vitest, 5 tests passing) covers botdirectory/x.ai/merged
entries and anonymous fallbacks. Verified `npx tsc --noEmit` (root) and
`npx tsc --noEmit -p packages/web/tsconfig.json` both clean; commits: 63f8377
(notices build note), b5a003d (util + component), c28b939 (i18n), 0b34d02 (tests).

Follow-up session (same scope): the marketplace footer's x.ai licensing sentence
was wrapped with `t()` and added to `i18n/en.json` + `i18n/ar.json` for full
parity (commit 841363a); the orchestrator-provided root reference copy
`UNIMPLEMENTED_OPTIONS.md` was committed as an untracked-cleanup checkpoint
(ed96e78). Final state: both tsc checks clean, 5/5 vitest tests pass, nothing
uncommitted.
