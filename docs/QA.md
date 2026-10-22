# QA plan: Manus parity for Loam

This document describes how the rebuild is verified against `docs/BUILD_SPEC.md`.
It is owned by **A10 (Wide Research + QA/e2e + integration)**.

## 1. Verification commands

| Command | Purpose |
|---|---|
| `npx tsc --noEmit` | Typecheck the whole workspace (root `tsconfig.json`). |
| `npx playwright test` | Run the Playwright `_electron` suite in `packages/web/e2e/specs`. |
| `npm run build:server` | Build the Loam server bundle (A9). |
| `cd packages/web && npm run build` | Build the Next.js static export (A3/A4). |

## 2. Unit coverage (§12.1)

Owned by the implementing agents; A10 audits that the following are covered:

- `bucketOf()` boundary cases (midnight, DST, 7/30 days).
- `t()` interpolation, `{product}` substitution, missing-key fallback, `tRich` tags.
- `chatSlice`: dedupe by id, ordering, `toolUsed` status transitions by `actionId`.
- IPC registry: unknown ns/method rejected, bad sender rejected, zod failures typed.
- Folder grants: inside/outside/symlink escape/`..` traversal; one-shot grant expires after use.
- Login: nonce mismatch → `loginFailed`; exchange failure → `token_exchange_failed`.
- `map_reduce`: 20-item fan-out respects concurrency limit and returns collected results.
- Spec aliases: `terminal`, `text_editor`, `search`, `webpage_extract`, `browser`, `plan`, `message`, `suggestion`, `idle` schemas validate and dispatch to Loam tools.

## 3. E2E suite (§12.2)

All specs live in `packages/web/e2e/specs` and use the `_electron` fixture in `packages/web/e2e/harness`.

| Spec | Scenario |
|---|---|
| `login.spec.ts` | Click **Sign in** → simulate deep link `agentstudio://auth/callback?token&nonce` → lands on `/app` with the sidebar visible. |
| `task.spec.ts` | Type a prompt and press Enter → new sidebar row → events render (plan step, streamed result, **Task completed**) → follow-up suggestions. |
| `stop.spec.ts` | Start a task → click stop → client sends `stop_session` → UI shows **{product} stopped — send message to continue**. |
| `upload.spec.ts` | Paste a text file → card shows kind/size → 3-step upload against mock → attachment in `user_message`. |
| `replay.spec.ts` | Kill socket mid-run → reconnect → no duplicates, no gaps. |
| `mycomputer.spec.ts` | Add folder → request outside folder → ApprovalCard → Allow once → second request asks again → Always allow → no further prompt. |
| `rtl.spec.ts` | Switch to **العربية** → `dir=rtl`, sidebar on the right, strings match §5.8 ar column. |
| `updater.spec.ts` | Inject updater states → popover strings per §5.6. |

## 4. Visual checklist (§12.3)

Run `npx tsx packages/web/e2e/harness/visualCheck.ts` after packaging the app and starting the mock server.
It captures every screen in `packages/web/e2e/visual/{light,dark}/{en,ar}/`. A reviewer compares each shot
against the descriptions in BUILD_SPEC.md §5.9 and ticks the checklist below.

- [ ] Top bar: 40px row on Windows, 48px var on macOS; traffic-light inset 80px on macOS; drag region works; buttons not draggable.
- [ ] Sidebar is 240px wide. Rows are 32px (compact) with radius 10 and padding-inline 6/2px; active row background `rgba(55,53,47,.04)`. Section headers 32px.
- [ ] Composer: 768px max width, radius 22px, 1px #e5e7eb border, shadow `0 12px 32px rgba(0,0,0,.02)`. Context bar above; footer with + / connectors / Approve for me / mic / send.
- [ ] Placeholders: home "Assign a task or type / for more"; in task "Message {product}"; with file "Tell {product} what to do with the file".
- [ ] User bubble: white, radius `12px 12px 4px`, padding 6×10, 14/21. Assistant text 14/22, no bubble.
- [ ] "✓ Task completed" in #25ba3b; "Worked for Ns ›" in #737373; star rating row; follow-up rows with →.
- [ ] Running state: "{name} is thinking" with dots, "● Working" strip, round stop button replaces send. Stopped state copy and strip.
- [ ] Buttons: 32/36/40px heights, radius 8, weight 500; focus ring visible.
- [ ] Settings dialog 1024×756, radius 16, `shadow-menu`, bg `--background-gray-main`; nav groups as §5.5.
- [ ] Search dialog 680×440, radius 20. Account menu items and Sign out in red.
- [ ] Home cards: radius 12, padding 12, translucent fill, hover fill.
- [ ] Type scale matches §4.3 (spot-check `.text-headline-base` 24/30, weight 590).
- [ ] Dark mode: every surface uses `.dark` tokens (gray-main #1a1a1a, menu-white #242424, nav #1f1f1f, text #e6e6e6). No hard-coded hex values in components.
- [ ] Loading: skeleton placeholders per page (§5.9 S11).
- [ ] RTL: no physical `left/right/ml/mr/pl/pr` classes; direction-implying icons mirrored.
- [ ] Arabic text uses Noto Sans Arabic; numbers stay Western digits unless locale formats otherwise.
- [ ] Compact density (`data-interface-density=compact`) uses 32px rows; standard uses 36px.
- [ ] Activity indicator panel is transparent; only its cards are clickable.

## 5. Build and integration checks

Before declaring phase 3 complete, A10 runs on the merged `manus-parity` branch:

```bash
npx tsc --noEmit
npm run build:server
cd packages/web && npm run build
cd packages/desktop && npm run typecheck && npm run dist:local
npx playwright test
```

## 6. Known limitations / handoff notes

- The original agent backend is not reproduced; the rebuild runs against Loam's orchestrator wrapped by the protocol adapter (A1).
- Store-installed builds report `Updates are managed by the app store.` and never show the update popover (§5.9 S21).
- Browser password/cookie import from other browsers is deliberately out of scope (§10.6).
- Out-of-MVP screens (agents, automation, skills, library, websites, plugins, presenter, screen-live, phone, email, billing) are stubs showing **Coming soon**.

## 7. Tool-specific QA

### map_reduce (§8.5)

Acceptance: a 20-item research fan-out works; concurrency never exceeds 20; each child returns a result.

```bash
npx tsx -e "
import { buildRuntime } from './src/setup/runtime.js';
import { createSpecAliasTools } from './src/tools/specAliases.js';
const rt = await buildRuntime(loadConfig());
const aliases = createSpecAliasTools({ registry: rt.registry, ollama: rt.ollama });
const mr = aliases.find(t => t.name === 'map_reduce');
console.assert(mr, 'map_reduce missing');
console.log(JSON.stringify(mr!.parameters, null, 2));
"
```

### Spec aliases (§8.5.1)

Acceptance: the §8.5.1 schemas validate and dispatch to Loam native tools.

| Spec name | Loam dispatch |
|---|---|
| `terminal` | `shell_start`, `shell_write`, `shell_read`, `shell_kill`, `shell_run` |
| `text_editor` | `file_read`, `file_write`, `file_edit`, `file_search` |
| `search` | `web_search` |
| `webpage_extract` | `web_fetch` |
| `browser` | `browser_open`, `browser_goto`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_eval`, `browser_screenshot`, `browser_close`, `browser_act` |
| `plan` | emits Loam `plan` + `plan_step` events |
| `message` | emits Loam `assistant_message`; `ask` also emits `approval_required` |
| `suggestion` | returns follow-up commands array |
| `idle` | no-op success |

## 8. Reporting

After the run, update `docs/handoff/a10-report.md` with:

- What was implemented.
- Verification results (pass/fail per command).
- Blockers or follow-ups for other agents.
- Screenshots captured by the visual checklist runner.
