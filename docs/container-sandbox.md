# Per-task container sandbox

Opt-in Docker isolation for a task's whole execution surface (`src/sandbox/container.ts`). It closes the gVisor-class isolation gap from the Manus blueprint comparison and GAP_REVIEW P2#13: while the OS sandbox (srt) confines one command on the host, the container mode gives **each task its own Docker container**, so two concurrent tasks share neither filesystem nor process table.

## What it adds over the existing layers

| Layer | Scope | This mode |
|---|---|---|
| Path policy (L0–L2) | tool arguments | unchanged — still enforced before anything runs |
| srt OS sandbox | one command, host user | container replaces it for the task when enabled |
| **Container (this)** | **the task's whole shell surface** | own filesystem view, own pid table, resource caps |

Hardening of every task container (`loam-task-<taskId>`):

- the task workspace is the **only bind mount** (`/workspace`); a missing host workspace is refused before any docker call (Docker would otherwise silently create an empty mount source)
- `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root `--user 1000:1000`
- `--pids-limit 256`, `--memory` and `--cpus` from config (clamped 256–16384 MB, 0.25–8 CPUs)
- `--network none` by default; `/tmp` is a `noexec,nosuid` tmpfs; `HOME=/tmp`
- image `node:22-alpine` by default, pulled once on first use with a clear log line

## Enabling

`config.json`:

```json
"sandbox": { "container": { "enabled": true, "image": "node:22-alpine", "network": "none", "cpus": 2, "memoryMb": 2048 } }
```

Environment overrides (win over config): `LOAM_SANDBOX_CONTAINER` (`1/true`, `0/false`, unset = config), `LOAM_SANDBOX_IMAGE`, `LOAM_SANDBOX_NETWORK` (`none|bridge`), `LOAM_SANDBOX_CPUS`, `LOAM_SANDBOX_MEMORY_MB`.

Requires a reachable docker daemon (Docker Desktop on Windows). **Fails closed**: with the mode enabled and Docker unreachable, `shell_run` / `shell_start` return an explicit Arabic error — never a silent downgrade to the host shell.

## Lifecycle

1. Created lazily on the task's first shell command (`ensureContainer`); reused by every later command **and** interactive session of the task; one in-flight create per task.
2. Interactive sessions: `shell_start` runs a pipe-driven `docker exec -i … sh -l` with the same stdin/stdout session model as powershell/cmd, so `shell_write` / `shell_read` / `shell_kill` drive it unchanged.
3. Removed (`docker rm -f -v`) when the task ends — in `src/index.ts`, fire-and-forget after the run span closes. A resume builds a fresh container from the same workspace.
4. A crash that skips removal is swept at the next boot: `pruneContainers()` removes every container labelled `loam.task` (probes availability first, no-ops without a daemon).

## Explicit limits

- **Environment**: the container receives only the task's variables (`env` args + vault-injected values) — never the host environment; output redaction of vault values still applies.
- **Network**: `none` by default. `bridge` is **unrestricted** egress — it bypasses the srt domain allow-list model; treat it as a deliberate trust decision, not a default.
- **Timeout semantics**: killing a timed-out command kills the host-side docker client; the process inside the container keeps running until the container is removed at task end (pids are capped at 256, so a stray loop cannot fork-bomb).
- **Scope**: shell tools only. File tools stay protected by the workspace path policy; browser/computer-use run in their own engines; codemode keeps its separate sandbox.
- Windows bind mounts require Docker Desktop file sharing over the workspace drive.

## Tests

`npm run test:container` — unit suite driving the full docker argv surface through the `__setDockerForTests` seam (no daemon needed): limits/env precedence and clamps, mode tri-state, path mapping, create/restart/reuse/dedupe argv, image pull once, exec/interactive argv, removal, boot-time prune, and the fail-fast on a missing workspace. The suite is also part of `npm run test:unit`.
