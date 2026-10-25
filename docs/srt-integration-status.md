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

## SP5 — remaining

1. **User gesture:** click «تثبيت عزل النظام» in Settings (UAC dialog), or run
   the printed command from `docs/srt-pin.md`.
2. **W-checklist** (spec §4.2) driven by the agent right after; gate = W2/W4/W5/
   W7/W12/W13 before recommending `untrusted_only`.
3. Docs: THIRD_PARTY_NOTICES (Apache-2.0 + NOTICE + transitive CVEs), Revision 52
   in the gates doc, this file refreshed, memory updated.
