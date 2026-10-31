# sandbox-runtime (srt) → Loam — programme status

Branch label: **`srt-capability`**. Spec of record:
`docs/senior-staff-engineer/specs/SANDBOX_RUNTIME_INTO_LOAM_INTEGRATION.md`
(+ appendix C1–C10). Approved 2026-10-25.

## Landed

| Commit | Phase | What |
|---|---|---|
| `61f64e0` | SP-1 | Spec anchored with deltas appendix (C1 no-prod-dep posture, C2 flat settings keys, C3 JSONL audit, C4 opt-in MCP wrap, C5 branch/label conventions, C6 untrusted_only semantics, C7 W-checklist driving, C8 live npm verification). |
| `6bc6dab` | SP0 | Triple-hash installer (`scripts/install-srt.mjs`): registry integrity → npm pack → tarball sha256 → `--ignore-scripts --omit=dev` into `<DATA_DIR>/bin/srt/0.0.81/` → BOTH `srt-win.exe` sizes+hashes → CLI probe → pin.json. **LIVE: all three hashes verified on this PC** (one transcription typo in the tarball constant was caught by the gate itself and fixed). Policy module: default-deny posture, OD gates, C6 semantics, `verifySrtPin` hash gate (mismatch disables). `check:srt-policy` + 10/10 tests. `devDependencies` exact only (C1 — CVEs stay out of the shipped tree). |
| `8805039` | SP1 | Session lifecycle (dynamic import from the hash-verified pin), read-only status probe via `resolveSrtWin` + `checkWindowsSandboxStatusAsync` (**live: pin verified, srt-win.exe spawn executed, Arabic «يلزم التثبيت مرة واحدة»**), one-time UAC install wrapper (cancel = friendly no-op), `<DATA_DIR>/srt/audit.jsonl`, flat settings keys, `GET /api/sandbox` + `POST /api/sandbox/install`, and the **«عزل الأوامر (تجريبي)» panel** in الخدمات والإعدادات (status, install CTA, mode/domains/OD-10 ack editor). `check:srt-session`. |
| `8ff156c` | SP2 | `exec.ts` bridge (`wrapWithSandboxArgv` → real spawn, taskkill tree on timeout, annotation, violation attribution to ≥22-char commandIds); `shell_run` L3 gate after L0–L2 (C6: `untrusted_only` exempts only `full_access` runs); `shell_start` refused with an Arabic message while mode ≠ off (OD-6); ids-only audit (command text proven never to land). `check:srt-bridge`. |
| `bad9557` | SP3 | Opt-in MCP stdio wrap (C4): `"sandbox": true` servers spawn as `node srt --settings <loam-srt-settings> -- <original>`; settings file refreshed at wrap time; filesystem server = documented exemplar; loopback-dependent servers stay unwrapped. |
| `e86e408` + `27c9e07` | SP4 | Hardening: `isPinInsideWorkspace` refusal (§6.5 — refuses when the pin is inside the sandboxed workspace, the repo/data hazard), dependency/residual warnings as audit warnings (never hard failures), and the OD-10 server-side gate (non-off mode only honoured after `sandboxSupplyChainAck`; verified live: without ack → stays off). |

Verification: `check:srt-policy` / `check:srt-session` / `check:srt-bridge`, the
srt unit suites (policy 10/10, session 3/3, exec 3/3, mcpWrap 3/3), `check:modes`,
`check:mcp`, `check:encoding` all green. Remaining typecheck errors are only the
concurrent session's in-flight `masterPromptText.ts` + `runtime.ts` edits.

## Status right now

- Feature ships **`off`** (OD-1). The OS install has NOT run yet — the panel shows
  «يلزم التثبيت مرة واحدة».
- Everything is wired: flipping the mode on (after the UAC install + W-checklist)
  immediately contains `shell_run` and any `"sandbox": true` MCP server.

## SP5 — executed 2026-10-25 (result: code complete, OS-level W blocked, mode stays off)

**Done:**
- THIRD_PARTY_NOTICES (Apache-2.0 + CVE posture) and gates doc **Revision 52** — commits `961b5f6`/`c7c1839`.
- **One-time OS install EXECUTED** (UAC approved by Khamis): `srt-sandbox` user provisioned (SID recorded), WFP installed, profile grant skipped (OD-4).
- **W-checklist result:** W1 ✓, W2 ✓ (install), W11 ✓ (live status probe through the real srt-win spawn). **W4–W13 BLOCKED at the OS level on this machine**: the first sandboxed child spawn hangs silently — even the minimal direct `srt --settings <min> -- cmd /c echo` exits 124 with ZERO output while seclogon is Running, grants are clean, and the (scoped) persistent ACL grant lands in seconds. Suspected local policy on logon rights for the fresh `srt-sandbox` account (domain/GPO). Needs Khamis's admin eyes or upstream guidance; repro in the `0b6f1d7` commit message.

**Two real bugs the W-run caught and fixed:**
1. `buildSrtConfig` expanded the literal `.` to the bridge cwd = the REPO root, so the first persistent ACL grant walked the whole tree (600s timeout) and landed a repo-wide kept grant. Fixed: `.` maps to the workspace root only (`0b6f1d7`). All accidental grants were forgotten — **final state: 0 roots, verified**.
2. The §6.5 refusal proved itself live: the first checklist attempt was REFUSED because the pin sits inside the repo workspace — exactly the hazard it exists for.

**State:** `sandboxMode` stays `off` (the OD-1 gate held by design). Everything is wired: once the OS-level spawn issue is resolved on this machine, flip the mode in Settings (after the OD-10 ack) and re-run the W probes — no code changes needed. Minimal retry probe:
`node data/bin/srt/0.0.81/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js --settings <min-settings> -- cmd /c echo X`.

## Per-task Docker containers — layer above srt (2026-10-31, blueprint gap 1)

The OS sandbox isolates one command on the host; `src/sandbox/container.ts` goes
one step further and gives each task its own Docker container, so two concurrent
tasks share neither filesystem nor process table (the local-first stand-in for
the blueprint's gVisor/Firecracker isolation layer — Docker Desktop on Windows
already runs containers inside a utility VM).

- **Opt-in, off by default**: `sandbox.container.enabled` in config.json or
  `LOAM_SANDBOX_CONTAINER=1`. Limits overridable: `LOAM_SANDBOX_IMAGE`
  (default `node:22-alpine`), `LOAM_SANDBOX_NETWORK` (`none`|`bridge`),
  `LOAM_SANDBOX_CPUS` (2), `LOAM_SANDBOX_MEMORY_MB` (2048).
- **Hardening**: workspace is the only bind mount (`/workspace`), non-root user
  1000:1000, `--cap-drop ALL`, `no-new-privileges`, pids/memory/cpu caps,
  noexec/nosuid tmpfs, network `none` by default.
- **Lifecycle**: created lazily on the task's first `shell_run`, removed when the
  task ends; `pruneContainers()` sweeps crash leftovers at boot (fire-and-forget).
  A resume makes a fresh container from the same workspace.
- **Composition with srt**: the container branch sits after the srt L3 gate in
  `shell_run` — srt stays the host-level guard, the container is the per-task
  boundary. `shell_start` interactive sessions remain outside both (v2 concern).
- **Gates**: `node --import tsx --test src/sandbox/__tests__/container.test.ts`
  (12 tests, daemon-free via the `__setDockerForTests` seam), `typecheck`,
  `check:encoding`, `src/tools/__tests__/shellRisk.test.ts` (11).
