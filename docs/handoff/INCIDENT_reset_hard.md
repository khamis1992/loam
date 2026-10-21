# INCIDENT: git reset --hard reverted Codex/ZCode uncommitted changes (2026-10-21 ~06:13 Asia/Qatar)

## What happened
During a merge pass, several worktree merges broke tsc. To return to the last known-good commit (cea1d0c), the executor ran `git reset --hard cea1d0c` in the MAIN repo. That command reverts ALL tracked working-tree modifications - including Codex/ZCode's PRE-EXISTING UNCOMMITTED edits, which were never staged and therefore have no git-object backup.

## Files reverted (Codex/ZCode uncommitted work lost on disk)
- src/setup/runtime.ts
- src/server/companionGateway.ts
- src/tools/companionTeamTools.ts
- scripts/stt_server.py
- docs/companions-frontier-progress.md
- docs/evidence/fair-comparison.json
(src/scripts/check-*.ts were modified too; untracked ?? files like serviceBridgeTools.ts/serviceGapTools.ts were NOT affected - reset only touches tracked files.)

## Recovery
- NOT recoverable via git (unstaged -> not in object DB), no stash, no Cursor/Code local history entry, no .orig/.bak.
- The `codex` process is still RUNNING. BEST RECOVERY: have Codex re-apply / re-save its changes to these files from its session before anything overwrites them. Do this ASAP.
- These files are currently at their committed (cea1d0c) state and have NOT been touched again by the executor.

## Repo state after incident (safe/known-good)
- HEAD = cea1d0c, 24 feature merges intact, `npx tsc --noEmit` = 0.
- Watchdog is STOPPED and NOT restarted (to avoid further automated changes until this is resolved).
- OpenCode serve 4096 UP; Loam backend UP.

## Remaining work (do NOT use git reset --hard again)
12 worktrees still to merge: br, d1, mf7, o2, o3, v2, w1, w3, wsd, wss, wsv, wsx. Merge each via OpenCode resolver that handles BOTH union conflicts AND resulting tsc errors (e.g. br's src/server/routes/browserLive.ts imports ../config.js and ../log.js which do not exist in manus-parity). After each: verify git show --stat has NO protected file, tsc=0, then remove worktree.