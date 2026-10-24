# Review report: `manus-parity` vs `main` (Loam / manus-local)

Reviewer: Claude (read-only review, no source files changed, nothing committed).
Date: 2026-10-24. Branch size: 825 commits, 518 files, +92,931 / -3,898.

## 0. Update after fix

Blockers F1-F8 are fixed on `manus-parity`. After the fixes: root and web typechecks clean, web vitest 786/786, server tests 3656 pass / 0 fail / 1 skipped, `check:loam-ui` passes.

- F1/F2: N11 CanvasPanel UI restored and merged with N18 (commit 3b73467); the sheet saves through `applyOp`.
- F3: the gate was stale on `main` too (8 modes, asserted 7; the full-screen mobile studio hides the journey nav). It now asserts `LOAM_MODES.length` and skips the journey-nav check for `studios/mobile`.
- F4: confirmed. `lintSiteSource` scanned inline source as `relative: "inline"`, so it never counted as an `.html` UI source. It is now `inline.html`.
- F5/F6: the Arabic reply no longer leaks "the product" (shows "المنتج"). Tests now accept the new "محاكاة السرب" wording, the `Market:` report line and read `data.report_md_path`.
- F7: the test injects a router with the effects backend unavailable, so it no longer depends on the machine.
- F8: Sparkles replaced with `Search` and `Wand2`.

F9, F10, F12, F13 are also fixed (Sparkles icons replaced everywhere, duplicate imports in `http.ts` merged, freellmapi disabled by default, `console.log` removed). F11 and F14-F17 are unchanged.

Customer-experience pass (installer 0.5.30 built and installed, sandbox smoke test, button crawl of `/app`):
- Composer toolbar now wraps at about 1280px instead of clipping.
- Home-screen "Approve for me" and "Knowledge Garden" chips did nothing; they now toggle and are sent with the task.
- Title bar Back/Forward are disabled when there is no history; the mic shows its error instead of failing silently.
- After these changes: web vitest 786/786, root and web typecheck clean, `check:loam-ui` passes. One run showed a timing flake in the 2000-message hibernation test; it passed on rerun.
- Not covered: crawl of routes other than `/app`, Arabic/RTL crawl, and the installed build does not include the Composer/TitleBar changes (rebuild needed).

Sections 1-3 below describe the state before these fixes.

## 1. Verdict

**NOT READY TO MERGE INTO MAIN.**

Type checks and builds are clean, and 99.9% of the server tests pass. But the merge dropped real functionality. The gate merges kept the N18 side of `CanvasPanel.tsx` and silently discarded the N11 "editing semantics" UI. That is why 11 CanvasPanel tests fail. It also leaves `nodeActions.ts` and `CanvasClient.applyOp` as dead code, so canvas edits are still not versioned and the agent is not told about them, which was the exact problem N11 was written to fix. On top of that, 4 server tests and the `check:loam-ui` gate fail, and the branch adds two forbidden Sparkles icons. None of this was caught because tests and gates were off during the automatic merges.

## 2. Type check, build and test results

| Check | Result |
|---|---|
| Root `npm run typecheck` | 0 errors |
| `packages/web` typecheck | 0 errors |
| `packages/web` `next build` | OK, 26 static pages |
| `npm run build:server` | OK (one esbuild warning about `require.resolve("esbuild")`, harmless) |
| `packages/web` vitest | 107 files (1 failed, 106 passed); **786 tests: 11 failed, 775 passed** |
| Server tests (`node --import tsx --test`) | 279 files; **3657 tests: 3652 pass, 4 fail, 1 skipped** |
| `npm run verify` (typecheck, encoding, docs, eval, orchestrator 114/114, recovery, modes) | passes |
| `packages/web` `verify:tokens` | OK (206 / 206 hex tokens, none missing or extra) |
| `npm run check:loam-ui` | **FAILS**: `AssertionError 8 !== 7` (`src/scripts/check-loam-ui.mjs:43`) |
| Conflict markers | none |
| litellm | not present anywhere (1.107.0 is not installed) |
| `.jdone` / `.orig` / `.rej` / `.bak` files tracked | none |
| `npm ls` | 2 extraneous packages: `@emnapi/runtime`, `@img/sharp-wasm32` |

Why the 11 CanvasPanel tests fail (OBSERVED): commit 18157f3 "N11: canvas editing semantics" added the selection UI (`canvas-node-select`, `canvas-selection-count`, `canvas-stale-count`, `canvas-sheet-cut`, `data-stale`, `data-version`) and the tests. At 18157f3 and merge e4aaa84 the file contained them (1131 and 1134 lines). Commits 6aba9b8 (778 lines), 1b333c8 (1590) and f814eed (1630) do not. The current `CanvasPanel.tsx` has none of those test ids and never imports `nodeActions.ts`.

## 3. Findings

| ID | Severity | Label | File:lines | Problem | Suggested fix |
|---|---|---|---|---|---|
| F1 | Critical | OBSERVED | `packages/web/src/components/workspace/canvas/CanvasPanel.tsx` (1630 lines; detail-sheet `save()` ~1540-1546); `__tests__/CanvasPanel.test.tsx` | N11 selection / versioning UI was dropped by the gate merges. 11 tests fail. The sheet still does a raw `onPatch({ data: { ...data, [key]: draft } })`, so edits are unversioned and the agent is not told. | Restore the N11 sections from 18157f3 and merge them with N18's code. Route the sheet save through `applyOp`. Re-run the CanvasPanel tests. |
| F2 | High | OBSERVED | `packages/web/src/components/workspace/canvas/client.ts:254` (`applyOp`); `nodeActions.ts`, `nodeText.ts` | `applyOp` (POST `/api/graph/:run/ops`) has no callers, only comments at lines 109-110. `nodeActions.ts` / `nodeText.ts` are used only by VersionPanel, KnowledgePanel, WebpageActions and a test. The server route exists, but nothing uses it. | Fixed together with F1 (wire the UI to `applyOp`). If N11 is dropped on purpose, delete the dead code and the server route. |
| F3 | High | OBSERVED | `src/scripts/check-loam-ui.mjs:43`; `ui/app.js:98` | Gate `check:loam-ui` fails: expects 7 `#homeModes button` chips, finds 8. The mode list (`state.modes`, `src/modes/catalog.ts`) and the script disagree. | Decide whether the 8th mode is intended. Then update the script, or remove the mode. |
| F4 | High | SUSPECTED | `src/tools/__tests__/designCritique.test.ts:262`; `src/design/tokenLint.ts:874-883` | Arabic page with `dir="rtl"` and `ms-4` is still reported as not RTL-ready. `rtlReadyFor` only counts `.html` files with a relative path, so a string `source` passed to `lintSiteSource` may never match. This would mean the RTL gate cannot pass for inline Arabic sources. | Check how `lintSiteSource` builds `ScannedFile` for inline source (path / extension). Fix the lint or the test. |
| F5 | Medium | OBSERVED | `src/tools/__tests__/mirofishIntent.test.ts:280` | Arabic simulation reply no longer mentions MiroFish. Reply begins "اكتملت محاكاة السرب لـ **the product**" (`src/tools/mirofish.ts:173-174`). The hard-coded fallback "the product" also leaks into an Arabic sentence. | Use the localized name in the reply, or update the test regex. Localize the fallback product name. |
| F6 | Medium | OBSERVED | `src/tools/__tests__/mirofishIntent.test.ts:332`; `src/tools/mirofish.ts:174, 212` | Test reads `.manus/mirofish/reports/<report_id>/report.md`, but the report is now written under `simulations/<sim>/report.md` (`simulation.report.paths.markdown`). ENOENT. | Make the test read `session.report_md_path`, or restore the old location. Last change to this file was "wip: capped by executor (gates off)" f8de1ca. |
| F7 | Medium | SUSPECTED | `src/tools/__tests__/videoStudio.test.ts:181`; `src/tools/videoStudioRouter.ts:~425-445` | Test expects the degraded effects request to target `film`; it got `effects`. Likely depends on the effects backend being installed on the reviewer's machine (`isEffectsBackendAvailable`). | Make the test inject an unavailable backend instead of depending on the machine. |
| F8 | Medium | OBSERVED | `packages/web/src/components/workspace/KnowledgeGardenPane.tsx:509`, `LoamVideoPanel.tsx:387, 439` | Branch adds `Sparkles` icons (forbidden). | Replace with a non-star icon from lucide-react (for example `Wand2`, `Film`, `Leaf`). |
| F9 | Low | OBSERVED | `design/page.tsx`, `PlanDialog.tsx`, `CreditsPopover.tsx`, `ModelMenu.tsx:158`, `SettingsDialog.tsx:166` (✨ glyph), `Sidebar.tsx:50`, `sheet/Editor.tsx:555` | More Sparkles icons / ✨ glyph. Probably already on `main`, so not caused by this branch. | Replace in a separate cleanup. |
| F10 | Medium | OBSERVED | `src/server/http.ts` (3124 lines; `startServer` is ~2700 lines); imports at 75, 141, 156 (`./db.js`) and 138, 151 (`../telemetry/store.js`) | Duplicate imports from the keep-both merges. Every `handle*Routes` import is called and there are no conflict markers, but the file is hard to review. | Merge the duplicate imports. Split `startServer` into route modules. |
| F11 | Low | OBSERVED | `package-lock.json` | `npm ls` reports 2 extraneous packages (`@emnapi/runtime`, `@img/sharp-wasm32`). Lock and manifest are not fully in sync. | Run `npm install` (or `npm prune`) and commit the lockfile. |
| F12 | Low | OBSERVED | `src/config.ts:388` | `TODO(C19)`: the freellmapi endpoint (`http://127.0.0.1:31415/v1`) is unverified, enabled by default. | Disable by default until confirmed, or resolve the TODO. |
| F13 | Low | OBSERVED | `electron/main.cjs:742` | `console.log("[electron] local session ready")` left in the main process. | Remove, or use the logger. |
| F14 | Low | OBSERVED | `CanvasPanel.tsx:606`, `LoamVideoPanel.tsx:193, 231`, `LessonsPanel.tsx:98`, `MemoryDebugPane.tsx:35`; `src/scripts/check-eventlog.ts:177` (`any`) | `eslint-disable` comments and one `any`. | Fix the underlying hook dependencies, or justify each. |
| F15 | Low | OBSERVED | `src/tools/envSnapshot.ts:596` | `execFileAsync(command, { shell: true, ... })`. The command comes from the project blueprint's `setup` list. It is checked by the command policy first (line ~721), so this is intended. Still a shell-injection surface if a blueprint is untrusted. | Keep the policy check as the single entry point. Add a test that a blocked command never reaches `runSetupStep`. |
| F16 | Low | OBSERVED | `src/graph/export.ts:620, 639` | `innerHTML` in the generated static replay. All interpolated text goes through `esc()`, and the `links` numbers are computed. Not exploitable as written. | No change. If more fields are added, keep using `esc()`. |
| F17 | Low | OBSERVED | `src/scripts/check-*.ts` | About 38 `console.log` calls. Almost all are in CLI check scripts, which is acceptable. | None. |

## 4. Must fix before merging (blockers)

1. **F1 and F2:** restore the dropped N11 CanvasPanel UI and wire `applyOp`. Re-run the CanvasPanel tests until all 786 web tests pass.
2. **F3:** make `check:loam-ui` pass (reconcile the 7 vs 8 mode chips).
3. **F4, F5, F6:** fix or correct the three Arabic / MiroFish / design-critique failures. They cover Arabic and RTL behavior, which the product depends on.
4. **F8:** remove the two new Sparkles icons.
5. **F7:** make the videoStudio test independent of the machine, so the 4 server failures become 0.

## 5. Can fix later

F9, F10, F11, F12, F13, F14, F15, F16, F17.

## 6. What could not be checked, and why

- **Authenticated UI smoke test.** I started the server (`npx tsx src/index.ts`, listening on port 3939). The page opened but showed "تعذّر فتح الصفحة" with 401 Unauthorized responses. The app needs a session token, which the Electron shell injects. I did not try to use stored tokens. So the main screens (canvas, tasks, modes, settings) were **not** exercised in a browser. The unauthenticated page loaded in Arabic with `dir="rtl"`, no horizontal overflow, and no Sparkles.
- **Electron (`npm run desktop`)** was not launched, and the electron tests and the Playwright e2e / visual tests were not run.
- **Individual `test:*` scripts** outside `node --test` and vitest were not run one by one.
- **Security review of every new route** (path traversal and input validation in graph ops, knowledge, shares, hibernation, events, mobile, android) was a partial pattern scan, not a line-by-line read. Of the ~518 changed files, I read the flagged ones.
- **Clipped cards and RTL layout** were not visually checked on the authenticated screens.
- **Side effects of my run.** Starting the server printed "recovery: admitted 3 queued message(s)", so it touched existing task state on this machine. Running `npm run verify` also left `src/agent/masterPromptText.ts` shown as modified. `git diff` shows no content change, only line-ending (LF / CRLF) noise. The other modified files (`docs/handoff/watchdog.ps1`, the visual baselines, `qa/10-agents-after.png`) were already uncommitted and were not touched.
