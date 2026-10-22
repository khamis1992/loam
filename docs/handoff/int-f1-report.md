# int-f1 Handoff Report

Backend fixes for mode routing telemetry, detection hardening, mode prompts, and brief rendering.

## Commit

```text
int-f1: mode telemetry, hardened detection, brief fix, dedicated-tool hints
f5c7585
```

## Files Changed (all owned or required by the type change)

- `src/eval/types.ts` – added `kind: "mode"` and mode-only optional fields to `TelemetryRecord`.
- `src/telemetry/store.ts` – skipped usage/token aggregation for `kind === "mode"` records.
- `src/protocol/socket.ts` – appends a mode telemetry record after `resolveLoamMode`; fixed the history-rebuild `toolUsed` brief so empty args produce `""` instead of the raw tool name.
- `src/protocol/events.ts` – `makeBrief()` now returns only the argument detail (path/command/query/url/target) with no leading verb, and `""` for unknown tools or empty args.
- `src/modes/detect.ts` – hardened keyword rules with word boundaries and added required synonyms.
- `src/modes/catalog.ts` – appended dedicated-tool guidance to the `outputHint` for `write`, `data`, `media`, `security`, and `research` modes.
- `src/protocol/__tests__/resolve-mode.ts` – added coverage for the requested detection cases.

## What was done

1. **Mode telemetry** (`src/protocol/socket.ts`)
   - Right after `const resolvedMode = resolveLoamMode(um, prompt)`, the socket appends a `kind: "mode"` telemetry record via `appendTelemetry()`.
   - Record includes: `at`, `taskId`, `mode`, `toolset` (from `getLoamMode(resolvedMode).tools`), `dedicatedTools` (subset matching `office_*`, `loam_document`, `loam_studio`, `loam_creative`, `loam_canvas`, `loam_dataset`, `data_chart`, `pentest_*`, `security_*`, `browser_*`, `web_search`), and `source` (`explicit` when a valid `extData.loamMode` is supplied, otherwise `detected`).
   - `src/eval/types.ts` added `kind: "mode"` plus the mode fields as optional keys. Existing task/eval-case fields remain required so unrelated consumers (`src/eval/export.ts`, `src/server/http.ts`, `src/scripts/check-eval.ts`) do not need edits; mode rows fill neutral values for those required fields.
   - `src/telemetry/store.ts` `telemetrySummary()` now ignores mode rows when aggregating token/tool usage.

2. **Hardened detection** (`src/modes/detect.ts`)
   - All single-token rules now use `\b...\b` word boundaries to avoid partial matches (e.g. `app` inside `application`).
   - Added the requested synonyms:
     - **write**: powerpoint, pptx, slides, deck, presentation, word, docx, doc, memo, letter, report, resume, cv
     - **data**: excel, xlsx, spreadsheet, sheet, csv, chart, graph, pivot, dataset, data analysis
     - **media**: video, mp4, ffmpeg, trim, clip, image, png, logo, svg, poster, design, thumbnail, icon, banner
     - **security**: pentest, vulnerability, security scan, port scan, tls, ssl, headers, nmap, cve
     - **research**: search the web, web search, look up, research, find information, browse, open <url>, http://, https://, scrape, navigate website
     - **build**: build, app, website, program, code, implement, component
   - Preserved offline/synchronous operation.
   - Updated unit tests in `src/protocol/__tests__/resolve-mode.ts` for: pptx→write, video trim→media, excel bar chart→data, port/vulnerability scan→security, open https→research, web search→research, build web app→build.

3. **Mode prompts** (`src/modes/catalog.ts`)
   - Appended explicit dedicated-tool instructions to the `outputHint` of each mode:
     - write: use `loam_document/loam_studio` for `.docx/.pptx`; don't shell out for office files unless a tool is missing.
     - data: use `loam_dataset/loam_studio/data_chart` for spreadsheets and charts.
     - media: use `loam_creative/loam_canvas` for video/image/design.
     - security: use `pentest_*/security_*` tools.
     - research: use `web_search` and `browser_*` tools.
   - Note: the actual system-prompt assembly appears to live in protected files (`src/server/http.ts` / `src/tools/frontierBridge.ts`), so `outputHint` carries the guidance data but the final prompt injection is not owned by int-f1.

4. **Brief fix** (`src/protocol/events.ts` and `src/protocol/socket.ts`)
   - `makeBrief()` now returns only the argument detail:
     - `shell_*` / `pty_*`: the command string (truncated to 60 chars) or `""`.
     - `file_read` / `file_write` / `file_edit`: the `path` or `""`.
     - `web_search`: the query string (or joined array) or `""`.
     - `web_fetch`: the `url` or `""`.
     - `browser_*`: the `url`/`target` or `""`.
     - Everything else: `""`.
   - In `src/protocol/socket.ts`, the history-rebuild path at the end of a run now computes the brief and explicitly replaces it with `""` when it equals the raw tool name.

## Follow-up fix: protocol adapter write-method proxy

Additional commit: `2f9eba4 int-f1: proxy write methods through protocol adapter`

- File: `src/protocol/adapter.ts`.
- Problem: the pass-through proxy to the Loam server on port 3939 only handled `GET /api/*`, so `POST /api/agents` and `PUT /api/agents/:id` (companion create/edit) fell through and returned 404.
- Fix: extended the proxy condition to accept `POST`, `PUT`, `PATCH`, and `DELETE` for paths starting with `/api/` (still excluding `/api/health`). For write methods the incoming request body is now piped into the proxy request via `req.pipe(proxyReq)`. `GET` and `DELETE` keep the existing no-body behavior (`proxyReq.end()`). Existing forwarding of request headers (authorization, content-type, x-loam-local-token, etc.) is preserved.

## Verification

- `npx tsc --noEmit -p .` – 0 errors.
- `npx tsx src/protocol/__tests__/resolve-mode.ts` – PASS.
- `npx tsx src/protocol/__tests__/run.ts` – PASS.
- No web changes, so `npm --prefix packages/web run build` was not required.

## Notes / Gaps

- The per-mode system prompt is likely assembled in `src/server/http.ts` or `src/tools/frontierBridge.ts`, which are outside int-f1 ownership. `src/modes/catalog.ts` `outputHint` now contains the guidance, but if the prompt builder does not include `outputHint`, the dedicated-tool instructions will not reach the model.
- `data_chart` is referenced in the data-mode prompt but is not currently in the mode's `tools` array (`loam_dataset/loam_studio` only). It is, however, included in the telemetry `dedicatedTools` filter as requested.
- Mode telemetry rows fill the required task/eval-case scalar fields with neutral values so the type change does not cascade into unrelated files.
