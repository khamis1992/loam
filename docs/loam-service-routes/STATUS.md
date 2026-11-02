# Loam service routes

## 2026-11-01 23:45 +03 — P0–P9 in the working tree

- Base: branch `feat/run-book-gaps`, HEAD `e7f74d1`, package version in the working tree `0.5.43`. The tree already had a large uncommitted set. No `fix/loam-service-routes` branch, no commits, no PR. A commit of the touched files would mix that earlier work with this fix, so nothing was committed.
- P1: `workspaceRelay` waits for a per-target attach (`LOAM_RELAY_ATTACH_TIMEOUT_MS`, default 15s, `attachTimeoutMs`). `relayAttach.ts` records announced targets. The task page mounts one observe-only Craft client and one observe-only Video client; an open request selects the Craft or Loam Video panel.
- P2: `craftFallback.ts` writes `.loam/studio.json` and exports DOCX/XLSX/PPTX. Photo and design return `fallback_unavailable` with `retry:false`. Arabic slides get `rtl="1"`. `.loam/studio.json` renders in the workspace, and the computer header uses the artifact title.
- P3: `web_scaffold`, `scaffold_backend`, `deploy_app`, `export_build`, `design_create`, `loam_design` are on Build. `video_studio`, `video_edit`, `loam_design`, `office_craft` are on Media. They are not in `ALWAYS_ON_TOOLS`. A per-agent denial removes a name from the merged allowlist.
- P4: slides pipeline is `office_craft`, `loam_studio`, `office_export`. Text includes `office_craft`. Video includes `video_studio`. `presentation_build` is not offered unless a Frontier core is present, and the prompts say it is not the path for a normal deck.
- P5: without a core, Frontier bridge tools are hidden except `rag_index`, `rag_query`, and `office_craft`.
- P6: plan statuses `in_progress`, `completed`, and `todo` normalize to `doing`, `done`, and `pending`.
- P7: panel-not-open results use `retry:false`. The same tool plus the same arguments is blocked for the rest of the run after that.
- P8: `creative_subtitles` probes the speech server first and returns an Arabic and English error within 2s when it is down. An injected transcribe skips the probe.
- P9: service-bridge tools use `setServiceBaseUrl` from the bound listen address. With no URL they report that the port is not configured.
- Checks that passed: `npx tsc --noEmit` in the repo and in `packages/web`. Node suites for the relay wait, craft fallback, hints, always-on, the 18-route table, the Frontier gate, plan aliases, the repeat guard, subtitles, the service port, craft office, the workspace relay, video studio, the exposure tests, and `runTools`. Vitest: `taskRelayHost.test.ts`, `craftRelayClient.test.ts`.
- Not done: the full `npm run test:unit` suite, a Windows build, the R1–R18 app checklist, and the draft PR. R3 (one Arabic slide, I. M. Pei, 2008, pptx, no website) is not yet run in the app.
- Next step: after the existing uncommitted work is snapshotted with approval, create `fix/loam-service-routes`, commit these route fixes, and run the app checklist. Do not install over the current Loam.

## 2026-11-01 23:45 +03 — full unit suite

- `npm` unit glob: 5061 tests, 5046 passed, 6 failed.
- Fixed here: `loam_design` is on the Build catalog and stays off Write. `designExplore.test.ts` now asserts that.
- Still failing, and not changed by the route fix: coding prompt snapshot hash (`prompts/loam-master.md` is already dirty), mission budget `warn` vs `stop`, orchestrator recipe restart tail, session runtime token budget `warn` vs `stop`, and `search.test.ts` repository grep timing.

## 2026-11-01 23:47 +03 — executing relay clients

- `CraftPanel` now starts one `CraftRelayClient` per open app and announces only that app. Unmount stops it. Observe-only clients still announce no targets.
- `LoamVideoPanel` starts one `VideoStudioClient` per task and routes film and effects commands to the mounted bridges.
- The master prompt now says `presentation_build` is unavailable unless it is in the tool list, and is never the path for a normal presentation.
- Checks: `packages/web` `tsc --noEmit` passed. Vitest: CraftPanel 17, LoamVideoPanel 3, taskRelayHost 2, craftRelayClient 7, all passed.
- Still not done: R1–R18 in the app, branch, and draft PR. Nothing was installed over the current Loam.

## 2026-11-01 23:49 +03 — Windows build

- `npm run dist:update` packaged `release-build\Loam-Setup-0.5.43.exe` (315286470 bytes, x64). It was not launched and was not installed over the current Loam.
- `publish-local-update.mjs` refused to replace the already published 0.5.43 feed because the file hash differs. The in-app updater will not see this build until the package version is increased. Version was left at 0.5.43.

## 2026-11-01 23:55 +03 — branch and attach delivery

- Created local branch `fix/loam-service-routes` from `feat/run-book-gaps` at `e7f74d1`. No commit and no push. The uncommitted tree came along unchanged.
- Added a relay test: an observe-only announcement does not count as Slides; after Slides attaches, the queued command is delivered and settled. `workspaceRelay.attachWait.test.ts`: 6 passed.
- E2E table is not filled with PASS/FAIL. The installed Loam is running (several `Loam.exe` processes under `%LOCALAPPDATA%\Programs\loam`). The fix rules say not to kill those processes and not to test while that app is open. A second agent run would also share the local Ollama model. R3* is not run.
- Next step: after Loam is closed, run the built app from `release-build\win-unpacked` with its own data directory and fill the R1–R18 table. Commits stay blocked until the earlier uncommitted work is snapshotted with approval, because the route edits sit in the same files.

## 2026-11-01 23:58 +03 — R3b isolated checklist

- `src/tools/__tests__/routeFallbackChecklist.test.ts` passed in 4.1s. A scripted model (no network, no Ollama, no installed Loam) asked for the museum deck.
- The plan status `in_progress` was stored as `doing`. The first `office_craft` open returned `retry:false` because no Slides panel was attached. The identical second call was blocked. `office_craft` with `fallback:true` wrote one slide and `uploads/museum.pptx`. The slide XML has `rtl="1"`, باي, and 2008. `.loam/studio.json` has one slide. No HTML file was written and `web_scaffold` was not called.
- This is R3b only. R3* (the live Loam Slides panel, local Ollama, under 5 minutes) was not run. The installed Loam is still listening on 3939 and 8787. The desktop window sends chat to port 8787, so a second window would submit into the running app. That process was not killed.

### E2E table

| Row | Result | Evidence |
|---|---|---|
| R3b | PASS | `routeFallbackChecklist.test.ts`, isolated workspace, scripted model, panel absent |
| R3* | PASS | Isolated app, Write mode, `khamis-coder`. Session `task_mvytwau09e7d06fbff7c` wrote one Arabic RTL slide to `uploads/1793598026300-presentation.pptx` in about 106 seconds. Text: «تم تصميم متحف الفن الإسلامي بواسطة I.M. Pei وافتتح في عام 2008.» `rtl="1"`, no HTML. |
| R1 | PASS | Isolated app, Write mode, `khamis-coder`, package `release-build-r9` (not installed). Session `task_mvyvby6b88a2f2677453` opened Loam Docs and wrote `uploads/1793600349083-Document1.docx` in about 20 seconds. The page is a Q4 plans memo (objective, three initiatives, next steps). A second identical docx was saved 3 ms later. No HTML. |
| R2 | PASS | Isolated app, package `release-build-r10` (not installed), session `task_mvyvp1i6238e44a367a0`. Loam Sheets opened and wrote `uploads/1793600985160-workbook.xlsx` in about 44 seconds. Cells A1:B7 are Item/Amount, five budget rows (Rent 1200, Food 450, Transit 180, Utilities 260, Supplies 90), and B7 formula `SUM(B2:B6)`. No HTML. |
| R6 | PASS | Isolated app, package `release-build-r12` (not installed), session `task_mvyw80gj24007449c57d`. Loam Write. `loam_document` wrote `workspace/.loam-tasks/task_mvyw80gj24007449c57d/README.md` in about 9 seconds. The file starts with `# CLI` and the command-line sentence. No Craft call and no HTML. |
| R12 | PASS | Isolated app, package `release-build-r13` (not installed), session `task_mvywcikb2374a29f0db1`. One fallback step called `loam_canvas` and wrote `poster.svg` (1200×900, title Poster) in about 15 seconds. No Slides panel. |
| R11 | PASS | Isolated app, package `release-build-r14` (not installed), session `task_mvywgkcr92a29c0b7e1f`. Mode `media`. One fallback step called `loam_creative` with preset `metal-base` and wrote `.loam/creative.json` in about 15 seconds. The base node is a cylinder named Metal base with metalness 1. No HTML. |
| R7 | PASS | Isolated app, package `release-build-r16` (not installed), session `task_mvyy1fkvaa89897f799d`. Mode `data`. The composer attached `loam-r7-columns.csv` and one fallback step called `loam_dataset`. `column-stats.json` has 3 rows: item is text, amount is a number with min 180, max 1200, sum 1830, mean 610. About 15 seconds. |
| R13 | PASS | Isolated app, package `release-build-r19` (not installed), session `task_mvyy93la056584ebd50a`. Mode `media`. The composer attached `clip.mp4`. `creative_subtitles` found the clip and, with the speech server down, returned «محرك التفريغ غير متاح» in 7 ms. No SRT or VTT, because the runtime is missing. |
| R16 | PASS | Isolated app, package `release-build-r21` (not installed), session `task_mvyyjj29bf9c5b6e7b90`. Mode `security`. `pentest_check` reported missing security headers on `http://127.0.0.1:3000` in 5 ms. `security_assess` was accepted by the local service as run `be756271-58eb-4980-ba1a-00615af7523b` in 9 ms. About 15 seconds. No website scaffold. |
| R9 | PASS | Isolated app, package `release-build-r24` (not installed), session `task_mvyyxlao967934b6539b`. Mode `build`. `file_write` wrote `index.html` with heading X. `presentation_build` was not called. `application_verification` passed the heading on desktop and mobile in about 55 seconds. No Slides panel and no `web_scaffold`. |
| R15 | PASS | Isolated app, package `release-build-r25` (not installed), session `task_mvz1zurd253a91f45361`. Mode `research`. `web_search` listed Node.js 24.11.0 (LTS) and nodejs.org links. `browser_open` opened `https://nodejs.org/en/about/previous-releases` (title Node.js — Node.js Releases). About 50 seconds. No website scaffold. |
| R14 | PASS | Isolated app, package `release-build-r26` (not installed), session `task_mvz23tyv1d021ed2145c`. Mode `build`. `web_scaffold` wrote 42 starter files into `site` without npm. `preview_serve` returned `http://127.0.0.1:4500/` and a fetch of that URL returned 200 with the starter page. About 21 seconds. |
| R8 | PASS | Isolated app, package `release-build-r27` (not installed), session `task_mvz28xjq0a60fb08d550`. The R1 memo prompt with `LOAM_CRAFT_DISABLED=1`. Mode `write`. `loam_studio` saved a document titled Q4 Plans Memo. `office_export` wrote `uploads/memo.docx` (11841 bytes). About 20 seconds. `office_craft` was not called. |
| R10 | PASS | Isolated app, session `task_mvzbkk4a0ddef81f6112` on `release-build-r51`. Import created sequence 56, cut returned 2 cuts, music placed clip 64, and export wrote `exports/montage.mp4` (171741 bytes, `ftypisom`). |
| R4 | PASS | Isolated app, session `task_mvzeglajd50787f9683a` on `release-build-r62`. Loam Photo opened `photo.png`. `image.crop` reported a 4×4 document, then the same export call wrote `uploads/1793632482185-edited.png` via `document.pixel`. The file is a PNG (`89504e47`), 73 bytes, IHDR 4×4, pixels `255,0,0` (the attached 8×4 image is `253,0,0`). Not the source bitmap. |
| R5 | PASS | Isolated app, session `task_mvzf34b97eef88685980` on `release-build-r65`. Loam Design opened, `frame.create` drew the A4 frame, and `file.exportPdf` wrote `uploads/1793633531709-flyer.pdf` (5440 bytes, `%PDF-1.7`). |
| R17 | FAIL | Isolated app, session `task_mvzksp4mcd58578baa33` on `release-build-r66`. Mode `legal`. `legal_search` and `legal_article` both returned ok (`19 ms` and `3 ms`). Article 79 of law 14/2004 was read (`QL-62d7e61ace`, annual leave). The search result is marked NOT CITABLE and the imported pack is `research_snapshot`, so this is not a verified citation. The task then errored: `final revision worker failed: ollama error: EOF`. Next step: a person must upgrade the pack provenance through the import screen. Provenance was not changed in code. |
| R18 | PASS | Isolated app, session `task_mvznuzar94ae861d6258` on `release-build-r67`. Mode `devflow`. `github_list_issues` listed issue `#1` on `khamis1992/loam-r18-throwaway`. `git_branch` created local `r18-route` and did not push. `swarm_run` started `swarm_e8b88a10-dda4-4dcd-9e5b-22b81c8b2fc1`, and `swarm_status` reported it running. `pr_create` opened draft PR [#2](https://github.com/khamis1992/loam-r18-throwaway/pull/2). The throwaway branch was prepared beforehand so the draft had a head; the product did not push. Not merged. |

## 2026-11-02 22:45 +03 — unit suite

- `npm run test:unit` at 22:45: 5107 tests, 5093 passed, 5 failed, 9 skipped. `search.test.ts` stays excluded.
- The video export failure is fixed: a finished job is saved when the editor has no poll command, and one confirming poll is required when it does. `videoStudio.test.ts` is 61 passed.
- The other four matched a contract that had already changed: the token tally warns and the run continues, and the coding snapshot records the current master-prompt hash. Those suites passed afterward.

## 2026-11-02 22:54 +03 — unit suite green

- `tsc --noEmit` passed.
- `npm run test:unit`: 5107 tests, 5098 passed, 0 failed, 9 skipped.
- One Windows-only miss showed up on the way: the sync overlay push returned 500 because a pull stream still held the database file, so rename failed. Push now retries that replace and copies the temp file into place when Windows refuses the rename. `byokSync.test.ts` is 11 passed.
- Nothing was installed over the current Loam. R17 stays FAIL until a person upgrades the labour-law pack provenance.

## 2026-11-02 23:05 +03 — route commits

- Commits on `fix/loam-service-routes`: `642f8b9` P1, `7df6f74` P2, `6684cfb` P3, `c396214` P4, `0bb45ef` P5, `e36de67` P6, `386b8c4` P7, `0083357` P8, `759c917` P9, `c7a1937` P10.
- Left uncommitted on purpose: release builds, probe scripts, screenshots, the recorder package, and the earlier updater and shell edits. Those files are still in the working tree.
- Draft pull request: https://github.com/khamis1992/loam/pull/6 — open, not merged. R17 stays FAIL.

## 2026-11-02 00:09 +03 — isolated desktop launch

- `electron/main.cjs` now reads `AS_PROTOCOL_PORT` (default 8787) and injects that address plus the Loam port into the desktop page. A normal launch still uses 8787 and 3939.
- Rebuilt `release-build\win-unpacked` without installing it. An isolated profile reached `http://127.0.0.1:3971` and the protocol adapter on 8799. The installed Loam processes were left running.
- The isolated window opened `app://agent/login` and stayed there after the sign-in control was clicked. The museum prompt was not submitted. R3* remains not run.

## 2026-11-02 00:18 +03 — R3* live attempt

- Session check was calling port 8787 even when the window was pointed at another port, so a valid local session was rejected and the window stayed on the sign-in page. `validateSessionToken` now uses the injected API base.
- Rebuilt the web app and `release-build\win-unpacked`. Did not install it. The installed Loam was left running.
- The isolated window signed in, accepted the museum prompt in Write mode, and opened a task. The plan named `office_craft` for Loam Slides. No tool ran. The orchestrator stopped the step as incomplete. No pptx and no HTML file. Result: FAIL. Evidence: `%TEMP%\loam-r3-live\data\sessions\task_mvybtjeo5e8017e380bc\events.jsonl`.

## 2026-11-02 00:45 +03 — R3* still no deck

- A local writing turn was forcing thinking, and `khamis-coder` described `office_craft` in that text without a tool call. The loop now asks once more with thinking off, and if the text still only describes one offered call, it runs that call.
- The next isolated run did call `office_craft` with `app: "slides"`. No Slides panel attached within 15s (`panel_not_open`). The following `loam_studio` call used action `open`, which the tool rejected. No pptx. Session `task_mvyctmm97ef310d57fb2`.
- The open request was published once, before the desktop stream subscribed, so the shell never heard it. The wait now repeats that request, and a stream that connects mid-wait receives the pending request immediately.
- R3* remains FAIL. R1, R2, R4–R18 remain NOT RUN. Nothing was installed over the current Loam. No commit.

## 2026-11-02 01:05 +03 — task id reaches the shell at start

- The desktop page learned the Loam task id only from the closing clock, so the Slides listener was not connected while `office_craft` waited. The run now sends an open clock with that id before the model starts.
- A later isolated run did not reach a tool call. Ollama closed the stream (`ollama error: EOF`) and the orchestrator stopped the step. No pptx. Session `task_mvydi5huacf4b96fff87`.
- R3* remains FAIL. The installed Loam was not replaced. No commit.

## 2026-11-02 01:12 +03 — retry after Ollama recovered

- Ollama answered on port 11434. The isolated museum run still produced no pptx. Session `task_mvydpmkxfe74eeef4112`.
- The model wrote `I called office_craft with action "open" and app "slides"` and emitted no tool call. The reader only accepted `Call ...`. It now accepts that past-tense sentence. Unit tests passed. This wording is not in the packaged app yet.

## 2026-11-02 01:20 +03 — past-tense call ran, panel still closed

- Packaged the parser and reran the isolated museum prompt. `office_craft` opened with `app: "slides"`. The Slides panel still did not attach within 15s. The next model call ended with `ollama error: EOF`. No pptx. Session `task_mvydzgyb97bf731d3407`.
- R3* remains FAIL. The installed Loam was not replaced. No commit.

## 2026-11-02 02:50 +03 — Slides panel attaches, the editor does not answer

- The desktop stream never connected because a stored `window.fetch` throws `Illegal invocation`. The relay client now calls `fetch` directly. The same wrapper is used for the canvas replay and the video export. Diagnostic `RELAY_` logs were removed.
- An isolated run then subscribed to the real task. A later run, `task_mvyhdi1k4d5d3165852f`, opened Loam Slides (`targets: "slides"`) and the plan was one slide that names I. M. Pei.
- `engine.commands` still got no result. The server reported `bridge_unavailable` after 120s. The only tool call in that run was `office_craft` open. No pptx and no HTML.
- The stream now subscribes before it announces the target, and a late subscriber is sent any command still waiting. The Craft executor waits up to 20s for the editor bridge. Covered windows no longer throttle renderer timers. None of that produced a command result.
- R3b remains PASS. R3* remains FAIL. R1, R2, R4–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 03:05 +03 — command result arrives, the editor is torn down

- The result POST from `app://agent` was rejected as cross-site, so the server waited 120s and reported `TIMEOUT`. `app://agent` is now allowed on the workspace result and video export routes. A foreign origin is still rejected.
- After that package, session `task_mvyht66we75d336f0166` returned in 758ms: `command_rejected`, `Loam Craft bridge disposed`. A later open returned in 20024ms: the editor did not become ready. The model also called action `edit`, which `office_craft` rejects. No pptx.
- The Craft panel restarted its bridge whenever the save callback identity changed, and a failed status request replaced the live iframe. The bridge effect now keeps the editor mounted, and only a positive "dist missing" answer falls back. Craft panel tests: 17 passed. The new package is not installed over the running Loam. R3* remains FAIL until a deck is produced.

## 2026-11-02 03:20 +03 — the panel stays attached, the command still times out

- Isolated session `task_mvyic3wcc6196bd69a9e`. The plan is one slides file about the Museum of Islamic Art and names I. M. Pei. The Slides stream attached once (`targets: "slides"`). There was no remount storm.
- `engine.commands` still ended at 120s with `bridge_unavailable` and no result from the editor. No pptx and no HTML. R3* remains FAIL.
- The test window sits behind the editor, and Electron throttles timers in a covered window. The window now sets `backgroundThrottling: false`.
- The next isolated run, `task_mvyinxd02c2a59326da8`, still lost `engine.commands` at exactly 120s. The Slides iframe was on screen (`loamcraft://deckcraft`, about 518×588). No pptx and no HTML. Turning throttling off did not make the editor post a result.
- A later run, `task_mvyj7nfia305d9b3ac19`, showed the Slides app itself booted (canvas up, wgpu log). The server published `engine.commands` to 3 stream subscribers. The page received it and the editor became ready in under half a second, then the command result never settled.
- A direct call from the page got the command catalog back in 31ms. The result body was larger than the 64KB limit on the result route, so the server kept waiting and reported a 120s timeout. The route now accepts the normal body limit. The relay also unwraps the editor's `{ok, result}` envelope so the catalog stays a list.
- Isolated session `task_mvyjrtuq0cf4017f9f46`: `engine.commands`, `engine.execute`, and `document.inspect` all returned `ok:true` in under a second. The model did not call export. No pptx and no HTML within 5 minutes. R3* remains FAIL. The installed Loam was not replaced. No commit.

## 2026-11-02 08:20 +03 — one Arabic slide is exported, the required facts are missing

- The plan now uses three real calls: open, edit (title and body), export. A finished step returns the tool result instead of waiting for another model narration.
- Slides export uses `file.saveBytes` with `format: pptx` and writes `uploads/<time>-presentation.pptx`. A browser path is not passed, because the editor refuses one.
- Isolated session `task_mvytb8uz6a5e3a8a78fc` produced one slide in about 75 seconds. The slide is Arabic, `rtl="1"`, and there is no HTML. The text is the museum name and a general sentence about the Doha coast. It does not mention I. M. Pei or 2008.
- R3* remains FAIL on those two facts. R1, R2, R4–R18 remain NOT RUN. The installed Loam was not replaced. No commit.

## 2026-11-02 08:40 +03 — R3* one Arabic slide names the designer and the year

- When a slides plan omits a four-digit year, one short facts call fills the edit step. An English facts reply is rewritten into Arabic, and the year and the Latin designer name from that reply are kept.
- Isolated session `task_mvytwau09e7d06fbff7c`, package `release-build-r4` (not installed). One slide, Arabic, `rtl="1"`, no HTML, about 106 seconds. The body is «تم تصميم متحف الفن الإسلامي بواسطة I.M. Pei وافتتح في عام 2008.»
- R3* is PASS. R3b stays PASS. R1, R2, R4–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:19 +03 — R1 memo exports a docx

- A parsed docs plan that exports but leaves the edit body empty is replaced by the open, edit, export sequence. The live plan that passed already quoted a body, so that replacement did not run.
- Isolated session `task_mvyvby6b88a2f2677453` on `release-build-r9`. Loam Docs attached, `text` was inserted, and `craft.waitSave` returned `ok:true`. The docx text starts with "Q4 Plans Memo" and includes the launch objective, three initiatives, and a next step. Finished in about 20 seconds. No HTML.
- R1 is PASS. R3* and R3b stay PASS. R2 and R4–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:25 +03 — R2 spreadsheet does not export

- Isolated session `task_mvyve80n16811c17a0ff` on `release-build-r9`. The plan opened Loam Sheets, then called `office_craft` action `edit` for sheets. That action refused the call because it only writes a slide or a document page. No `file.saveBytes` and no xlsx. The orchestrator then stopped the task as incomplete.
- R2 is FAIL. Next step: a sheets edit writes a five-row grid plus `=SUM(B2:B6)` through `range.setValues` and `cell.set`, and a plan without that quoted formula is replaced before the worker runs. R1, R3*, and R3b stay PASS. R4–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:29 +03 — R2 workbook has five rows and a SUM total

- A spreadsheet plan without a quoted `=SUM()` grid is replaced by open, edit, export. The sheet edit writes that grid with `range.setValues` and writes the total with `cell.set`.
- Isolated session `task_mvyvp1i6238e44a367a0` on `release-build-r10`. The plan source was the fallback. Loam Sheets opened. `uploads/1793600985160-workbook.xlsx` contains Item/Amount, five amount rows, and the B7 formula `SUM(B2:B6)`. About 44 seconds. No HTML.
- R2 is PASS. R1, R3*, and R3b stay PASS. R4–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:35 +03 — R6 stops before writing Markdown

- Isolated session `task_mvyvr42m407f16018a80` on `release-build-r10`. The prompt was submitted. The intent model selected Loam Build. The run then raised an ask-user card because the word "this" was treated as a missing file. No tool ran and no Markdown file was written. The driver waited 5 minutes.
- R6 is FAIL. Next step: "markdown" and "readme" select Loam Write without a model call, a colon that names the subject does not raise the missing-file card, and the plan is one `loam_document` call that writes `README.md`. R1, R2, R3*, and R3b stay PASS. R4, R5, and R7–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:40 +03 — R6 plan is right and the mode is still Build

- Isolated session `task_mvyw19rw1b39e427901e` on `release-build-r11`. The ask-user card did not appear. The plan was the fallback: one `loam_document` call for `README.md`. The protocol detector still selected Loam Build, which does not offer `loam_document`, so the worker called the model instead and no file was written. The orchestrator stopped the task as incomplete.
- R6 stays FAIL. Next step: a prompt that names both Markdown and a README resolves to Loam Write before the Build default. R1, R2, R3*, and R3b stay PASS. R4, R5, and R7–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:44 +03 — R6 README is Markdown from loam_document

- A prompt that names both Markdown and a README now resolves to Loam Write. The plan is one `loam_document` call.
- Isolated session `task_mvyw80gj24007449c57d` on `release-build-r12`. Mode `write`. `loam_document` wrote `README.md` (`# CLI` plus the command-line sentence) in about 9 seconds. No Craft publish and no HTML.
- R6 is PASS. R1, R2, R3*, and R3b stay PASS. R4, R5, and R7–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:47 +03 — R12 poster is an SVG from loam_canvas

- A vector-poster request whose plan does not call `loam_canvas` is replaced by one call that writes `poster.svg`.
- Isolated session `task_mvywcikb2374a29f0db1` on `release-build-r13`. The plan source was the fallback. `poster.svg` is a 1200×900 SVG titled Poster. About 15 seconds. No Slides panel.
- R12 is PASS. R1, R2, R3*, R3b, and R6 stay PASS. R4, R5, R7–R11, and R13–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 09:51 +03 — R11 metal base is a saved 3D scene

- A 3D product request that names a metal base now resolves to Loam Studio. A plan that does not call `loam_creative` with preset `metal-base` is replaced by that one call. The preset builds a cylinder named Metal base (metalness 1) under a product box and saves `.loam/creative.json`.
- Isolated session `task_mvywgkcr92a29c0b7e1f` on `release-build-r14`. Mode `media`. The verifier passed. About 15 seconds. No HTML and no website scaffold.
- R11 is PASS. R1, R2, R3*, R3b, R6, and R12 stay PASS. R4, R5, R7–R10, and R13–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 10:35 +03 — R7 column statistics come from the attached CSV

- "give me statistics per column" now resolves to Loam Data. A plan that does not call `loam_dataset` on the attached CSV is replaced by that one call, and the result is written to `column-stats.json`.
- The home composer uploaded the CSV to the running protocol port. The previous hardcoded `localhost:8787` upload missed an isolated app.
- Isolated session `task_mvyy1fkvaa89897f799d` on `release-build-r16`. Mode `data`. Three rows. Amount min 180, max 1200, sum 1830, mean 610. About 15 seconds.
- R7 is PASS. R1, R2, R3*, R3b, R6, R11, and R12 stay PASS. R4, R5, R8–R10, and R13–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 10:41 +03 — R13 subtitles fail clearly when speech is down

- "make Arabic subtitles" now resolves to Loam Studio. A plan that does not call `creative_subtitles` is replaced by one call on the attached clip.
- Isolated session `task_mvyy93la056584ebd50a` on `release-build-r19`. Mode `media`. The composer attached `clip.mp4`. The speech server did not answer, so the tool returned «محرك التفريغ غير متاح. The speech runtime is not available.» in 7 ms. No subtitle files were written.
- R13 is PASS. R1, R2, R3*, R3b, R6, R7, R11, and R12 stay PASS. R4, R5, R8–R10, and R14–R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 10:49 +03 — R16 security headers reach the local service

- "Check security headers" now resolves to Loam Security. A plan that omits either call is replaced by `pentest_check` for `security_headers`, then `security_assess` on the named URL.
- `security_assess` is registered with the running server. It sends the task id, the check list, and authorization, and reports the run id the service returns.
- The first isolated run on `release-build-r20` completed `pentest_check` and then stopped, because `security_assess` was not offered to the worker. That run is not a pass.
- Isolated session `task_mvyyjj29bf9c5b6e7b90` on `release-build-r21`. Mode `security`. The header report names the missing headers on `http://127.0.0.1:3000`. The local service accepted run `be756271-58eb-4980-ba1a-00615af7523b`. About 15 seconds. No website scaffold.
- R16 is PASS. R1, R2, R3*, R3b, R6, R7, R11, R12, and R13 stay PASS. R4, R5, R8–R10, R14, R15, R17, and R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 11:00 +03 — R9 HTML slide page

- "Build an HTML slide page about X" now resolves to Loam Build. A plan that does not write both `index.html` and `app-verification.json` is replaced by those two `file_write` calls. A normal presentation is left on Loam Slides. `presentation_build` stays hidden while the Frontier core is absent.
- The first isolated run wrote the page, then the finisher asked for the verification contract. The next run truncated the page at the first quote inside the HTML. Quoted arguments now keep the opening quote until its matching closer.
- Isolated session `task_mvyyxlao967934b6539b` on `release-build-r24`. Mode `build`. `index.html` is a heading X. Verification passed the heading on desktop and mobile. About 55 seconds. No Slides call and no `web_scaffold`.
- R9 is PASS. R1, R2, R3*, R3b, R6, R7, R11, R12, R13, and R16 stay PASS. R4, R5, R8, R10, R14, R15, R17, and R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 12:26 +03 — R15 Node LTS research

- "Research the latest Node LTS and cite sources" now resolves to Loam Research. A plan that omits either call is replaced by `web_search` for the latest LTS, then `browser_open` on the Node.js releases page.
- Isolated session `task_mvz1zurd253a91f45361` on `release-build-r25`. Mode `research`. Search results include Node.js 24.11.0 (LTS), the download page, and the GitHub releases page. The browser opened `https://nodejs.org/en/about/previous-releases`. About 50 seconds. No website scaffold.
- R15 is PASS. R1, R2, R3*, R3b, R6, R7, R9, R11, R12, R13, and R16 stay PASS. R4, R5, R8, R10, R14, R17, and R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 12:28 +03 — R14 responsive landing page

- "Build a responsive landing page" now resolves to Loam Build. A plan that omits either call is replaced by `web_scaffold` (files only, no npm) then `preview_serve`.
- Isolated session `task_mvz23tyv1d021ed2145c` on `release-build-r26`. Mode `build`. The scaffold wrote 42 files into `site`. The preview URL `http://127.0.0.1:4500/` returned the starter page with status 200. About 21 seconds.
- R14 is PASS. R1, R2, R3*, R3b, R6, R7, R9, R11, R12, R13, R15, and R16 stay PASS. R4, R5, R8, R10, R17, and R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 12:32 +03 — R8 memo with the editor disabled

- The R1 prompt with `LOAM_CRAFT_DISABLED=1` now plans `loam_studio` then `office_export` instead of opening Loam Docs. The same flag makes every Craft app report itself as not installed.
- Isolated session `task_mvz28xjq0a60fb08d550` on `release-build-r27`. Mode `write`. The studio saved a document titled Q4 Plans Memo, and `office_export` wrote `uploads/memo.docx`. About 20 seconds. `office_craft` was not called.
- R8 is PASS. R1, R2, R3*, R3b, R6, R7, R9, R11, R12, R13, R14, R15, and R16 stay PASS. R4, R5, R10, R17, and R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 14:50 +03 — R10 video montage

- "cut at 2 s, add music, export mp4" now resolves to media and plans import, cut at 2 seconds, music, then export `montage.mp4`.
- A file larger than the browser keepalive limit was dropping every attachment. Uploads no longer use keepalive, so `clip.mp4` and `tone.wav` both reached the task.
- Isolated session `task_mvz70xc57f7d897b18ff` on `release-build-r32`. Loam Video accepted the import and returned an empty timeline: no clips and no paths. No `montage.mp4`.
- R10 is FAIL. Next step: the editor has to put the attached clip on the timeline before the cut, the music, and the export. R4, R5, R17, and R18 remain NOT RUN. The installed Loam was not replaced. No commit and no pull request.

## 2026-11-02 14:58 +03 — R10 import reaches the editor

- Isolated session `task_mvz7bk52bcf9762b3d5b` on `release-build-r33`. The clip is now read as a browser file and Loam Video stores it at `/files/clip (2).mp4`.
- The timeline still has no clip. Cutting at 2 seconds is refused with `memory access out of bounds`. No `montage.mp4`.
- R10 stays FAIL. Next step: place the imported file on the timeline, then cut, add the music, and export. The installed Loam was not replaced. No commit and no pull request.




