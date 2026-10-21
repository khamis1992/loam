# Loam build pipeline - SHUTDOWN STATE  (2026-10-21 05:31 Asia/Qatar)

Clean shutdown checkpoint. Watchdog stopped, all OpenCode sessions aborted, all worktree dirty work committed as 'WIP: checkpoint before shutdown' (ZCode runtime.ts / companion* / check-*.ts / stt_server.py were excluded from every commit).

## Merges landed on manus-parity (HEAD=cea1d0c) - total 24
  - cea1d0c merge mf/mf4: approval rules + idempotent replay (MF4)
  - c493296 merge mf/o4
  - 08e80ca merge mf/px
  - 5e3b8cc merge mf/cr1
  - 109950a merge mf/v4
  - 1d2b246 merge mf/auth: P0 session persistence fix
  - 232c40a merge mf/w2: backend scaffold generator (W2)
  - 19fefe3 merge mf/mf9: group chats + Members tab (MF9)
  - 1a9eabc merge mf/mf11: messaging channels Telegram+Email mock (MF11)
  - 348453b merge mf/mf10: shared ticket board (MF10)
  - 27650ed merge mf/r1: wide parallel research dispatcher (R1)
  - 808329f merge mf/p2: source-to-sink taint planning (P2)
  - b41cbc7 merge mf/p1: evidence-gated pentest orchestrator (P1)
  - 3a2afd2 merge mf/mkt: bots marketplace (MKT)
  - 0939303 merge mf/r2: deep research (R2)
  - f230847 merge mf/v3
  - f2a3d81 merge mf/p3
  - f162a5a merge mf/b1
  - 3ae2f58 merge mf/wsp
  - 0e9c3bf merge mf/mf8: run lease fencing (MF8)
  - c5960ea merge mf/mf6
  - a96179c merge mf/mf3
  - a99d659 merge mf/pd
  - 988d024 merge mf/mf5: server-side agent thread mapping + unread (MF5)

## Auth P0 status
- FIXED + MERGED (commit cea.. chain; merge 'mf/auth: P0 session persistence fix'). Root cause: (1) login nonce was main-process memory only -> lost on Windows agentstudio:// protocol relaunch; (2) web startup check self-wiped token on ANY transient validateSessionToken failure. Fix persists login_nonce in userData/localStorage.json and makes startup resilient. tsc 0; web rebuilt (packages/web/out). App launches cleanly to login screen (docs/handoff/qa-auth-1.png).
- RESTART-TWICE 'stays signed in' QA NOT yet done: requires a REAL sign-in via external x.ai OAuth (agentstudio://). Executor cannot use Khamis's credentials. ACTION: Khamis signs in once, then restart app twice to confirm it stays signed in. Fix notes: docs/handoff/auth-fix-notes.md.

## Worktree sessions (mf-wt\<name>, branch mf/<name>)
| worktree | commits ahead | session id | reprompt | state |
|---|---|---|---|---|
| br | 3 | ses_ea3f8ebb2ffeP70c13vzmGmo6S | mf-wt\reprompts\br.txt | has work (3 commits) - MERGE NEXT |
| cr2 | 0 | ses_ea3b739edffeOcjsgI6V5942co | mf-wt\reprompts\cr2.txt | no commits - re-run |
| d1 | 3 | ses_ea3eda2deffenTRNEU3kT7rjzj | mf-wt\reprompts\d1.txt | has work (3 commits) - MERGE NEXT |
| mf4 | 0 | ses_ea3f8f0baffePmg5lUXo7K7aQy | mf-wt\reprompts\mf4.txt | no commits - re-run |
| mf7 | 8 | ses_ea3f52319ffer5AUJvbzlgLPfc | mf-wt\reprompts\mf7.txt | has work (8 commits) - MERGE NEXT |
| o2 | 5 | ses_ea3f8d592ffehJiJbEeNZmXTR2 | mf-wt\reprompts\o2.txt | has work (5 commits) - MERGE NEXT |
| o3 | 5 | ses_ea4017cdcffegZFmuO5zO4f0sQ | mf-wt\reprompts\o3.txt | has work (5 commits) - MERGE NEXT |
| opa | 0 | ses_ea3b74c3effeJusfGttaX5zLU2 | mf-wt\reprompts\opa.txt | no commits - re-run |
| opb | 0 | ses_ea3b74cdeffe9zdQ4bK2dU55BN | mf-wt\reprompts\opb.txt | no commits - re-run |
| opd | 0 | ses_ea3b74e0effelli9qoDKMp3KYi | mf-wt\reprompts\opd.txt | no commits - re-run |
| ope | 0 | ses_ea3b747c0ffeZH8hZe9uOxlK1s | mf-wt\reprompts\ope.txt | no commits - re-run |
| oph | 0 | ses_ea3b746aaffeRg7H9Ks2xFrxdA | mf-wt\reprompts\oph.txt | no commits - re-run |
| opi | 0 | ses_ea3b745f6ffeTz1hye0K7g9Hb9 | mf-wt\reprompts\opi.txt | no commits - re-run |
| sk | 0 | ses_ea3b74a13ffeO9Ecuq2XHQBUrt | mf-wt\reprompts\sk.txt | no commits - re-run |
| v2 | 3 | ses_ea3eda122ffe0J0jljtgYg6VTq | mf-wt\reprompts\v2.txt | has work (3 commits) - MERGE NEXT |
| w1 | 8 | ses_ea3f8df89ffekoq6EEHm82WFUl | mf-wt\reprompts\w1.txt | has work (8 commits) - MERGE NEXT |
| w3 | 4 | ses_ea3d8e87effe0OVBYabkgxcDVX | mf-wt\reprompts\w3.txt | has work (4 commits) - MERGE NEXT |
| wsd | 5 | ses_ea40475b9ffewVYugnF09hcFJe | mf-wt\reprompts\wsd.txt | has work (5 commits) - MERGE NEXT |
| wss | 3 | ses_ea3eda8afffefZgYNbR5Bfh4Jy | mf-wt\reprompts\wss.txt | has work (3 commits) - MERGE NEXT |
| wsv | 5 | ses_ea3f8e468ffeBwLwaMRRy5VoC7 | mf-wt\reprompts\wsv.txt | has work (5 commits) - MERGE NEXT |
| wsx | 6 | ses_ea3f51e22ffevob2DmBhIdrgyz | mf-wt\reprompts\wsx.txt | has work (6 commits) - MERGE NEXT |

## Models (standing order): Ollama (quota-exhausted now) -> OpenCode Go (opencode-go/deepseek-v4.1-flash, glm-5.3-flash, qwen3.8-flash) -> freellmapi -> ornith-1.5:9b. PEAK (no DeepSeek): 04-07 & 09-13 local.

## RESUME STEPS
1. Start opencode serve: `cmd /c "%APPDATA%\npm\opencode.cmd serve --port 4096 --hostname 127.0.0.1"` (verify http://127.0.0.1:4096/session = 200).
2. Restart Loam backend: `powershell -File docs\handoff\restart.ps1`.
3. Merge remaining worktrees that have commits (see table). For each: `git merge --no-ff mf/<name>`; resolve union conflicts via an OpenCode resolver (pattern: docs\handoff\genmerge.txt); verify git show --stat has NO src/setup/runtime.ts; npx tsc --noEmit=0; then remove worktree (rmdir node_modules junctions, git worktree remove --force, git branch -D mf/<name>).
4. Worktrees with 0 commits: re-fire original prompt from mf-wt\reprompts\<name>.txt into the worktree on a peak-safe model.
5. Relaunch watchdog: `powershell -File docs\handoff\watchdog.ps1` (peak-aware, 180 cycles; reads mf-wt\sessions.json + mf-wt\reprompts\).
6. Auth QA: Khamis signs in once, then restart the Electron app twice (`node_modules\.bin\electron.cmd . --remote-debugging-port=9333`) and screenshot via `node docs\handoff\cdp.mjs shot --out <png>` to confirm it stays signed in.
7. mf4 is already merged (cea1d0c); its worktree can be removed. Resolver sessions (mf4/mf7/wsd/wss/d1/w3 '-merge') were for conflict resolution.

## Env vars Khamis still must supply: LOAM_GITHUB_CLIENT_ID/SECRET, LOAM_GOOGLE_CLIENT_ID/SECRET (connectors), LOAM_TELEGRAM_BOT_TOKEN (channels). #8/#9 remain mock. Rust-install decision pending for true ArtCraft reuse.
