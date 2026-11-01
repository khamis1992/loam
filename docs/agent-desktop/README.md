# agent-desktop integration

agent-desktop (Vercel Labs, Apache-2.0, v1.0.2) is Loam's primary computer-use
backend on Windows: an unmodified external Rust CLI that reads and drives the
Windows UI Automation tree. The legacy PowerShell/nut-js path stays as a
guarded fallback. See `الخدمات/IMPLEMENTATION_PROMPT.md` for the full plan and
`IMPLEMENTATION_STATUS.md` for progress.

## Design in one paragraph

`src/tools/computerUse.ts` stays the single facade (same `computer_*` tool
names). Per call it picks a backend (`pickBackend`): agent-desktop when the
sha256-verified pinned exe exists on win32, else legacy. The agent-desktop
variant B2 renders snapshots as compact text (skeleton + `--root` drill), keeps
only the latest snapshot per window, and returns a post-action delta — the
token reduction measured in Phase 1. Every physical/headed input on either
backend passes a mandatory foreground guard that refuses to send anything
unless the task's target window is the foreground window. The guard has no
config switch.

## Files

- `src/tools/desktop/` — types, binary pin/verify, process client, backends,
  renderer, guard, snapshot store, metrics, tests.
- `scripts/vendor-agent-desktop.mjs` — pinned download + verify + extract.
- `scripts/fg-probe.ps1` — long-lived foreground/cursor probe for the guard.
- `resources/agent-desktop/` — vendored exe (git-ignored) + LICENSE + VERSION.
- `bench/desktopBench.ts`, `bench/desktop/` — the benchmark harness.
- `skills/desktop-a11y/SKILL.md` — the Arabic skill that teaches the loop.

## Attribution

Desktop accessibility backend: agent-desktop by Vercel Labs (Apache-2.0), used
as an unmodified external binary. No code copied.

## Safety rules that never bend

1. No physical or headed input without the foreground guard passing.
2. No retry/fallback after `delivered_*`, `delivery_uncertain`, `unknown`, or
   whenever `retry` is not `safe`.
3. Window titles, element names/values, typed text and snapshot bodies never
   enter logs, evidence files, commits or the PR — only the model transcript.
4. Never `close-app ApplicationFrameHost.exe` / `explorer.exe`; close a window
   with its own Close button ref.
5. Never `--force`; never `alt+f4`, `win+*`, `ctrl+alt+del`, `ctrl+shift+esc`.
