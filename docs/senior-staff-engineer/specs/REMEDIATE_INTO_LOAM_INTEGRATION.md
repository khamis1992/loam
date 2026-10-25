# BUILD_SPEC: Loam Remediate — verified vulnerability fixing with approval gates (from CognitionAI/devin-vuln-fixes)

> **PROPOSAL AWAITING KHAMIS'S APPROVAL. NOTHING HERE IS CODED INTO LOAM OR QUEUED.**
> Study and writing only. No edits to `C:\Users\khamis\Desktop\manus-local`, no commits or pushes to `github.com/khamis1992/loam`, nothing in any scheduler, no messages to third parties. Khamis approved spec-only on 2026-10-25 13:18 (Asia/Qatar, UTC+3): «أرسل الثنتين للهندسة العكسية (مواصفة بس)». A separate coding approval is required before anything in this file is built.
>
> Prepared 2026-10-25 (Asia/Qatar, UTC+3) on the analysis box under `/workspace/re/devin-vuln-fixes/`.
>
> **Upstream baseline (OBSERVED):** `https://github.com/CognitionAI/devin-vuln-fixes`, cloned to `/workspace/re/devin-vuln-fixes-src`, HEAD `39a04007a1cb19aafd3c487d615c524479963ebf` ("Fix duplicate skills spec in Claude marketplace entry", 2026-10-22 22:12:42 Asia/Qatar). Two commits in history. Release `1.0.0` (`CHANGELOG.md:3`). SHA-256 of the files studied is in `/workspace/re/devin-vuln-fixes/source-hashes.txt` and repeated in §10.1.
>
> **Loam baseline (OBSERVED):** fresh public clone `/workspace/re/loam-dvf`, branch `main` @ `5227df4300338547d8f5f942d38b67c6d77622a1` (2026-10-24 18:35:29 +0300), `package.json` version `0.5.31`, `engines.node ">=22.13.0"`. `origin/manus-parity` @ `2afc35f8c248487b34cdc710ce47f08827325c9b`. Every Loam `file:line` in this document was read on that `main` tree. Khamis's PC checkout was **not** read or touched.
>
> **Parent design this file extends (OBSERVED):** `/workspace/re/loam-security-system/BUILD_SPEC.md` (969 lines, the blue-team "Loam Security System": deterministic scanners → agentic hunt/validate → reports). That spec stops at reporting. This file adds the missing **Phase 7 — Remediate** and **Phase 8 — Re-scan and close** (§3.2).
>
> **Claim tags:** **OBSERVED** (file:line, URL, or command run on the box), **INFERRED** (reasoned from observed facts), **UNKNOWN** (not established; every UNKNOWN carries a **Design decision** so the build is never blocked on it). Nothing is fabricated; where a fact could not be checked it says so.
>
> **Brand / UI:** Arabic-first UI strings; brand spelled «نتريو» if it appears; **never** use a Sparkles/star icon — use the shield/wrench glyphs already used by Loam's security UI (`🛡` is the Security mode icon at `src/modes/catalog.ts:66`).

---

## Contents

0. Instructions to the implementing model, no-fabrication rule, Definition of Done
1. Executive summary and verdict
2. What devin-vuln-fixes is — OBSERVED from source
3. Capability map: overlap with Loam, net-new value, where it plugs into the Security System
4. Approach options and recommendation
5. Security and trust integration
6. Exact wiring points in Loam (file-by-file written spec)
7. Data model and types (full TypeScript)
8. Phased build plan with acceptance criteria and verification commands
9. Open decisions for Khamis (OD-1 … OD-12)
10. Evidence log, UNKNOWNs with design decisions, licence posture

---

## 0. Instructions to the implementing model

### 0.1 Standing rules (non-negotiable)

1. **Approval before any change.** Discovery is read-only. No file in a target repo is edited, no branch is created, no commit is made, nothing is pushed, and no pull request is opened until Khamis has approved that exact step in the Loam UI. Approvals are bound to a hash of what is being approved (§5.2). An agent can never approve on the user's behalf; approval endpoints are UI/HTTP-only and are not exposed as model tools.
2. **No guessed versions.** A fixed version is accepted only when (a) it appears in a pinned, reviewed advisory pack (§6.4) **and** (b) the concrete artifact (image tag + digest, package release, chart version, tarball checksum, commit hash) was confirmed to exist from the registry or mirror the repo already uses. If (b) cannot be reached, the target is labelled `unverified` with the reason, and the plan must say "CI must prove this target". A model-produced version string is never used.
3. **Tests before and after, inside the built artifact.** A fix is `verified_fixed` only when the after-artifact reports a fixed version and its test run shows no new failure and no new deprecation warning compared with the baseline (§5.4). Anything else is `patched_unverified`, `regression`, or `blocked`, never "fixed".
4. **One focused PR per repo.** Each approved repo gets one branch and one PR (draft by default) that carries before → after, digests, baseline vs after test results, runtime diff, risk label, rollout plan and rollback target. No PR mixes repos; no PR mixes unrelated advisories unless the plan approved by Khamis grouped them.
5. **Never `git reset --hard`, never force-push, never discard user changes.** Loam's git tools already refuse force-push and commits on `main`/`manus-parity` (`src/tools/gitWorkflowTools.ts:5-9`, `:31`). Remediate reuses them and adds no new git path.
6. **No production commands.** Remediate never runs commands against a production host, registry write API, cluster, or deployed instance. It reads registries, builds locally, and tests locally.
7. **Secrets are never printed.** Registry credentials, tokens and env values never enter prompts, evidence, logs, PR bodies, or reports. Evidence records names, never values.
8. **No Sparkles/star icon. Brand «نتريو».** Arabic-first UI copy.
9. **The local model is excluded** from the remediation chain (Khamis's rule, also D6 in the parent spec). Every agent role in this file runs on a configured cloud model.

### 0.2 No-fabrication rule

- Every upstream fact cites a path and line in `/workspace/re/devin-vuln-fixes-src` or a URL. Every Loam fact cites a path and line in `/workspace/re/loam-dvf`.
- Advisory facts (CVE ids, fixed versions) are copied from the upstream skills and were cross-checked against vendor pages on 2026-10-25 (§2.11). The advisory packs in §6.4 carry those URLs. If a vendor page later disagrees, the vendor page wins and the pack is bumped through review (§6.4.5).
- Where this document proposes a value that nobody published (timeouts, limits, labels), it is marked **Design decision** and can be changed without re-studying anything.

### 0.3 Definition of Done (whole programme)

The programme is done when all of the following hold on Khamis's Windows PC with the installed Loam build:

1. **D-1 Inventory.** `remediation_start` on the fixture repo set in §8.0 produces one inventory table whose rows match the expected table in §8.0 exactly (file, line, signal, current version, pin style, status), with zero writes to any fixture repo (verified by `git status --porcelain` empty in each).
2. **D-2 Gate.** The run stops at `awaiting_scope_approval`. No branch exists in any fixture repo until Khamis approves in the UI. Approving a stale plan (hash mismatch) is refused with HTTP 409.
3. **D-3 Verified target.** For each approved row, the resolver records a `TargetVerification` with `status:"verified"` and the evidence (manifest digest or release-index entry), or `status:"unverified"` with a reason. No target comes from a model.
4. **D-4 Before/after.** For the Node and PHP fixtures, baseline and after test logs exist, the after-artifact reports `v22.23.4` / `8.3.36`, and the comparison shows zero new failures. A planted regression fixture yields `regression`, leaves the bump uncommitted, and reports the failing output.
5. **D-5 PR plan.** One branch, one commit, and one PR body file per approved repo. With PR creation approved and the local PR provider active, exactly one PR per repo exists under `.loam/prs`; with the GitHub provider, PRs are created as drafts.
6. **D-6 Re-scan.** After the fix branch is checked out, Phase 8 re-runs the matching detector (security-audit fast path, dependency inventory, or runtime inventory) and the original finding moves to `fixed_pending_deploy` (source fixed) — never to `closed` without deploy evidence supplied by Khamis.
7. **D-7 Dogfood.** Running the Node pack against Loam's own repo reports `electron@44.7.2 → bundled Node 24.21.0 → affected by CVE-2026-111497`, classifies it `vendor_update_required`, and proposes **no** version bump because no Electron 44.x release bundling Node ≥ 24.22.1 was verified (§3.7). That is the correct, non-guessing result as of 2026-10-25.
8. **D-8 Quality gates.** `npm run typecheck`, `npm run test:remediate`, `npm run check:remediate` and the existing `npm run check:security-repairs` all pass. No existing test regresses.

### 0.4 Non-goals

- Not a new scanner. Detection stays with the Security System (OSV-Scanner/Trivy/GuardDog/Gitleaks/Opengrep and the agentic core) and Loam's existing `dependencies.ts` OSV lookup. Remediate consumes their findings.
- Not a deploy tool. Remediate never deploys, restarts workers, or upgrades a running instance. It produces PRs and a post-deploy checklist.
- Not a source-code vulnerability fixer for arbitrary CWE classes. Source-level repairs stay in `src/security/repairs.ts` (one AST class today). Remediate targets **runtime and dependency version** fixes, plus the documented temporary mitigations shown as mitigations, never as fixes.
- Not a red-team capability. Nothing here exploits anything.

---

## 1. Executive summary and verdict

### 1.1 What it is

`CognitionAI/devin-vuln-fixes` (MIT, © 2026 Cognition AI, Inc.) is **three Markdown Agent Skills** — `fix-node-vuln`, `fix-php-vuln`, `fix-gitlab-vuln` — and plugin manifests for Claude Code, Codex, Factory Droid and Devin. There is **no executable code** (`find` on the clone shows 15 files, 509 lines total, 0 scripts; §2.1). Each skill is one procedure an agent follows: read-only inventory across repos → stop at an approval gate → patch to a fixed version confirmed to exist → build and test inside the production image before and after → one focused PR per repo → roll-up table (`README.md:11-17`). The skills target three real October 21, 2026 advisories: Node.js (CVE-2026-111497 Brotli RCE and nine others), PHP "PHP2Shell" (CVE-2026-109618/-109619), and self-managed GitLab (CVE-2026-110264, CVSS 10.0). All three advisories were confirmed on vendor pages on 2026-10-25 (§2.11).

### 1.2 Net-new value to Loam

Loam already **detects**: the Security mode runs pentest checks and assessments (`src/modes/catalog.ts:66-68`), `src/security/dependencies.ts:57` queries OSV for npm/PyPI lockfile entries, and the parent spec adds OSV-Scanner/Trivy fast-path "known-bad version" verdicts (`loam-security-system/BUILD_SPEC.md` §6.2). Loam can also **repair one source pattern** (`innerHTML` → `textContent`, `src/security/repairs.ts:15-18`), and its own warning says such a repair is "not proof of a vulnerability or a verified fix" (`src/security/repairs.ts:36`).

What Loam does **not** have — and what this repo's method supplies — is the blue-team second half:

| Missing in Loam today | Supplied by the devin-vuln-fixes method |
|---|---|
| A runtime inventory (base images, version files, CI `setup-*`, IaC, config management, serverless runtimes) | Per-ecosystem signal lists (`fix-node-vuln/SKILL.md:22-29`, `fix-php-vuln/SKILL.md:22-27`, `fix-gitlab-vuln/SKILL.md:22-27`) |
| A documented approval gate between discovery and change for multi-repo work | "Stop. Show the table and ask which repos to patch… Change nothing during discovery" (`fix-node-vuln/SKILL.md:32`) |
| A rule that a fix target must be proven to exist, and that "fixed" means the artifact contains the fix | `README.md:90`, `fix-php-vuln/SKILL.md:29,58` |
| Before/after regression testing **inside the built image**, with runtime diffs and smoke tests | `fix-node-vuln/SKILL.md:44-53`, `fix-php-vuln/SKILL.md:43-52` |
| A PR convention with risk label, rollout plan and rollback target | `fix-node-vuln/SKILL.md:54`, `fix-php-vuln/SKILL.md:53`, `fix-gitlab-vuln/SKILL.md:49` |
| Honest "blocked" outcomes ("Done means every approved deployment is either verified fixed or reported as blocked with a concrete next step") | `fix-node-vuln/SKILL.md:61` |

### 1.3 Verdict

**Useful — adopt the method, not the files as-is.** Recommended approach is **Option (c) Hybrid** (§4): a native, typed remediation engine `src/security/remediate/` that enforces the gates, the verified-target rule and the before/after comparison in code, driven by **versioned advisory packs** (data, not prose) and **Loam-authored playbook skills** that carry the ecosystem know-how from the three upstream skills (rewritten fresh, MIT attribution kept). The upstream skills alone are not enough for Loam because their guarantees rest entirely on the model obeying prose: there is no persisted approval, no evidence id, no machine check that a version was verified, and "mark unverified and let CI prove it" (`fix-node-vuln/SKILL.md:34`) is an escape hatch an agent can take silently. Loam's rules require those guarantees to be enforced, so the engine must own them.

### 1.4 Decision table — take vs skip

| Upstream element | Decision | Why |
|---|---|---|
| Five-step shape (inventory → gate → verified patch → before/after tests → one PR per repo) | **Take**, enforced as a state machine (§5.1, §7) | It is the point of the repo (`CONTRIBUTING.md:15`) and matches Khamis's gate rules |
| Ecosystem signal lists (Node/PHP/GitLab) | **Take**, as inventory detectors + playbook text | Real coverage Loam lacks |
| Fixed-version tables inside skill prose | **Take the facts, move them to advisory-pack JSON** with source URLs and a review-gated bump process | Machine-checkable "no guessing" |
| "Confirm the target exists" | **Take and harden** into `TargetResolver` with recorded evidence | Code-enforced |
| Before/after tests inside the image | **Take**, Docker-gated `[U2]` like the parent spec | Same sandbox doctrine |
| One PR per repo, risk label, rollout, rollback | **Take**, PR body is a deterministic template (no model prose) | Reproducible, testable |
| Subagent per repo, max five (`fix-node-vuln/SKILL.md:33`) | **Adapt** to Loam's process-wide child cap `DEFAULT_MAX_CONCURRENT_CHILDREN = 4` (`src/subagent/registry.ts:5`) | Never exceed Loam's cap |
| Plugin manifests (`.claude-plugin`, `.codex-plugin`, `.devin-plugin`, `.factory-plugin`) | **Skip** | Loam has its own skill loader |
| `npx skills add` install path | **Skip for production**, but Loam already discovers `.agents/skills` (`src/tools/skills.ts:23`), so a user who runs it gets the raw skills — §6.7 makes that safe | Avoid an unreviewed third-party path |
| Upstream prose verbatim | **Skip by default** (rewrite fresh, keep MIT notice) — OD-2 | Consistency with the parent spec's D2 clean-rewrite decision |
| GitLab post-deploy commands (`gitlab-rake`, `gitlab-ctl`) | **Take as a checklist only** for the user to run | Remediate never touches production |

---

## 2. What devin-vuln-fixes is — OBSERVED from source

### 2.1 Repository inventory

OBSERVED: `find . -type f -not -path './.git/*' | xargs wc -l` on the clone.

| Path | Lines | Role |
|---|---|---|
| `skills/fix-node-vuln/SKILL.md` | 73 | Node.js runtime remediation skill |
| `skills/fix-php-vuln/SKILL.md` | 82 | PHP runtime remediation skill |
| `skills/fix-gitlab-vuln/SKILL.md` | 69 | Self-managed GitLab remediation skill |
| `README.md` | 111 | Overview, install, design rationale |
| `CONTRIBUTING.md` | 25 | Rules for skill text and version bumps |
| `CHANGELOG.md` | 6 | `1.0.0 (2026-10-22)` |
| `LICENSE` | 21 | MIT, "Copyright (c) 2026 Cognition AI, Inc." |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | 18, 22 | Claude Code plugin `vuln-fixes` in marketplace `cognition-skills`, category `security` |
| `.codex-plugin/plugin.json` | 25 | Codex plugin, `capabilities: ["Read","Write"]`, `defaultPrompt: ["Please fix my PHP vulnerability."]` |
| `.agents/plugins/marketplace.json` | 19 | Codex marketplace, `policy.installation: "AVAILABLE"` |
| `.devin-plugin/plugin.json` | 11 | Devin plugin `devin-vuln-fixes` |
| `.factory-plugin/plugin.json`, `.factory-plugin/marketplace.json` | 11, 15 | Factory Droid manifests |
| `logo.svg` | 0 | Empty file |
| `.gitignore` | 1 | `.DS_Store` |

There are **no scripts, no code, no tests, no dependencies, no lockfile**. INFERRED: everything the skills "do" is done by the host agent's own tools (shell, git, Docker, registry access, PR creation).

### 2.2 SKILL.md anatomy

OBSERVED: all three skills share one frontmatter shape and one section order.

Frontmatter (`fix-node-vuln/SKILL.md:1-9`; same keys in the other two):

```yaml
---
name: fix-node-vuln
description: "Use when the user asks to fix, patch or upgrade a Node.js vulnerability (...). Read-only inventory, approval gate, regression tests, focused PRs."
license: MIT
compatibility: Needs git, a shell and read access to the target repos. Build and verification steps need Docker and access to the image registry or package mirror the repos already use.
metadata:
  author: Cognition AI
  version: "1.0.0"
---
```

- `name` equals the folder name, lowercase letters/digits/hyphens (`CONTRIBUTING.md:12`).
- `description` is a quoted string ≤ 1024 characters containing the phrases a user would type (`CONTRIBUTING.md:13`).
- No `allowed-tools` field, on purpose: agents disagree on its format (`README.md:93`).
- `metadata.version` is bumped on every vendor-driven change (`README.md:97`, `CONTRIBUTING.md:19-25`).

Body sections, in order, in every skill: `# <title>` → `## Overview` → `## What's Needed From User` → `## Procedure` (11 numbered steps) → `## Specifications` → `## Advice and Pointers` → `## Forbidden Actions`.

### 2.3 The pipeline

OBSERVED common shape (`README.md:11-17`):

1. **Inventory, read-only** — search Dockerfiles, version files, CI config, Helm, Terraform, Ansible, Chef, Puppet; one table: file, current version, pin style, production or CI-only, test coverage, confidence.
2. **Stop at an approval gate** — nothing changes until the user picks the repos.
3. **Patch to a confirmed target** — check the fixed tag, digest or package exists before editing; never guess.
4. **Test before and after** — baseline build and tests, then the same tests inside the new production image; new failures and new deprecation warnings are regressions.
5. **One focused PR per repo** — before/after, digests, test results, risk label, rollout plan, rollback target.

The 11-step procedure, step by step, with the line in each skill:

| # | Step | Node | PHP | GitLab |
|---|---|---|---|---|
| 1 | Read-only search across all reachable repos: host code search first; if none, shallow clone + `rg -n --hidden --glob '!.git'` | `:22-29` | `:22-27` | `:22-27` |
| 2 | One inventory table + a separate list of repos that could not be searched | `:30` | `:28` | `:28` (also: on GitLab.com/Dedicated, say no action needed and stop) |
| 3 | Classify each row: fixed / vulnerable / EOL / unknown; for distro packages and managed runtimes use the vendor changelog, never upstream version strings | `:31` | `:29` ("Never compare `php -v` with upstream numbers") | `:29` (compare `/help` or `/api/v4/version` if reachable, token required) |
| 4 | **Stop.** Show the table, ask which repos to patch, ask about major/minor upgrades and likely app-code changes in the same message | `:32` | `:30` | `:30` (flag single-node downtime) |
| 5 | One approved repo at a time; subagents if supported, ≤ 5 at once; re-run inventory before editing | `:33` | `:31` | `:31` |
| 6 | Pick the smallest fixed target per path; confirm it exists in the registry/mirror the repo's CI already uses; if unreachable, mark `unverified` in the PR and let CI prove it; per-channel rules | `:34-41` | `:32-40` | `:32-36` |
| 7 | Leave declarative constraints alone (`engines.node`; Composer `require.php`) unless they would exclude the new version / report upgrade-path stops | `:42` | `:41` | `:37` (required upgrade-path stops; multi-stop only with approval) |
| 8 | Report EOL lines separately with an upgrade path; major upgrades only with approval | `:43` | `:42` | `:38-42` (rollout notes) |
| 9 | Before/after testing in the image; runtime diff; smoke; save logs; regression ⇒ stop, leave bump uncommitted | `:44-53` | `:43-52` | `:43-48` (validate IaC: `helm template/lint`, `terraform validate/plan`, `ansible-lint`, Compose config; list post-deploy checks) |
| 10 | One focused PR per repo with before → after, digests, test results, runtime diff, risk label, rollout and rollback | `:54` | `:53` | `:49` |
| 11 | Roll-up table across repos; remind that fixes take effect only after deploy | `:55` | `:54` | `:50` |

### 2.4 The approval gate (design as written)

OBSERVED:
- "Discovery is read-only and ends at an explicit approval gate." (`fix-node-vuln/SKILL.md:58`, `fix-php-vuln/SKILL.md:57`, `fix-gitlab-vuln/SKILL.md:53`).
- What the user approves: which repos/deployments to patch, and — in the same message — major/minor upgrades, base-OS changes, likely app-code changes (`fix-php-vuln/SKILL.md:18,30`), and for GitLab a maintenance window for single-node instances (`fix-gitlab-vuln/SKILL.md:19`).
- First forbidden action in every skill: "Do not edit before the user approves a repo." (`fix-node-vuln/SKILL.md:70`, `fix-php-vuln/SKILL.md:78`, `fix-gitlab-vuln/SKILL.md:65`).
- A **second, implicit gate** exists for regressions: "stop and report it with the failing output and the smallest fix, verified in a scratch copy. Leave the version bump uncommitted until the user decides. Don't change app code without approval." (`fix-node-vuln/SKILL.md:53`, `fix-php-vuln/SKILL.md:52`).
- A **third, implicit gate** exists for test additions: "offer (don't commit without approval) a minimal smoke or characterization test" (`fix-node-vuln/SKILL.md:51`).

INFERRED limits: the gate is a conversational stop. Nothing records what was approved, nothing binds the approval to the inventory the user saw, and nothing prevents an agent from editing a repo that was not on the approved list. §5.2 turns this into three hash-bound, persisted gates.

### 2.5 The "verified fixed version" lookup — how it avoids guessing

OBSERVED rules:
- "Every tag, digest and package release is confirmed to exist. 'Fixed' means the artifact contains the fix, not that a version string looks newer." (`README.md:90`)
- "Every target is confirmed to exist and contain the fix before editing." (`fix-php-vuln/SKILL.md:58`)
- "Do not guess image tags, digests, or package versions." (`fix-node-vuln/SKILL.md:71`, `fix-php-vuln/SKILL.md:79`, `fix-gitlab-vuln/SKILL.md:66`)
- Where to confirm: the registry or package mirror the repo's CI already uses (Artifactory, Nexus, Harbor, a cloud registry) when public hosts are blocked; if neither is reachable, mark the target unverified in the PR and let the CI build prove it (`fix-node-vuln/SKILL.md:34`, same text in PHP `:32` and GitLab `:32`).

OBSERVED per-channel resolution rules:

| Channel | Node (`fix-node-vuln/SKILL.md`) | PHP (`fix-php-vuln/SKILL.md`) | GitLab (`fix-gitlab-vuln/SKILL.md`) |
|---|---|---|---|
| Exact image tag | Bump to fixed patch in same major, keep variant (`-alpine`, `-slim`, `-bookworm`) `:35` | Same minor, keep variant (`-fpm`, `-apache`, `-alpine`, `-bookworm`) `:33` | `gitlab/gitlab-ee:<ver>-ee.0` or `gitlab/gitlab-ce:<ver>-ce.0` `:33` |
| Digest pin | Resolve and pin the new digest `:36` | Same `:34` | Resolve and pin if digest-pinned `:33` |
| Floating tag | Leave the tag; require `--pull --no-cache` rebuild + redeploy; record new digest `:37` | Same; record per-platform digest; say if base OS moved (bookworm → trixie) `:35` | — |
| Multi-arch | Record the multi-arch index digest for every new image `:38` | Index digests change when tags are re-pushed `:35` | — |
| Placeholder/unresolvable digest | — | Flag it; ask the user to confirm the running image `:36` | — |
| Version files | `.nvmrc`, `.node-version`, `.tool-versions`, Volta: set the fixed patch; keep all consistent `:39` | — | — |
| CI setup action | `setup-node` floating: add `check-latest: true` or pin the patch `:40` | `setup-php` takes `major.minor`; confirm patch in CI log `:38` | — |
| Distro package | Check vendor changelog/advisory, not upstream version `:31` | Upgrade from vendor security repo; record package release + changelog CVE entry; in Dockerfiles pin or fail the build; Ansible/Chef/Puppet `state=present` never upgrades — use `latest` or pin, then restart `:37` | Omnibus: pin `gitlab-ee=<ver>-ee.0` `:35` |
| Source build | — | Fixed tarball + verify php.net SHA-256; for 7.4/8.0/8.1 use backport commits pinned by hash `:39` | Check out the fixed tag; follow source upgrade guide `:36` |
| Helm / IaC | Code that installs Node `:27` | Change the input that selects the artifact; regenerate lock/render outputs `:40` | Chart version from `docs.gitlab.com/charts/installation/version_mappings/` (19.5.1 → chart 10.5.1; 18.11.13 → chart 9.11.14); fallback `helm search repo gitlab/gitlab -l`; bump chart version, not just `global.gitlabVersion` `:34` |
| Managed runtime | Lambda `nodejs22.x`: check provider base image (`public.ecr.aws/lambda/nodejs:22`) or log `process.version`; Auto vs Function-update vs Manual modes `:41` | Managed platform: vendor changelog `:29` | GitLab.com/Dedicated: no action `:28` |
| Bundled runtime | "Electron apps, vendor images and appliances bundle their own Node. Flag them for vendor updates." `:66` | Appliances/vendor products embedding PHP: flag, don't patch in place `:74` | Runner and Agent versioned separately; do not upgrade them `:61` |

INFERRED weakness: the fixed-version facts live inside prose (Overview paragraphs and `description`). An agent can misread them, and a stale skill can stay installed. Loam moves the facts into a data file with source URLs (§6.4) and requires live existence evidence per target (§5.3).

### 2.6 The before/after test strategy

OBSERVED (`fix-node-vuln/SKILL.md:44-53`; PHP equivalent `fix-php-vuln/SKILL.md:43-52`):

1. **Baseline:** before editing, build the current image with `--pull`, record its digest (the rollback target), run install (`npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable`; PHP: `composer test`, PHPUnit/Pest, `make test`, or CI test command), build and tests **inside the image**. Record results so pre-existing failures are not blamed on the upgrade.
2. **After:** repeat install, build and test inside the new **production** image, not on the host. If the production image lacks tests or dev deps (multi-stage, `--omit=dev`), build the test stage from the same base or mount the tests in. New failures **and new deprecation warnings** are regressions.
3. **Runtime diff:** Node — diff `node -p process.versions` (V8, OpenSSL, ICU) and base OS; note eMudhra CA removal and stricter OpenSSL defaults for outbound TLS. PHP — diff `php -m` and key `php -i` values (ini, ICU/OpenSSL/libxml), report extension/ini/base-OS changes.
4. **Smoke:** start the container with the production command, request a health or main route, check logs. PHP adds: check bodies and headers because `display_errors` can print deprecations into JSON (`fix-php-vuln/SKILL.md:47`).
5. **Major/minor upgrades:** Node — `NODE_OPTIONS=--pending-deprecation`, `npm rebuild`, list applicable breaking changes (e.g. Node 22 removed import assertions `assert { type: 'json' }`) (`:49`). PHP — `composer check-platform-reqs`, PHPCompatibility or Rector dry-run, UPGRADING notes; static tools do not replace tests (`:48`).
6. **Logs:** save baseline, after, runtime-diff and smoke logs and attach them to the PR (`fix-node-vuln/SKILL.md:50`).
7. **Thin coverage:** say so prominently; offer, don't commit, a minimal smoke/characterization test (`:51`).
8. **Version proof:** confirm `node -v` in the built production image (`:52`); PHP `php -v`/`php-fpm -v` or image SBOM, plus distro package release (`fix-php-vuln/SKILL.md:51`).
9. **Regression:** finish read-only checks, stop, report failing output and the smallest fix verified in a scratch copy; leave the bump uncommitted (`:53`).

GitLab differs (no app tests): static validation of IaC (`helm template`/`helm lint`, `terraform validate`/`plan`, `ansible-lint`, Compose config) plus a post-deploy checklist for the user (`fix-gitlab-vuln/SKILL.md:43-48`).

### 2.7 The one-PR-per-repo convention

OBSERVED:
- "Open one focused PR per repo listing each path before → after, digests, floating tags needing rebuild, blocked items, EOL items, baseline vs. after test results, runtime diffs and verification evidence." (`fix-node-vuln/SKILL.md:54`)
- **Risk label:** low for a patch bump on the same base; high for major upgrades, base-OS changes or untested repos; note thin coverage (`:54`).
- **Rollout plan:** staging or canary first, then the previous image digest/version to roll back to; "That rollback target is still vulnerable, so roll back only briefly." (`:54`). PHP pairs rollback with the temporary mitigations (`fix-php-vuln/SKILL.md:53`).
- For floating tags, give the digest "as of today's date" (`fix-node-vuln/SKILL.md:54`).
- GitLab PRs add upgrade-path notes, downtime expectations and the post-deploy checklist (`fix-gitlab-vuln/SKILL.md:49,55`).
- **Roll-up** across repos: repo, PR, path, before → after, production or CI-only, tests, blocked items, follow-ups (`fix-node-vuln/SKILL.md:55`).
- **Done:** every approved deployment is verified fixed **or** reported blocked with a concrete next step (`fix-node-vuln/SKILL.md:61`, `fix-php-vuln/SKILL.md:60`, `fix-gitlab-vuln/SKILL.md:56`).

### 2.8 Per-skill specifics worth keeping

**Node (`fix-node-vuln`).** Ten CVEs; four High: CVE-2026-111497 (Brotli decoder OOB write RCE), CVE-2026-105482, CVE-2026-105483, CVE-2026-106069 (TLS/DNS hostname) (`:14`). Fixed: 22.23.4, 24.22.1, 26.12.1. Node 20 and older are EOL and need a major upgrade (`:14,43`). Prioritise internet-facing services that decompress Brotli (`zlib.createBrotliDecompress`) and TLS clients to user-supplied hosts (`:64`). The release also updates c-ares, OpenSSL (22/24), SQLite (22), Undici, CA certs (eMudhra removal) (`:65`). Forbidden: major upgrade without approval; changing base distribution or image flavour without saying so (`:72-73`).

**PHP (`fix-php-vuln`).** PHP2Shell = CVE-2026-109618 and CVE-2026-109619, CVSS v4 9.2 unauthenticated RCE; fixed 8.2.35, 8.3.36, 8.4.27, 8.5.12; 8.1 and older get only source backports (`:14`). All web SAPIs at risk; mod_php highest; treat `php -S` as exposed (`:14`). Known fixed backports: Debian bookworm `8.2.35-1~deb12u1`, Ubuntu noble `8.3.6-0ubuntu0.24.04.13`, Ubuntu jammy `8.1.2-1ubuntu2.28` (`:63-66`). Temporary mitigations (not fixes): `session.upload_progress.enabled=0` in php.ini/FPM pool then restart; on 8.5 `fatal_error_backtraces=0`; `post_max_size` 8M (no uploads) or 32M; proxy body/field/part/header/nesting limits; `memory_limit=-1` with a cgroup memory limit (`:68-73`). Forbidden: presenting a mitigation as a fix; `RLIMIT_AS`/`RLIMIT_DATA` as mitigation (they trigger the bug) (`:80-81`). Advisory ids GHSA-w8hw-w9fx-j79w, GHSA-6wmf-4rv5-p3rp; an unverified oss-security claim that 8.5.12 is incomplete (`:75`).

**GitLab (`fix-gitlab-vuln`).** CVE-2026-110264, CVSS 10.0 unauthenticated RCE (integer overflow in the Onigmo regex compiler), all CE/EE from 7.0; fixed 19.5.1, 19.4.3, 19.3.6, 19.2.9, 19.1.9, 19.0.10, 18.11.13; includes the October 8 fix for CVE-2026-97229 (fixed 19.4.2/19.3.5/19.2.8) (`:14`). Self-managed only (`:14,28`). Upgrade-path stops via `https://gitlab-com.gitlab.io/support/toolbox/upgrade-path/` (`:37`). Rollout notes: backup; single-node downtime; zero-downtime for multi-node; post-deploy migrations (`:38-42`). Threat detections "Onigmo native worker crash" and "Org mode render error burst" (`:60`). Forbidden: skipping upgrade-path stops; changing CE↔EE or deployment type; running commands against a production instance (`:67-69`).

### 2.9 Agent-neutrality and runtime assumptions

OBSERVED:
- Works in "any coding agent that reads `SKILL.md` files" (`README.md:3`); "Agent-neutral wording. The skills do not depend on one agent's tools. Where an agent supports subagents, the skills use one per repo; otherwise they work repo by repo." (`README.md:92`); "Do not name one agent's tools or features" (`CONTRIBUTING.md:14`).
- Runtime assumed by the skills: git, a shell, read access to repos; Docker and registry/mirror access for build and verify (`compatibility` field, each skill `:5`; `README.md:85`). Tools named in the text: `rg`, `docker build --pull --no-cache`, `npm ci`/`pnpm`/`yarn`, `composer`, PHPUnit/Pest, `phpcs`, Rector, `helm`, `terraform`, `ansible-lint`, `gitlab-rake`, `gitlab-ctl`.
- Install tooling: `npx skills add CognitionAI/devin-vuln-fixes` requires Node.js 22.20+ (`README.md:39`); `skills-lock.json` records the installed hash (`README.md:97`).
- The skills install into `.agents/skills/` among others (`README.md:68`). **Loam already scans `.agents/skills`** as a repo-local skill root (`src/tools/skills.ts:23`) — so the raw upstream skills become visible to Loam the moment anyone installs them into a project. §6.7 handles that.

### 2.10 Licence and dependencies

OBSERVED: MIT, `Copyright (c) 2026 Cognition AI, Inc.` (`LICENSE:1-3`); every skill frontmatter repeats `license: MIT`; plugin manifests declare `"license": "MIT"`. No runtime dependencies. MIT permits copying, modifying and redistributing with the copyright and permission notice retained. §10.4 gives the exact attribution text.

### 2.11 External corroboration of advisory facts (checked 2026-10-25)

| Claim in skills | Vendor source checked | Result |
|---|---|---|
| Node fixed 22.23.4 / 24.22.1 / 26.12.1; CVE-2026-111497 Brotli OOB write | `https://nodejs.org/en/blog/vulnerability/october-2026-security-releases`, `https://nodejs.org/en/blog/release/v22.23.4`, `https://nodejs.org/en/blog/release/v24.22.1` | **Confirmed.** v22.23.4 notes list `(CVE-2026-111497) deps: brotli: cherry-pick 0ed4268a4401abcb44720963` (commit `67d294739f`); v24.22.1 lists the same (commit `49dff6f57a`). |
| PHP fixed 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12; GHSA-w8hw-w9fx-j79w, GHSA-6wmf-4rv5-p3rp | `https://www.php.net/` (21 Oct 2026 advisory), `https://thephp.foundation/blog/2026/10/21/todays-php-security-release-and-how-were-strengthening-php-security/`, `https://www.kb.cert.org/vuls/id/763488` | **Confirmed.** php.announce for 8.4.27 publishes tarball SHA-256 values (e.g. `php-8.4.27.tar.xz` `dcf93923b0e38e0d5252b25b796520b5a47761a08b3488b6d0b5d1115764d3f0`) — the kind of evidence the source-build path must check. |
| GitLab fixed 19.5.1 … 18.11.13; CVE-2026-110264 CVSS 10.0 `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H` | `https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-5-1-released/`, `https://nvd.nist.gov/vuln/detail/cve-2026-110264` | **Confirmed.** |
| Electron bundles its own Node (flag for vendor update) | `https://releases.electronjs.org/release?channel=stable&major=v44` (fetched 2026-10-25), `https://releases.electronjs.org/schedule` | **Confirmed and relevant to Loam** (§3.7): 44.7.2 → Node 24.21.0; newest 44.x (44.9.3) → Node 24.22.0; schedule lists Node v24.22.1 only for 46.0.0/47.0.0. |

### 2.12 Strengths and gaps (assessment)

Strengths (INFERRED from §2.3–2.8): a disciplined, honest workflow; real ecosystem depth (dotfile version files, `check-latest`, `state=present` trap, floating-tag digest drift, Lambda update modes, chart vs app version); refusal to call mitigations fixes; explicit "blocked with a next step" as an acceptable end state.

Gaps that Loam must close in code:

| Gap | Consequence if adopted as-is | Loam answer |
|---|---|---|
| Approval is conversational, not recorded | No proof of what was approved; agent can drift | Persisted, hash-bound gates (§5.2) |
| No evidence ids or hashes | PR claims are unauditable | `RemediationEvidence` with `EV####` + SHA-256 (§5.5) |
| Version facts embedded in prose | Misreads; stale skills | Advisory packs as data with source URLs, review-gated bumps (§6.4) |
| "Unverified → let CI prove it" can be taken silently | Unproven fixes look fixed | Status `unverified` is a first-class label that blocks `verified_fixed` (§5.4) |
| No machine comparison of baseline vs after | Regressions can be argued away | Deterministic test-result diff (§7, `compareTestRuns`) |
| No re-scan or closure model | "Fixed" never re-checked | Phase 8 re-scan + `fixed_pending_deploy` vs `closed` (§3.2) |
| Subagent cap of 5 | Exceeds Loam's process cap of 4 | Use Loam's semaphore (§6.2) |
| No secrets statement | Registry creds could leak into logs | Env allow-list + redaction (§5.7) |
| Assumes Docker | Windows PC may not have Docker (parent spec U2) | `[U2]`-gated; without Docker, tests are `not_run` with blocker, never faked (§5.4) |

---

## 3. Capability map: overlap, net-new value, and where it plugs in

### 3.1 Overlap table (Loam today + parent spec vs devin-vuln-fixes)

| Capability | Loam today (OBSERVED) | Parent spec `loam-security-system` (proposed) | devin-vuln-fixes | Best-of-breed decision |
|---|---|---|---|---|
| npm/PyPI lockfile inventory | `inspectDependencies` (`src/security/dependencies.ts:38`), coverage metadata, 10 MB / 10,000-entry limits | OSV-Scanner `v2.7.0`, Trivy `v0.76.1` | — | **Keep Loam + parent.** Remediate consumes their findings. |
| Advisory lookup | `queryAdvisories` → `https://api.osv.dev/v1/querybatch`, ≤ 1,000 packages, ≤ 50 requests, 2 MB/20 MB caps (`dependencies.ts:57-73`) | OSV DB fast path → `confirmed` known-bad-version (§6.2) | Advisory facts in prose | **Keep OSV for packages**; add **advisory packs** for runtimes (Node/PHP/GitLab/Electron) which OSV does not express as deployment pins. |
| Runtime inventory (images, version files, CI setup actions, IaC, config mgmt, serverless) | **None** | Trivy `fs` sees some (misconfig), not as remediation targets | **Yes** — the core of the three skills | **Take** (net-new). |
| Approval gate before change | Source repairs need `reviewed:true` (`repairs.ts:60`); host input tools use `createApproval`/`waitForDecision` (`src/server/approvals.ts:36,82`); push needs `approvePush` + approval (`gitWorkflowTools.ts:7-8,87-89`) | Not covered (report-only) | Conversational stop | **Take the stop, implement with Loam's mechanisms**, persisted and hash-bound (§5.2). |
| Verified fix target | — | — | **Yes** (prose rule) | **Take, enforce in code** (`TargetResolver`, §5.3). |
| Patch application with rollback | `repairs.ts` draft → apply → rollback with hash checks, `.before` backup, pending journal, refusal while an assessment is active (`repairs.ts:27-73`) | — | Git branch + PR | **Use git branches for repo-level patches**; reuse `repairs.ts` *patterns* (hash-bound draft, journal, `assessmentActive` lock) — not its AST engine. |
| Before/after tests in image | — | Docker sandbox `[U2]` for confirmation only (§10.3) | **Yes** | **Take**, Docker-gated `[U2]`; build-network policy differs from the audit sandbox (§5.6). |
| PR creation | `pr_create` via `PrProvider` (GitHub or local `.loam/prs`) (`gitWorkflowTools.ts:213-246`, `gitPrProvider.ts:106-120`) | — | One PR per repo | **Reuse `PrProvider`**, add `draft` (§6.3). |
| Retest / re-scan | `retestAssessment` + `compareFindings` → `new/persistent/notObserved/unverified` (`assessments.ts:105`, `findings.ts:9,15-18`) | Prior-run carry rules: changed source ⇒ prior `confirmed` becomes `planned` again (§6.3 "Prior-run input") | Not covered | **Reuse both** as Phase 8 (§3.2). |
| Report / SARIF | `sarif()` (`findings.ts:20`), `assessmentReport` (`assessments.ts:95`) | Deterministic `REPORT.md`, `findings.sarif` (§6.9) | Roll-up table | **Add** `REMEDIATION.md` + per-repo `PR_BODY.md` as deterministic templates. |
| Skill loading | Global `skills/` + repo-local `.loam/skills`, `.agents/skills` (`src/tools/skills.ts:23,109-200`) | `skills/security-audit/SKILL.md` guidance skill | 3 SKILL.md | **Add Loam-authored playbooks**; guard raw upstream copies (§6.7). |

### 3.2 Where it plugs into `/workspace/re/loam-security-system/BUILD_SPEC.md`

The parent spec's state machine ends `REPORT → DONE` (parent §9.1). Its `Confirmed.remediation` field holds only `{ strategy, code_changes? }` (parent §7.1) and its `FINDINGS-DETAIL.md` lists "fix+regression" as text (parent §6.9). Remediate adds two phases after it, without changing any parent invariant:

```
Parent pipeline (unchanged)                                 This spec (new)
-----------------------------------------------------       ---------------------------------------------------------------
Phase 0 scanners → Phase 1 recon → Phase 2 hunt →           Phase 7  REMEDIATE (src/security/remediate/)
Phase 3 validate → Phase 4 findings.json →                    7a seed: confirmed known-bad-version records + runtime inventory
Phase 5 record verification → Phase 6 reports  ──────────►    7b classify against advisory packs (fixed/vulnerable/EOL/unknown/vendor)
                                                              7c GATE 1 scope approval (hash-bound)
                                                              7d per repo: recheck → resolve verified target → baseline → patch
                                                                 (on branch) → after → runtime diff → smoke → fix gate
                                                              7e GATE 2 commit approval (diff-hash-bound)
                                                              7f GATE 3 push + PR approval (draft default)
                                                            Phase 8  RE-SCAN AND CLOSE
                                                              8a re-run the detector that produced the seed on the fix branch
                                                              8b mark source state: fixed_pending_deploy | still_vulnerable
                                                              8c closure only with deploy evidence supplied by Khamis
```

Exact hand-offs (all INFERRED placement; the parent types are OBSERVED in its §7.1):

1. **Seed from the parent's fast path.** A parent `Confirmed` record whose `evidence_vector` contains a `rule` item from `osv` or `trivy` with `deterministic:true` (parent §6.2 "Known-bad version") becomes a `VulnRecord` with `origin:{kind:"security_audit", runId, fingerprint}`. The parent fingerprint is kept, so the remediation links back to the audit finding.
2. **Seed from Loam's assessments.** An `Assessment.inventory.advisories.matches[]` entry (`dependencies.ts:6`) becomes a `VulnRecord` with `origin:{kind:"assessment", assessmentId, name, version, ids}`.
3. **Seed from runtime inventory.** Remediate's own detectors (§6.5) produce `VulnRecord`s with `origin:{kind:"runtime_inventory"}`. This is the net-new path that the parent cannot produce.
4. **Re-scan (Phase 8a).** For `security_audit` origins: start a parent audit with `profile:"quick"`, `scope_paths` = the files changed by the fix, `prior_runs:"auto"` — the parent's prior-run rule turns the prior `confirmed` (changed source) into a `planned` unit, so the finding is re-checked rather than carried (parent §6.3). For `assessment` origins: call `retestAssessment(root, id, {queryAdvisories:true, …})` and read `comparison.notObserved` vs `comparison.unverified` (`findings.ts:15-18`). For `runtime_inventory` origins: re-run the detector on the fix branch; the row must classify as `fixed`.
5. **Closure (Phase 8c).** Every upstream skill ends with "fixes take effect only after deploying" (`fix-node-vuln/SKILL.md:55`). Loam therefore never marks a vulnerability `closed` from source alone. `fixed_pending_deploy` becomes `closed` only when Khamis records deploy evidence (a version string or digest observed from the running system, pasted or uploaded) in the UI, and that evidence matches the verified target.

The parent's evidence-assurance labels (`full | reduced-win32 | source-only`, parent §10.4) are carried onto remediation evidence when a log or artifact is promoted from a Docker scratch directory (§5.5).

### 3.3 Relationship to `src/security/repairs.ts`

OBSERVED: `repairs.ts` supports exactly one finding class (`check==='source_html'`, JS/TS only, `repairs.ts:7,9`), writes drafts under `.loam/security/repairs/<uuid>.json` with mode `0o600` (`:27,37`), keeps a `.before` backup and a `pending` journal for crash recovery (`:42-50,70-71`), requires `input.reviewed === true` (`:60`), and refuses while an assessment is active (`:61`). Its own warning says a repair "is a repair proposal for a static indicator, not proof of a vulnerability or a verified fix" (`:36`).

Decision: **Remediate does not extend `repairs.ts`.** Different unit of change (repo branch vs single token), different proof (artifact version + tests vs AST match). Remediate reuses the same *disciplines*: hash-bound drafts, durable writes (`durableWrite`, `:28`), journal-based recovery, `reviewed:true`, and the `assessmentActive(root)` lock (`assessments.ts:46`). It also keeps the honest wording: a remediation PR is "not deployed and not closed".

### 3.4 Relationship to `src/security/dependencies.ts`

OBSERVED: package-level OSV matches carry `ids[]` but no fixed version (`dependencies.ts:6`). Decision: Remediate's `package` ecosystem resolver fetches each OSV id's `affected[].ranges[].events[].fixed` from `https://api.osv.dev/v1/vulns/<id>` and then verifies the fixed version exists in the registry the lockfile resolves from (`npm view <name>@<version> version --json` against the configured registry). The smallest fixed version ≥ current within the same major is the target; a cross-major target is an "upgrade requiring approval", like the Node/PHP major rule. No version is chosen without both facts.

### 3.5 Relationship to the approved Cloudflare-derived audit skill

The parent spec is derived from `cloudflare/security-audit-skill` (MIT, commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`; parent header). That design finds and proves vulnerabilities (hunt, validate, confirm-before-report). devin-vuln-fixes fixes **known, published** runtime vulnerabilities. They meet at the parent's "known-bad version" fast path (parent §6.2) and nowhere else: the audit never patches, and Remediate never hunts. Together they give Loam detect → prove → fix → verify → re-scan.

### 3.6 Net-new value summary

1. Runtime inventory across Dockerfiles, version files, CI, IaC, config management and managed runtimes.
2. Advisory packs: machine-checked fixed versions with source URLs.
3. Verified-target resolution with recorded evidence.
4. Before/after tests inside the built artifact, with a deterministic regression diff.
5. Three persisted, hash-bound approval gates.
6. One draft PR per repo with deterministic body (risk, rollout, rollback, mitigations-as-mitigations).
7. Re-scan and an honest closure model.

### 3.7 Dogfood finding: Loam itself (OBSERVED 2026-10-25)

- `package.json:127` → `"electron": "^44.7.2"`; `package-lock.json` resolves `node_modules/electron` to `44.7.2` (command: `node -e 'console.log(require("./package-lock.json").packages["node_modules/electron"].version)'`).
- `https://releases.electronjs.org/release?channel=stable&major=v44` lists 44.7.2 with **Node.js 24.21.0** and the newest 44.x, 44.9.3, with **Node.js 24.22.0**.
- CVE-2026-111497 is fixed in Node **24.22.1** (`https://nodejs.org/en/blog/release/v24.22.1`). 24.21.0 and 24.22.0 are below it.
- `https://releases.electronjs.org/schedule` lists Node `v24.22.1` for 46.0.0 (stable Jan 5, 2027, tentative) and 47.0.0.

Correct Remediate output (and acceptance test D-7): row `package.json:127 · electron · bundled-runtime · node 24.21.0 · affected (CVE-2026-111497 and others in the Oct 21 release)` → status `vendor_update_required`, target `none verified`, next step "watch Electron releases/advisories for a release that names CVE-2026-111497 or bundles Node ≥ 24.22.1, then bump `electron`, rebuild, re-sign, ship through the update channel". Bumping to 44.9.3 would be a **guessed** fix (newer string, not a fixed artifact) and must not be proposed. INFERRED: Electron may backport fixes without changing the reported Node version; the resolver therefore also accepts an Electron release note or advisory that names the CVE as verification evidence (`TargetEvidence.kind:"vendor_advisory_entry"`).

Second dogfood signal: Loam's `engines.node ">=22.13.0"` (`package.json:5-6`) is a constraint, not a runtime pin. Per `fix-node-vuln/SKILL.md:42` it is left unchanged.

---

## 4. Approach — options and recommendation

### 4.1 Option (a) — Adopt the three skills into Loam's skills as-is, with a rules wrapper

Copy `skills/fix-*-vuln/` into Loam's `skills/` (or let users `npx skills add`), add a wrapper skill that restates Khamis's rules, and rely on existing tools (`shell_run`, `git_*`, `pr_create`).

- Pros: zero engine code; immediate; MIT allows verbatim reuse with notice; upstream bumps arrive via copy.
- Cons: every guarantee is prose. Security mode does not expose `git_*`, `pr_create`, `WRITE`, or `skill_view` (`src/modes/catalog.ts:68`), so the skills cannot even run there without widening the mode; in Build mode they run with `shell_run` on the host — no image isolation, no recorded approvals, no evidence ids. Loam's frontmatter parser keeps the surrounding quotes of the quoted `description` (`src/tools/skills.ts:75-94` assigns the raw value after `trim()`) and ignores `license`/`compatibility`/`metadata`. Conflicts with the parent spec's D2 clean-rewrite decision.
- Verdict: **reject as the product**; keep as the source of ecosystem knowledge.

### 4.2 Option (b) — Rebuild the pipeline natively in `repairs.ts` + Security mode

Encode all ecosystem knowledge in TypeScript inside `src/security/repairs.ts` and Security-mode tools; no skills.

- Pros: everything enforced; one place.
- Cons: `repairs.ts` is a single-token AST editor with a different unit of change; stuffing repo-level remediation into it breaks its tested invariants (`docs/security-reviewed-repairs.md`). Ecosystem nuance (Lambda update modes, `state=present`, chart mappings, floating-tag drift) is judgement-heavy and changes with each advisory; hard-coding it means a code release for every vendor bump. Loses the agent-neutral playbooks that make new ecosystems cheap.
- Verdict: **reject**.

### 4.3 Option (c) — Hybrid (recommended)

- **Engine (code, enforced):** new `src/security/remediate/` owns the state machine, gates, inventory detectors, advisory-pack loader, `TargetResolver`, Docker build/test runner, test-run comparison, fix gate, PR planner, re-scan hooks, and the run store. Nothing that the rules depend on is left to the model.
- **Advisory packs (data, reviewed):** `security/advisories/*.json` with product, lines, fixed versions, CVE ids, source URLs, known backports, mitigations, forbidden actions. Bumps go through Loam's existing staged-write approval (§6.4.5).
- **Playbook skills (guidance, Loam-authored):** `skills/remediate-node-runtime`, `skills/remediate-php-runtime`, `skills/remediate-gitlab-selfmanaged`, `skills/remediate-electron-bundled-runtime`, plus the umbrella `skills/remediate/SKILL.md`. They tell the model how to read a repo and propose rows/edits; the engine validates every proposal. Text written fresh (D2-consistent), with MIT attribution to Cognition AI.
- **Agents:** a read-only `remediate-inventory` child per repo (≤ 4 concurrent, Loam semaphore) proposes inventory rows and edit plans as strict JSON; the engine applies edits itself through a bounded file-edit API and never gives the child write or shell tools.

Tradeoffs grounded in the MIT licence: MIT allows option (a) verbatim, so the rewrite in (c) is a policy choice (consistency with D2 and Arabic-first copy), not a legal requirement. If Khamis prefers to ship upstream text verbatim inside the playbooks, that is lawful with the notice in §10.4 — OD-2.

### 4.4 Comparison

| Criterion | (a) As-is | (b) Native only | (c) Hybrid |
|---|---|---|---|
| Approval gate enforced in code | No | Yes | **Yes** |
| No-guess rule enforced in code | No | Yes | **Yes** |
| Before/after in image, machine-compared | No | Yes | **Yes** |
| Cost of a vendor version bump | Copy skill | Code release | **Edit pack JSON + review** |
| New ecosystem cost | New skill | New TS module | **Pack + playbook + detector** |
| Fits Security mode restrictions | No | Yes | **Yes** (dedicated tools) |
| Licence | MIT verbatim OK | n/a | MIT attribution kept |
| Consistency with parent D2 | No | Yes | **Yes** |

**Recommendation: (c) Hybrid.**

---

## 5. Security and trust integration

### 5.1 Rule → enforcement map

| Rule (source) | Where enforced in Loam Remediate | Failure behaviour |
|---|---|---|
| Discovery is read-only (upstream `:58`/`:57`/`:53`; Khamis) | Inventory children get the read-only `remediate-inventory` profile (READ tools + `code_symbols`; no `WRITE`, no `shell_run`, no network) built with `buildSubagentToolRegistry` (`src/tools/subagents.ts:188`; parent §8.1); engine writes only under `<DATA_DIR>/security-remediations/` | A child result containing an edit is discarded (strict JSON, never repaired) |
| Do not edit before approval (upstream Forbidden #1) | `RemediationRun.state` must be `scope_approved` and the repo must be in `ScopeApproval.repos[]`; `assertRepoApproved(run, repoId)` called by every mutating function | Throws `RemediationError(409, "repo not approved")` |
| Approval binds to what was shown | `ScopeApproval.planHash` = SHA-256 of canonical JSON of the inventory rows + proposed targets the UI rendered | Mismatch → 409 "plan changed; review again" |
| No guessed versions (upstream Forbidden #2) | `TargetResolver` accepts a target only from an advisory pack **and** existence evidence; `ProposedEdit.newValue` must equal `TargetVerification.target.value` | Edit rejected; row → `blocked:no_verified_target` |
| Fixed = artifact contains the fix (`README.md:90`) | Fix gate requires `ArtifactVersionProof` from inside the after-image (`node -v`, `php -v`, SBOM, package release) matching a pack fixed version | `patched_unverified` |
| New failures / deprecations are regressions (`fix-node-vuln/SKILL.md:46`) | `compareTestRuns(baseline, after)` deterministic diff | `regression`; bump stays uncommitted |
| Major upgrade only with approval (Node `:72`, PHP `:18`) | `ScopeApproval.allowMajorUpgrade[repoId]`, `allowMinorUpgrade`, `allowBaseOsChange`, `allowAppCodeChange` flags | Row → `blocked:needs_upgrade_approval` |
| Never commit on protected branches; never force-push | Reuse `git_commit`/`git_branch` (`gitWorkflowTools.ts:5-9,31`); Remediate branch name `loam/remediate/<advisoryId>/<runShort>` | Refused by existing code |
| Push + PR need explicit approval | GATE 3 + existing `approvePush` path (`gitWorkflowTools.ts:87-89`) | No push, no PR; PR body file still written locally |
| No production commands (GitLab Forbidden; Khamis) | Command allow-list in `buildRunner.ts`; no `ssh`, `kubectl`, `helm upgrade/install`, `terraform apply`, `gitlab-*`, registry `push` | Command refused; recorded as policy violation |
| Mitigation is not a fix (PHP Forbidden) | `Mitigation` type is separate from `FixProposal`; report renders mitigations under "Temporary mitigations (not a fix)" | Type system prevents mixing |
| Secrets never printed (Khamis) | Env allow-list, registry creds via Loam vault references only, log redaction (§5.7) | Redaction failure ⇒ log not attached, `evidence.redaction:"failed"` |
| Local model excluded (Khamis) | `remediate.model` rejects `ollama:*` / local providers | Start refused |
| Third-party messaging forbidden (Khamis) | PRs only to repos whose owner is in `remediate.allowedOwners` (default `["khamis1992"]`); comments/issues never created | GATE 3 refuses foreign owners |

### 5.2 The three gates

All gates are **persisted** records in the run store (not the in-memory 15-minute `approvals` map at `src/server/approvals.ts:26-34`, which is bounded and TTL-based and unsuitable for multi-day remediation). They are decided only through the UI/HTTP endpoints in §6.6, which require the local token (`x-loam-local-token`) and a same-origin request. No model tool can decide a gate.

**GATE 1 — Scope approval (`awaiting_scope_approval → scope_approved`).**
Shown: the full inventory table, unsearchable repos, per-row proposed target and its verification status, risk label, upgrade class (patch/minor/major/base-OS), downtime notes (GitLab single-node), likely app-code changes, and temporary mitigations. Khamis selects rows (not just repos) and ticks the upgrade-class allowances. Stored: `ScopeApproval { planHash, repos[], rows[], allow*, decidedAt, decidedBy:"user" }`.

**GATE 2 — Commit approval (`awaiting_commit_approval → commit_approved`), per repo.**
Shown: the exact diff (unified), baseline vs after test comparison, runtime diff, smoke result, fix-gate verdict, PR body preview. Stored with `diffHash` (SHA-256 of the unified diff) and `prBodyHash`. If the working tree changes after approval, the commit is refused.
If the fix gate verdict is `regression`, GATE 2 offers only "discard branch" or "keep uncommitted for manual work"; it cannot commit. If `patched_unverified` (e.g. Docker unavailable), commit is allowed only with an explicit checkbox «أوافق على حفظ تعديل غير مُتحقَّق — يجب أن يثبته CI», and the PR title gets the prefix `[unverified]`.

**GATE 3 — Push and PR approval (`awaiting_pr_approval → pr_opened`), per repo.**
Shown: remote, owner, branch name, base branch, draft flag (default `true`), final PR body. Executes `git_branch {push:true, approvePush:true}` which itself raises Loam's existing approval (`gitWorkflowTools.ts:87-89`) — so pushing still requires the live approval card, a deliberate double confirmation — then `PrProvider.createPr({…, draft:true})`.

**Granularity default:** GATE 1 per run (row-level selection), GATE 2 and GATE 3 per repo. OD-4 offers coarser options.

### 5.3 Verified-target rule ("no version guessing")

A `TargetVerification` is `verified` only when **both** hold:
1. **Pack membership.** The target value is in the advisory pack's `fixedReleases` for the row's line (or a pack `knownBackports` entry for distro packages), and the pack file hash matches the reviewed hash in `security/advisories/index.json`.
2. **Existence evidence.** At least one `TargetEvidence` of an accepted kind for the channel:

| Channel | Accepted evidence kinds | How obtained (read-only) |
|---|---|---|
| Image tag | `registry_manifest` (digest + media type + platforms) | `docker buildx imagetools inspect <image>:<tag> --format '{{json .Manifest}}'`; fallback registry v2 `HEAD /v2/<name>/manifests/<tag>` with `Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json` |
| Digest pin | `registry_manifest` (resolved digest) | same; per-platform digest recorded for floating tags |
| Version file / setup action | `vendor_release_index` | Node: `https://nodejs.org/dist/index.json` contains `"version":"v22.23.4"`; PHP: `https://www.php.net/releases/index.php?json&version=8.3` returns `8.3.36` |
| Distro package | `distro_changelog_entry` (package release + CVE line) | `apt-get changelog` / `apk` / `dnf updateinfo` **inside a throwaway container of the same base image**, network allowed only to the distro mirror |
| Source tarball | `tarball_checksum` | php.net release JSON `sha256` matches download |
| Backport commit | `commit_exists` | `git ls-remote https://github.com/php/php-src <sha>` |
| Helm chart | `chart_version_mapping` + `chart_index_entry` | GitLab version-mapping page row; `helm search repo gitlab/gitlab -l --output json` against the repo's chart repo |
| Omnibus package | `package_repo_entry` | `packages.gitlab.com` index for `gitlab-ee=<ver>-ee.0` or the mirror configured in the IaC |
| npm package (OSV) | `osv_fixed_event` + `registry_package_version` | `https://api.osv.dev/v1/vulns/<id>`; `npm view <name>@<ver> version --json --registry <configured>` |
| Bundled runtime (Electron) | `vendor_release_index` showing bundled Node ≥ fixed **or** `vendor_advisory_entry` naming the CVE | `https://releases.electronjs.org/releases.json` (UNKNOWN shape; see U-3) or the release page; Electron GHSA list |

If no evidence can be obtained (host blocked, mirror unreachable), the verification is `unverified` with `reason` set to the exact failure (`"registry HEAD 403 from registry.example.com"`), never silently `verified`. If the registry answers "not found", status is `not_found` and the row is `blocked:no_verified_target`.

All fetched content is **untrusted data** (§5.6). Only the specific fields named above are extracted; nothing fetched is passed to a model as instructions.

### 5.4 The fix gate (`evaluateFixGate`)

Modelled on `evaluateEvidenceGate` (`src/security/orchestrator.ts:223-248`): ordered rules, explicit reason, never upgrades.

```ts
export function evaluateFixGate(input: FixGateInput): FixGateResult {
  const { verification, artifactProof, comparison, smoke, policy } = input;
  if (verification.status === "not_found") return result("blocked", "fix target does not exist in the registry or mirror");
  if (policy.dockerAvailable === false) {
    return result("patched_unverified", `before/after tests not run: ${policy.dockerBlocker ?? "Docker unavailable"}`);
  }
  if (!comparison || comparison.baseline.status === "not_run" || comparison.after.status === "not_run") {
    return result("patched_unverified", "baseline or after test run missing");
  }
  if (comparison.newFailures.length > 0 || comparison.newDeprecations.length > 0) {
    return result("regression", `new failures: ${comparison.newFailures.length}; new deprecations: ${comparison.newDeprecations.length}`);
  }
  if (smoke && smoke.status === "failed") return result("regression", `smoke failed: ${smoke.reason}`);
  if (!artifactProof || !artifactProof.matchesFixedRelease) {
    return result("patched_unverified", "after-artifact did not report a fixed release");
  }
  if (verification.status === "unverified") {
    return result("patched_unverified", `target existence unverified: ${verification.reason}`);
  }
  return result("verified_fixed", "");
}
```

Notes: `verified_fixed` means "verified in source and in the locally built artifact", not "deployed". Thin coverage does not block `verified_fixed` but sets `riskLabel:"high"` and a prominent PR note (`fix-node-vuln/SKILL.md:51,54`). GitLab rows have no app tests: their comparison is the IaC validation set (`helm template`, `helm lint`, `terraform validate`, `ansible-lint`, `docker compose config`) and the gate treats a new validation error as `regression`.

### 5.5 Evidence model

Every observation the engine relies on becomes a `RemediationEvidence` item:
- `id`: `EV####` from Loam's `nextEvidenceId()` (`src/security/orchestrator.ts:81`) for continuity with the pentest evidence vocabulary, **plus** `sha256` of the canonical JSON of the item so it is stable across processes (the `EV` counter is process-local, `:79-81`). INFERRED: this mirrors the "hybrid evidence identity" already recommended in the REA integration (REA spec §6, OD-1).
- `kind`: `inventory_hit | registry_manifest | vendor_release_index | distro_changelog_entry | tarball_checksum | commit_exists | chart_version_mapping | chart_index_entry | package_repo_entry | osv_fixed_event | registry_package_version | vendor_advisory_entry | build_log | test_log | runtime_diff | smoke_log | artifact_version | iac_validation | deploy_observation`.
- `assurance`: parent labels `full | reduced-win32 | source-only` for anything promoted from a Docker scratch dir (parent §10.4); `network` for fetched evidence (with `url`, `fetchedAt`, `httpStatus`, `bodySha256`).
- Logs are stored as files under the run store and referenced by path + SHA-256; they are redacted before hashing (§5.7).

### 5.6 Untrusted content and network policy

- Registry/vendor responses, repo files, build logs and test output are untrusted. They are parsed by code with field-level extraction and size caps (2 MB per response, 20 MB per run for network bodies — same caps as `src/security/dependencies.ts:73`), and wrapped with `markUntrusted()` (`src/policy/riskTier.ts:641`) before any excerpt reaches a model.
- New network tools are added to `UNTRUSTED_TOOL_NAMES` (`src/policy/riskTier.ts:291`): `remediation_inventory` is not network; `remediation_status`/`remediation_report` are not network; the resolver runs inside the engine, not as a model tool.
- **Build network policy (differs from the audit sandbox).** The parent sandbox uses `--network none` (`src/agent/backendSandbox.ts:134`) because audits must not fetch. Rebuilding an image with `--pull` and running `npm ci` requires network to the registry and package mirror. Remediate therefore uses two Docker profiles: `build` (network on, only during `docker build --pull` and dependency install steps, with the repo mounted read-only and the build context copied to scratch) and `test` (`--network none`, the parent's hardened flags). Design decision; see OD-7 and U-1.

### 5.7 Secrets

- Registry and Git credentials are referenced through Loam's vault (`vault_ref` is a Build-mode tool, `src/modes/catalog.ts:27`) and passed to Docker as `--secret id=…,src=…` build secrets or `DOCKER_CONFIG` pointing at a temp dir that is deleted after the step. Never as `--build-arg`, never as env in logs.
- Containers get an env file built from an allow-list (`CI=1`, `NODE_ENV=test`, `HOME=/tmp`, plus names the repo's CI declares as non-secret), following the parent's `scrubEnv` doctrine (parent §10.2).
- Logs pass through `redactSecrets()` (patterns: `npm_[A-Za-z0-9]{36}`, `ghp_[A-Za-z0-9]{36}`, `github_pat_[A-Za-z0-9_]{82}`, `glpat-[A-Za-z0-9_-]{20}`, `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, `(?i)(authorization|password|token|secret)\s*[:=]\s*\S+`) before storage; PR bodies include log **summaries** and hashes, never raw logs, unless Khamis ticks "attach redacted logs".

### 5.8 Scope

- Repos in scope: the active task workspace, plus repos Khamis lists explicitly in the start form (paths on disk or `owner/repo` that the GitHub connector can read). "Every repo the agent can reach" (upstream default, `fix-node-vuln/SKILL.md:17`) is **not** the Loam default. Design decision for safety.
- Remote clones for inventory are shallow (`git clone --depth 1 --filter=blob:none`) into `<DATA_DIR>/security-remediations/<runId>/repos/<repoId>`; Khamis's working checkouts are never modified. Patches are made in that clone, on a new branch.
- For a local workspace repo, Remediate uses `git worktree add <runstore>/worktrees/<repoId> -b loam/remediate/...` so the user's working tree and uncommitted files are untouched. Never `reset`, never `stash`, never `checkout` in the user's tree.

### 5.9 STRIDE delta (this integration only)

| Threat | Vector | Mitigation |
|---|---|---|
| Spoofing | Fake registry response claiming a fixed tag exists | Digest + media type recorded; after-image `node -v`/`php -v` must match; pack membership required |
| Tampering | Advisory pack edited to a wrong version | Pack hash pinned in `index.json`; edits only via staged approval; CI test asserts every pack version has a source URL |
| Tampering | Repo content injects instructions into the inventory agent | Children read-only; output strict JSON; engine validates rows against files (line must contain the claimed signal) |
| Repudiation | "I never approved that" | Persisted gate records with hashes and timestamps |
| Information disclosure | Secrets in build logs/PRs | §5.7 redaction; summaries only by default |
| Denial of service | Huge repos/logs | Clone depth 1; per-step timeouts (§7 `RemediateLimits`); log caps 5 MB per step |
| Elevation of privilege | Build step runs as root with host mounts | Repo mounted read-only; build context in scratch; test container uses parent hardened flags; no host Docker socket mounted |

### 5.10 Rollback

Every PR body states the rollback target (previous digest/version) and that it is still vulnerable, plus temporary mitigations where the pack provides them (`fix-php-vuln/SKILL.md:53,68-73`). Locally, discarding a Remediate branch is `git worktree remove` + `git branch -D loam/remediate/...` on the run-store clone only, after GATE-2 "discard" — never on the user's tree.

---

## 6. Exact wiring points in Loam (file-by-file written spec)

**Nothing in this section is committed code.** Every path is a proposed placement grounded on OBSERVED trees. An implementing agent writes these files only after Khamis's coding approval.

### 6.1 Proposed file tree

```
src/security/remediate/
  index.ts                 public entry: startRemediation / getRemediation / listRemediations / cancelRemediation
  types.ts                 §7 types
  errors.ts                RemediationError (status + code)
  store.ts                 run store under <DATA_DIR>/security-remediations/<runId>/
  orchestrator.ts          state machine (§7.3)
  inventory/
    index.ts               runInventory(ctx): VulnRecord[]
    node.ts                Node signals (Dockerfile FROM node:, .nvmrc, .node-version, .tool-versions, Volta, setup-node, engines.node, binding.gyp, Lambda runtimes)
    php.ts                 PHP signals (php: images, php* packages, setup-php, composer.json, *.php, Helm/IaC)
    gitlab.ts              GitLab signals (gitlab-ee/ce images, CNG, Helm chart, Omnibus packages, Operator, source)
    electron.ts            Electron bundled-runtime signal (package.json "electron", lockfile resolution → releases.electronjs.org)
    packages.ts            Bridge from Assessment.inventory.advisories.matches and parent Confirmed known-bad-version records
    classify.ts            fixed / vulnerable / eol / unknown / vendor_update_required against a pack
  packs/
    loader.ts              load + hash + schema-validate advisory packs
    schema.ts              JSON Schema (hand-written, 16-keyword subset — same interpreter as parent §7.3)
  resolve/
    targetResolver.ts      §5.3
    registry.ts            docker buildx imagetools / registry v2 HEAD
    vendorIndex.ts         nodejs.org/dist/index.json, php.net releases JSON, electronjs.org releases
    osvFixed.ts            OSV /v1/vulns/<id> → fixed event
    npmRegistry.ts         npm view against configured registry
    helm.ts                chart version mapping + helm search
    distro.ts              throwaway container changelog lookup
  build/
    dockerProbe.ts         Docker availability → {available, blocker} (same shape as parent sandbox.ts)
    buildRunner.ts         docker build --pull --no-cache; two profiles (build-network / test-isolated)
    testRunner.ts          install + build + test inside image; capture logs
    compare.ts             compareTestRuns (deterministic)
    smoke.ts               start container, request health/main route, capture logs
    runtimeDiff.ts         node -p process.versions / php -m + php -i key values
    artifactProof.ts       node -v / php -v / SBOM / package release inside the after image
  edit/
    planEdits.ts           ProposedEdit[] from a verified target + pin style (exact/floating/digest)
    applyEdits.ts          bounded line-level edits; refuses if the line no longer matches the inventory signal
    worktree.ts            git worktree add / remove under the run store
  gate/
    scope.ts               GATE 1
    commit.ts              GATE 2
    pr.ts                  GATE 3
    fixGate.ts             evaluateFixGate (§5.4)
  pr/
    body.ts                deterministic PR_BODY.md template
    planner.ts             one branch + one commit + one PR plan per repo
    create.ts              wraps PrProvider.createPr with draft:true
  report/
    remediationMd.ts       REMEDIATION.md (Arabic header «نتريو» + tables)
    rollup.ts              roll-up table across repos
  rescan/
    index.ts               Phase 8: security_audit quick / retestAssessment / re-inventory
    close.ts               deploy-evidence → closed
  agent/
    inventoryPrompt.ts     rewritten (D2) inventory prompt → InventoryProposal JSON
    runInventoryAgent.ts   runAgentJson-style runner for remediate-inventory children
  __tests__/               §8 tests
security/advisories/
  index.json               reviewed pack list + hashes
  node-2026-10-21.json     §6.4.1
  php-2026-10-21.json      §6.4.2
  gitlab-2026-10-21.json   §6.4.3
  electron-bundled-node.json  §6.4.4
skills/
  remediate/SKILL.md                         umbrella playbook
  remediate-node-runtime/SKILL.md
  remediate-php-runtime/SKILL.md
  remediate-gitlab-selfmanaged/SKILL.md
  remediate-electron-bundled-runtime/SKILL.md
```

Packaging: add `- security/advisories/**/*` next to `- skills/**/*` in `electron-builder.yml:16` so packs ship inside the ASAR. Skills already ship.

### 6.2 Tool surface (Security mode)

Add four tools next to the existing `security_assess` / `security_status` (`src/modes/catalog.ts:68`, `src/tools/serviceBridgeTools.ts:62,80,171`).

```ts
// src/tools/remediateTools.ts (new)
export const REMEDIATE_TOOL_NAMES = [
  "remediation_start",
  "remediation_status",
  "remediation_report",
  "remediation_cancel",
] as const;

export function createRemediateTools(): Tool[] {
  return [
    {
      name: "remediation_start",
      description:
        "Start a verified vulnerability remediation run (inventory → approval gates → patch → before/after tests → one PR per repo → re-scan). Returns {run_id} immediately. Does not edit anything until the user approves GATE 1 in the UI.",
      parameters: {
        type: "object",
        properties: {
          advisory_ids: { type: "array", items: { type: "string" }, description: "Pack ids, e.g. ['node-2026-10-21']. Default: all enabled packs." },
          repos: { type: "array", items: { type: "string" }, description: "Workspace-relative paths or owner/repo. Default: the active workspace only." },
          from_audit_run: { type: "string", description: "Parent security-audit run id to seed known-bad-version records from." },
          from_assessment: { type: "string", description: "Assessment id to seed OSV matches from." },
          allow_docker: { type: "boolean", description: "Permit Docker build/test ([U2]). Default false until U2 is yes." },
        },
      },
      async run(args, ctx) { /* call startRemediation; return {ok, content: JSON.stringify({run_id})} */ },
    },
    {
      name: "remediation_status",
      description: "Stage, inventory counts by status, gate state, per-repo progress, fix-gate verdicts.",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args) { /* … */ },
    },
    {
      name: "remediation_report",
      description: "Paths to REMEDIATION.md, per-repo PR_BODY.md, and the first section of the report (or 'in progress').",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args) { /* … */ },
    },
    {
      name: "remediation_cancel",
      description: "Cancel a running remediation. Leaves worktrees and any uncommitted branches for the user to inspect; never force-deletes.",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args) { /* … */ },
    },
  ];
}
```

**Mode card update** (`src/modes/catalog.ts:66-69`):

```ts
{ id: "security", label: "Loam Security", labelAr: "افحص", icon: "🛡", hue: 0, hue2: 30,
  tagline: "تقييم أمني موجّه",
  description: "شغّل فحوصات أمنية محدودة وقراءة فقط ضد أهداف مصرّح بها، واجمع النتائج في تقرير Security/SARIF داخل المهمة. بعد الاكتشاف يمكنك تشغيل مسار الإصلاح المُتحقَّق (جرد → موافقة → ترقيع → اختبار قبل/بعد → طلب سحب واحد لكل مستودع → إعادة مسح).",
  outputHint: "تقرير ثغرات وتوصيات تصحيح، ومسار إصلاح مُتحقَّق عند الطلب. Use pentest_*/security_*/remediation_* tools; do not use generic shell scripts for security scans or remediation.",
  readOnly: false,  // was effectively read-only via tools; stays false because remediation_* are write-capable after approval
  tools: [
    "pentest_check", "pentest_routes", "pentest_report",
    "security_assess", "security_status",
    "remediation_start", "remediation_status", "remediation_report", "remediation_cancel",
    "skill_list", "skill_view",   // so the remediate playbooks are listed and readable
    "shell_run", ...READ, ...CONTROL,
  ],
  panels: ["files"],
  fields: [
    { id: "target", label: "الهدف المصرّح به", placeholder: "رابط أو مسار يمكن فحصه (مثلاً http://127.0.0.1:3000)" },
    { id: "checks", label: "نطاق الفحص", placeholder: "all، headers، tls، exposed_files، أو قائمة محددة" },
    { id: "remediate", label: "حزم الإصلاح", placeholder: "node-2026-10-21 أو php-2026-10-21 أو gitlab-2026-10-21 (فارغ = لا إصلاح)" },
  ],
  starters: [
    { label: "فحص ترويسات", prompt: "افحص ترويسات الأمان لـ http://127.0.0.1:3000 باستخدام pentest_check واحفظ النتائج." },
    { label: "تقرير ثغرات", prompt: "شغّل فحص pentest_check شامل ثم أنشئ تقرير pentest_report داخل مساحة المهمة." },
    { label: "أصلح ثغرة Node", prompt: "شغّل remediation_start مع advisory_ids: ['node-2026-10-21'] على مساحة المهمة، واعرض جدول الجرد وانتظر موافقتي قبل أي تعديل." },
  ],
}
```

No Sparkles icon. The new starter is the only new UI string that invites remediation.

**Risk tiers** (`src/policy/riskTier.ts`):
- `remediation_start` → `write-workspace-data` (starts a run; edits happen later behind gates).
- `remediation_status` / `remediation_report` → `read-only`.
- `remediation_cancel` → `write-workspace-data`.
- GATE endpoints are HTTP-only and are **not** model tools.

**Runtime registration** (`src/setup/runtime.ts:99` area): `registry.registerAll(createRemediateTools());` next to `pentestTools()`.

**Subagent profile** (in code, not in `agents/*.md`, same reason as parent §8.1):

| Profile | Tools | Cap |
|---|---|---|
| `remediate-inventory` | READ + `code_symbols` + `code_outline` + `semantic_search` + `ask_codebase` | Acquires `registry.acquireChild()`; process-wide max 4 (`src/subagent/registry.ts:5`). Inventory agents never get `shell_run`, WRITE, network, or `delegate_*`. |

### 6.3 PR provider: add `draft`

OBSERVED: `CreatePrInput` (`src/tools/gitPrProvider.ts:40-50`) has no `draft`; `GitHubProvider.createPr` (`:199-206`) POSTs `{title, head, base, body}` without `draft`; the local provider stores JSON under `.loam/prs`.

Proposed change (written here; not committed):

```ts
// src/tools/gitPrProvider.ts — CreatePrInput
export interface CreatePrInput {
  repo: string; title: string; head: string; base: string;
  body?: string;
  draft?: boolean;            // NEW — default false for existing callers; Remediate passes true
  number?: number;            // existing, local-provider only
}

// GitHubProvider.createPr
async createPr(input: CreatePrInput): Promise<PrInfo> {
  const data = await this.request("POST", `/repos/${input.repo}/pulls`, {
    title: input.title, head: input.head, base: input.base,
    body: input.body ?? "",
    draft: input.draft === true,
  });
  return normalizePr(data);
}

// LocalProvider.createPr — store draft: input.draft === true in the JSON; surface it in PrInfo.
```

Existing callers (no `draft` arg) keep today's behaviour. OD-5 chooses whether Remediate defaults to draft.

### 6.4 Advisory packs (full content)

#### 6.4.1 `security/advisories/node-2026-10-21.json`

```json
{
  "id": "node-2026-10-21",
  "product": "nodejs",
  "title": "Node.js October 21, 2026 security release",
  "published": "2026-10-21",
  "sourceUrls": [
    "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases",
    "https://nodejs.org/en/blog/release/v22.23.4",
    "https://nodejs.org/en/blog/release/v24.22.1",
    "https://nodejs.org/en/blog/release/v26.12.1"
  ],
  "cves": [
    { "id": "CVE-2026-111497", "severity": "high", "summary": "Brotli decoder out-of-bounds write permits RCE" },
    { "id": "CVE-2026-105482", "severity": "high", "summary": "dns: validate resolve inputs for null bytes" },
    { "id": "CVE-2026-105483", "severity": "high", "summary": "tls: fix ip normalization regression" },
    { "id": "CVE-2026-106069", "severity": "high", "summary": "tls: reject non-canonical IP addresses" },
    { "id": "CVE-2026-106072", "severity": "high", "summary": "tls: reject non-canonical IP addresses (companion)" },
    { "id": "CVE-2026-105481", "severity": "medium", "summary": "http: ensure agent data guard works without I/O" },
    { "id": "CVE-2026-106074", "severity": "medium", "summary": "crypto: reset random caches across snapshots" },
    { "id": "CVE-2026-106073", "severity": "low", "summary": "permission: check permission model in realpathSync" }
  ],
  "lines": [
    { "line": "22", "status": "supported", "fixed": "22.23.4", "variant": "Jod LTS" },
    { "line": "24", "status": "supported", "fixed": "24.22.1", "variant": "Krypton LTS" },
    { "line": "26", "status": "supported", "fixed": "26.12.1", "variant": "Current" },
    { "line": "20", "status": "eol", "fixed": null, "upgradePath": ["22.23.4", "24.22.1"] },
    { "line": "18", "status": "eol", "fixed": null, "upgradePath": ["22.23.4"] }
  ],
  "bundledUpdates": ["c-ares", "OpenSSL (22/24)", "SQLite (22)", "Undici", "CA certs (eMudhra Intermediate CA removal)"],
  "priorities": [
    "Internet-facing services that decompress Brotli (HTTP clients/servers, proxies, zlib.createBrotliDecompress)",
    "TLS clients that connect to user-supplied hosts"
  ],
  "forbidden": [
    "Do not guess image tags, digests, or package versions",
    "Do not do a major Node upgrade without explicit approval",
    "Do not change base distribution or image flavor without saying so"
  ],
  "mitigations": [],
  "notes": "Electron apps, vendor images and appliances bundle their own Node — flag for vendor updates; do not patch the host Node and claim the app is fixed."
}
```

#### 6.4.2 `security/advisories/php-2026-10-21.json`

```json
{
  "id": "php-2026-10-21",
  "product": "php",
  "title": "PHP2Shell — CVE-2026-109618 / CVE-2026-109619",
  "published": "2026-10-21",
  "sourceUrls": [
    "https://www.php.net/archive/2026.php#2026-10-21-5",
    "https://thephp.foundation/blog/2026/10/21/todays-php-security-release-and-how-were-strengthening-php-security/",
    "https://www.kb.cert.org/vuls/id/763488",
    "https://github.com/advisories/GHSA-w8hw-w9fx-j79w",
    "https://github.com/advisories/GHSA-6wmf-4rv5-p3rp"
  ],
  "cves": [
    { "id": "CVE-2026-109618", "ghsa": "GHSA-w8hw-w9fx-j79w", "severity": "critical", "cvssV4": 9.2, "summary": "RCE via OOM corruption" },
    { "id": "CVE-2026-109619", "ghsa": "GHSA-6wmf-4rv5-p3rp", "severity": "critical", "cvssV4": 9.2, "summary": "RCE via stale global state / use-after-free" }
  ],
  "lines": [
    { "line": "8.5", "status": "supported", "fixed": "8.5.12" },
    { "line": "8.4", "status": "supported", "fixed": "8.4.27" },
    { "line": "8.3", "status": "supported", "fixed": "8.3.36" },
    { "line": "8.2", "status": "supported", "fixed": "8.2.35" },
    { "line": "8.1", "status": "eol-upstream", "fixed": null, "upgradePath": ["8.2.35", "8.3.36"], "sourceBackportsAvailable": true },
    { "line": "8.0", "status": "eol-upstream", "fixed": null, "upgradePath": ["8.2.35"], "sourceBackportsAvailable": true },
    { "line": "7.4", "status": "eol-upstream", "fixed": null, "upgradePath": ["8.2.35"], "sourceBackportsAvailable": true }
  ],
  "knownBackports": [
    { "distro": "debian", "suite": "bookworm", "package": "php8.2", "release": "8.2.35-1~deb12u1" },
    { "distro": "ubuntu", "suite": "noble", "package": "php8.3", "release": "8.3.6-0ubuntu0.24.04.13" },
    { "distro": "ubuntu", "suite": "jammy", "package": "php8.1", "release": "8.1.2-1ubuntu2.28" }
  ],
  "sourceTarballSha256": {
    "8.4.27.tar.xz": "dcf93923b0e38e0d5252b25b796520b5a47761a08b3488b6d0b5d1115764d3f0"
  },
  "sapisAtRisk": ["mod_php", "fpm", "php-cgi", "FrankenPHP", "LiteSpeed", "php -S (not for production)"],
  "mitigations": [
    { "id": "upload-progress-off", "summary": "session.upload_progress.enabled=0 in php.ini or FPM pool (not ini_set / .user.ini); restart every worker", "isFix": false },
    { "id": "fatal-backtraces-off-85", "summary": "On 8.5: fatal_error_backtraces=0", "isFix": false },
    { "id": "post-max-size", "summary": "post_max_size 8M without uploads, or 32M with uploads", "isFix": false },
    { "id": "proxy-limits", "summary": "Proxy limits on body size, field count, multipart part count, header count and nesting depth", "isFix": false },
    { "id": "memory-limit-with-cgroup", "summary": "memory_limit=-1 combined with a container/cgroup memory limit", "isFix": false }
  ],
  "forbiddenMitigations": ["RLIMIT_AS", "RLIMIT_DATA"],
  "forbidden": [
    "Do not present a mitigation as a fix",
    "Do not use RLIMIT_AS or RLIMIT_DATA as a mitigation",
    "Do not change the SAPI, base distribution, image flavor, extensions, or build flags without saying so",
    "Do not guess image tags, digests, or package versions"
  ],
  "notes": "An unverified claim that the 8.5.12 fix is incomplete circulated on oss-security; check the PHP advisories before rollout. remirepo.net had no same-day update — prefer distro packages or source builds."
}
```

#### 6.4.3 `security/advisories/gitlab-2026-10-21.json`

```json
{
  "id": "gitlab-2026-10-21",
  "product": "gitlab-self-managed",
  "title": "GitLab CVE-2026-110264 critical patch (Onigmo integer overflow RCE)",
  "published": "2026-10-21",
  "sourceUrls": [
    "https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-5-1-released/",
    "https://nvd.nist.gov/vuln/detail/cve-2026-110264"
  ],
  "cves": [
    { "id": "CVE-2026-110264", "severity": "critical", "cvss": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", "cvssScore": 10.0, "summary": "Unauthenticated RCE via Onigmo regex compiler integer overflow" },
    { "id": "CVE-2026-97229", "severity": "critical", "cvssScore": 10.0, "summary": "Included from the October 8 fix (19.4.2 / 19.3.5 / 19.2.8)", "includedVia": "same patch release" }
  ],
  "lines": [
    { "line": "19.5", "status": "supported", "fixed": "19.5.1", "chart": "10.5.1" },
    { "line": "19.4", "status": "supported", "fixed": "19.4.3" },
    { "line": "19.3", "status": "supported", "fixed": "19.3.6" },
    { "line": "19.2", "status": "supported", "fixed": "19.2.9" },
    { "line": "19.1", "status": "supported", "fixed": "19.1.9" },
    { "line": "19.0", "status": "supported", "fixed": "19.0.10" },
    { "line": "18.11", "status": "supported", "fixed": "18.11.13", "chart": "9.11.14" }
  ],
  "affectedFrom": "7.0",
  "scope": "self-managed only; GitLab.com and GitLab Dedicated already patched",
  "upgradePathTool": "https://gitlab-com.gitlab.io/support/toolbox/upgrade-path/",
  "chartMappingUrl": "https://docs.gitlab.com/charts/installation/version_mappings/",
  "imageTags": {
    "ee": "gitlab/gitlab-ee:<ver>-ee.0",
    "ce": "gitlab/gitlab-ce:<ver>-ce.0"
  },
  "postDeployChecklist": [
    "gitlab-rake gitlab:env:info shows the fixed version",
    "gitlab-rake gitlab:check",
    "gitlab-ctl status (or pod readiness on Helm)",
    "Background migrations completed",
    "Web, Git over SSH and HTTPS, and CI runners working"
  ],
  "threatDetections": [
    "Onigmo native worker crash",
    "Org mode render error burst"
  ],
  "outOfScope": ["GitLab Runner", "GitLab Agent"],
  "forbidden": [
    "Do not skip required upgrade-path stops or tell the user to skip migrations",
    "Do not change the edition (CE↔EE) or deployment type",
    "Do not run commands against a production GitLab instance",
    "Do not guess image tags, chart versions, or package versions"
  ]
}
```

#### 6.4.4 `security/advisories/electron-bundled-node.json`

```json
{
  "id": "electron-bundled-node",
  "product": "electron-bundled-nodejs",
  "title": "Electron apps bundle their own Node — track vendor updates for Node CVEs",
  "published": "2026-10-25",
  "sourceUrls": [
    "https://releases.electronjs.org/release?channel=stable&major=v44",
    "https://releases.electronjs.org/schedule",
    "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases"
  ],
  "tracksAdvisory": "node-2026-10-21",
  "lines": [],
  "verifiedFixedElectronReleases": [],
  "observedAsOf": "2026-10-25",
  "observed": [
    { "electron": "44.7.2", "bundledNode": "24.21.0", "vsFixed": "below 24.22.1" },
    { "electron": "44.9.3", "bundledNode": "24.22.0", "vsFixed": "below 24.22.1" }
  ],
  "scheduleHint": "Electron schedule lists Node v24.22.1 for 46.0.0 (stable ~2027-01-05) and 47.0.0",
  "policy": "Never propose an Electron bump unless verifiedFixedElectronReleases contains a release whose bundledNode is ≥ the tracked pack's fixed version for that line, OR a vendor_advisory_entry names the CVE. Otherwise classify vendor_update_required.",
  "forbidden": [
    "Do not treat a newer Electron version string as a fix without bundled-Node or advisory evidence",
    "Do not claim the host Node upgrade fixes an Electron app"
  ]
}
```

#### 6.4.5 Pack bump process

1. Author edits `security/advisories/<id>.json` and updates `index.json` with the new SHA-256.
2. The edit is staged through Loam's existing `WriteGate` (`src/server/pending.ts:18`) as kind `advisory_pack_bump` (extend `PendingKind` at `:7`).
3. Khamis reviews the diff and the source URLs in `/learning.html` (or the Security panel) and approves.
4. CI test `test:remediate-packs` asserts: every `fixed` has a `sourceUrls` entry; every pack parses against `packs/schema.ts`; every `sourceUrls` URL returns HTTP < 400 at review time (recorded, not a hard gate on offline builds); `verifiedFixedElectronReleases` entries have evidence.

`index.json` shape:

```json
{
  "reviewedAt": "2026-10-25T10:25:00+03:00",
  "packs": [
    { "id": "node-2026-10-21", "file": "node-2026-10-21.json", "sha256": "<computed at review>", "enabled": true },
    { "id": "php-2026-10-21", "file": "php-2026-10-21.json", "sha256": "<computed at review>", "enabled": true },
    { "id": "gitlab-2026-10-21", "file": "gitlab-2026-10-21.json", "sha256": "<computed at review>", "enabled": true },
    { "id": "electron-bundled-node", "file": "electron-bundled-node.json", "sha256": "<computed at review>", "enabled": true }
  ]
}
```

### 6.5 Inventory detectors (signal → row)

Each detector returns `InventoryHit[]`; `classify.ts` joins them to packs.

**Node (`inventory/node.ts`) — signals from `fix-node-vuln/SKILL.md:22-29`:**

| Signal | Match (regex / parse) | Pin style |
|---|---|---|
| Dockerfile `FROM node:<tag>` / `FROM …/node:<tag>` (incl. multi-stage) | `^\s*FROM\s+(\S*node):(\S+)` | exact / floating / digest (`@sha256:`) |
| `.nvmrc`, `.node-version` | whole-file trim | exact |
| `.tool-versions` | `^nodejs\s+(\S+)` | exact |
| `package.json` `volta.node` | JSON path | exact |
| `actions/setup-node` `node-version:` / `node-version-file:` | YAML | floating or file-ref |
| CI image that is a Node image | same as Dockerfile | — |
| NodeSource / OS `nodejs` packages | apt/apk/dnf lines | package |
| Serverless: `Runtime: nodejs22.x`, `nodejs20.x`, Cloud Functions / Azure Functions Node | YAML/JSON | managed |
| Helm/Terraform/Ansible installing Node | resource names + version args | iac |
| `engines.node` | JSON | constraint (signal only; not a pin) |
| `binding.gyp` / `node-gyp` | presence | upgrade-risk signal |
| Import assertions `assert {` | presence | upgrade-risk for Node ≥ 22 |

**PHP (`inventory/php.ts`) — from `fix-php-vuln/SKILL.md:22-27`:** `php:` images; `php*` OS packages; `setup-php`; source `./configure` / tarball URLs; Helm/Kustomize/Terraform/Packer/Ansible/Chef/Puppet; `composer.json`/`composer.lock` and `*.php` as usage signals; SAPI inferred from image variant (`-fpm`, `-apache`) or package name.

**GitLab (`inventory/gitlab.ts`) — from `fix-gitlab-vuln/SKILL.md:22-27`:** `gitlab/gitlab-ee`, `gitlab/gitlab-ce`, `registry.gitlab.com/gitlab-org/build/cng/*`; Helm chart `charts.gitlab.io` / Operator; Omnibus packages in Ansible/Chef/Puppet/cloud-init/Packer; Terraform modules and AMIs; source checkouts of `gitlab-foss`/`gitlab`.

**Electron (`inventory/electron.ts`):** `package.json` `"electron"` (dependencies or devDependencies); resolve exact version from the lockfile; look up bundled Node on `releases.electronjs.org`; classify against `electron-bundled-node` + the tracked Node pack.

**Validation:** every hit's `file:line` must contain the claimed signal text when the engine re-reads the file; otherwise the hit is dropped and logged. This is the machine answer to inventory-agent hallucination.

### 6.6 HTTP / UI wiring

**HTTP** (extend the `/api/security/` block at `src/server/http.ts:772`):

| Method | Path | Auth | Body / result |
|---|---|---|---|
| GET | `/api/security/remediations` | local token | `{ runs: RemediationRunSummary[] }` |
| POST | `/api/security/remediations` | local token | start; body = `RemediationStartInput`; 202 `{ run }` |
| GET | `/api/security/remediations/:id` | local token | full run |
| POST | `/api/security/remediations/:id/cancel` | local token | cancel |
| GET | `/api/security/remediations/:id/report` | local token | `{ paths, firstSection, in_progress }` |
| POST | `/api/security/remediations/:id/approve-scope` | local token + same-origin | `{ planHash, repos, rows, allow* }` → GATE 1 |
| POST | `/api/security/remediations/:id/repos/:repoId/approve-commit` | local token + same-origin | `{ diffHash, prBodyHash, acceptUnverified? }` → GATE 2 |
| POST | `/api/security/remediations/:id/repos/:repoId/approve-pr` | local token + same-origin | `{ remote, base, draft }` → GATE 3 |
| POST | `/api/security/remediations/:id/repos/:repoId/discard` | local token + same-origin | drop uncommitted branch / worktree |
| POST | `/api/security/remediations/:id/close` | local token + same-origin | `{ fingerprint, deployEvidence }` → Phase 8c |

Same-origin check mirrors the browser-evidence rule at `src/server/http.ts:802` (`sec-fetch-site === "cross-site"` → 403).

**UI** (`ui/security.html` + `ui/security.js`, OBSERVED 152-line panel with Arabic copy and the reviewed-repair checkbox at `:88-91`):
- New tab «الإصلاح المُتحقَّق» next to the existing assessment history.
- Inventory table (Arabic headers): المستودع · الملف:السطر · الإشارة · الإصدار الحالي · التثبيت · الحالة · الهدف · الدليل · المخاطر.
- GATE 1 form: checkboxes per row; upgrade-class ticks; «أوافق على نطاق الإصلاح» button (enabled only when `planHash` matches).
- Per-repo panel after GATE 1: diff (dir=ltr), baseline vs after, runtime diff, smoke, fix-gate verdict, GATE 2 checkbox «راجعت الفرق ونتائج الاختبار وأوافق على الالتزام», GATE 3 checkbox «أوافق على الدفع وفتح طلب سحب (مسودة)».
- No Sparkles. Reuse the shield icon. Brand line in the report header: «نتريو · مسار الإصلاح المُتحقَّق».

### 6.7 Skill registration and the raw-upstream guard

**Playbooks** land in `skills/remediate*/SKILL.md` and are discovered by the existing loader (`src/tools/skills.ts:109`). Because Security mode gains `skill_list`/`skill_view` (§6.2), the system prompt lists them (`src/agent/prompt.ts:144-146`).

**Umbrella playbook** (`skills/remediate/SKILL.md`) — full text:

```markdown
---
name: remediate
description: "Use when the user asks to fix, patch or upgrade a known runtime vulnerability (Node, PHP, self-managed GitLab, Electron-bundled Node) across repos. Calls remediation_start and waits for the user's approval gates. Never edits before approval."
triggers: fix vulnerability, patch CVE, upgrade Node, PHP2Shell, GitLab CVE, remediate
---

# Verified vulnerability remediation

## When to Use
The user wants a known, published runtime CVE fixed in their repos (Dockerfiles, version files, CI, IaC, config management, serverless, Electron). Not for hunting unknown bugs (use the security audit) and not for one-token source repairs (use the existing repair UI).

## Procedure
1. Call `skill_list`. If `remediate-node-runtime` / `remediate-php-runtime` / `remediate-gitlab-selfmanaged` / `remediate-electron-bundled-runtime` match the ask, `skill_view` the matching one for ecosystem detail.
2. Call `remediation_start` with the matching `advisory_ids` and the repos the user named (default: this workspace only). Do **not** pass repos the user did not name.
3. Tell the user the run id and that GATE 1 is waiting in the Security panel («الإصلاح المُتحقَّق»). Do not invent inventory rows yourself.
4. On request, call `remediation_status` / `remediation_report` and summarise. Never claim a fix is deployed.
5. If the user asks to skip a gate or to "just bump it", refuse and point at the panel.

## Forbidden
- Do not edit files, create branches, commit, push, or open PRs with `shell_run` / `git_*` / `pr_create` for remediation. The engine owns those steps behind the gates.
- Do not guess a version.
- Do not present a mitigation as a fix.
- Do not run commands against production.
```

**Ecosystem playbooks** carry the Advice / Forbidden / per-channel rules from §2.5–2.8, rewritten fresh in short Arabic-friendly English, with this footer on every file:

```
Attribution: procedure derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.),
commit 39a04007a1cb19aafd3c487d615c524479963ebf. Rewritten for Loam; no upstream prose copied.
```

**Raw-upstream guard.** If `discoverRepoSkills` finds a skill whose `name` is `fix-node-vuln` / `fix-php-vuln` / `fix-gitlab-vuln` (the upstream names), Remediate:
1. Surfaces a warning in `remediation_status`: "upstream Cognition skill detected at `<path>`; Loam uses the engine + playbooks instead. The upstream skill's Forbidden Actions still apply if you invoke it by hand."
2. Does **not** auto-invoke it.
3. Optionally (OD-11) offers "Archive upstream copy into `.loam/skills-archive/`".

This is required because Loam already reads `.agents/skills` (`src/tools/skills.ts:23`), so `npx skills add CognitionAI/devin-vuln-fixes` would otherwise inject the raw skills into every session.

### 6.8 `repairs.ts` — no change to behaviour; shared helper extraction (optional)

If an implementer wants to share the durable-write and journal helpers, extract `durableWrite` / pending-journal into `src/security/durable.ts` and have both `repairs.ts` and Remediate import them. Behaviour of `prepareRepair` / `changeRepair` / `listRepairs` is unchanged. This extraction is optional and must keep `npm run check:security-repairs` green.

### 6.9 Parent Security System — additive only

No parent file is modified. Remediate imports the parent's public types when the parent lands (`FindingRecord`, `EvidenceAssurance`); until then it defines a minimal local `AuditSeed` interface and reads the parent's `findings.json` / `run-metadata.json` by path. The parent's roadmap Phase E ("Orchestrator + reports", parent §11) is the natural moment to wire the seed; Remediate Phase A (§8) can ship before that using assessment + runtime-inventory seeds alone.

---

## 7. Data model and types (full TypeScript)

File: `src/security/remediate/types.ts`. All types below are the complete contract; implementers do not invent parallel shapes.

```ts
import type { EvidenceAssurance } from "../audit/types.js"; // when parent lands; until then redefine locally

export type RemediationRunState =
  | "inventory"
  | "awaiting_scope_approval"
  | "scope_approved"
  | "working"
  | "awaiting_commit_approval"   // at least one repo waiting
  | "awaiting_pr_approval"
  | "complete"
  | "incomplete"
  | "cancelled";

export type IncompleteReason =
  | "scope_denied"
  | "no_vulnerable_rows"
  | "budget_exhausted"
  | "cancelled"
  | "docker_unavailable_and_unverified_refused";

export type VulnStatus =
  | "fixed"
  | "vulnerable"
  | "eol"
  | "unknown"
  | "vendor_update_required";

export type PinStyle = "exact" | "floating" | "digest" | "package" | "managed" | "iac" | "constraint" | "bundled";
export type Channel =
  | "dockerfile" | "version_file" | "ci_setup" | "ci_image"
  | "distro_package" | "source_build" | "helm" | "terraform"
  | "ansible" | "chef" | "puppet" | "serverless" | "lockfile"
  | "electron" | "omnibus" | "operator" | "ami";
export type UpgradeClass = "patch" | "minor" | "major" | "base_os" | "vendor" | "none";
export type RiskLabel = "low" | "high";
export type TestCoverage = "none" | "thin" | "suite";
export type Confidence = "low" | "medium" | "high";

export type Ecosystem = "nodejs" | "php" | "gitlab-self-managed" | "electron-bundled-nodejs" | "npm" | "PyPI";

export type Origin =
  | { kind: "security_audit"; runId: string; fingerprint: string }
  | { kind: "assessment"; assessmentId: string; name: string; version: string; ids: string[] }
  | { kind: "runtime_inventory" };

export interface InventoryHit {
  repoId: string;
  file: string;                 // repo-relative
  line: number;                 // ≥ 1
  signal: string;               // exact matched text
  channel: Channel;
  currentVersion: string | null;
  pinStyle: PinStyle;
  production: boolean;          // false ⇒ CI-only / build-only
  testCoverage: TestCoverage;
  confidence: Confidence;
  upgradeRiskNotes: string[];   // e.g. "binding.gyp present", "import assertions assert {"
  sapis?: string[];             // PHP
  edition?: "ce" | "ee";        // GitLab
  topology?: "single" | "multi" | "unknown"; // GitLab
}

export interface VulnRecord {
  id: string;                   // stable within the run: sha256(repoId|file|line|signal).slice(0,16)
  ecosystem: Ecosystem;
  advisoryId: string;           // pack id
  cves: string[];
  hit: InventoryHit;
  status: VulnStatus;
  proposedTarget: string | null;
  upgradeClass: UpgradeClass;
  riskLabel: RiskLabel;
  origin: Origin;
  downtimeNote?: string;        // GitLab single-node
  mitigations: Mitigation[];
  nextStep?: string;            // for vendor_update_required / blocked
}

export interface Mitigation {
  id: string;
  summary: string;
  isFix: false;                 // literal false — type system enforces "not a fix"
}

export type TargetEvidenceKind =
  | "registry_manifest" | "vendor_release_index" | "distro_changelog_entry"
  | "tarball_checksum" | "commit_exists" | "chart_version_mapping" | "chart_index_entry"
  | "package_repo_entry" | "osv_fixed_event" | "registry_package_version"
  | "vendor_advisory_entry";

export interface TargetEvidence {
  kind: TargetEvidenceKind;
  at: string;                   // ISO timestamp
  url?: string;
  httpStatus?: number;
  bodySha256?: string;
  digest?: string;              // image digest
  platforms?: string[];         // multi-arch
  value: string;                // the confirmed version / release / chart
  detail: string;               // short human line, no secrets
}

export type VerificationStatus = "verified" | "unverified" | "not_found";

export interface TargetVerification {
  target: { value: string; line: string; packId: string; packSha256: string };
  status: VerificationStatus;
  reason?: string;
  evidence: TargetEvidence[];
}

export interface ProposedEdit {
  file: string;
  line: number;
  before: string;               // exact current line text
  after: string;                // exact new line text
  rationale: string;            // "exact tag bump 22.21.0 → 22.23.4, keep -alpine"
}

export interface FixProposal {
  vulnId: string;
  repoId: string;
  verification: TargetVerification;
  edits: ProposedEdit[];
  upgradeClass: UpgradeClass;
  riskLabel: RiskLabel;
  mitigations: Mitigation[];    // temporary only
}

export type StepStatus = "ok" | "failed" | "not_run";

export interface TestStepResult {
  name: "install" | "build" | "test" | "iac_validate";
  status: StepStatus;
  exitCode: number | null;
  logRel: string;               // run-store relative
  logSha256: string;
  durationMs: number;
  deprecationLines: string[];   // extracted lines matching /deprecat/i
  failureLines: string[];       // extracted failure summaries (≤ 50 lines)
}

export interface TestRun {
  role: "baseline" | "after";
  imageRef: string;             // tag@digest
  digest: string;
  steps: TestStepResult[];
  status: StepStatus;           // failed if any required step failed
}

export interface TestComparison {
  baseline: TestRun;
  after: TestRun;
  newFailures: string[];
  resolvedFailures: string[];
  newDeprecations: string[];
  resolvedDeprecations: string[];
}

export interface RuntimeDiff {
  before: Record<string, string>;  // node process.versions or php -m/-i keys
  after: Record<string, string>;
  changed: string[];
  notes: string[];                 // e.g. "eMudhra CA removed", "ftp extension dropped"
}

export interface SmokeResult {
  status: "ok" | "failed" | "not_run";
  reason: string;
  logRel?: string;
  logSha256?: string;
}

export interface ArtifactVersionProof {
  command: string;              // "node -v" / "php -v" / "php-fpm -v"
  observed: string;             // "v22.23.4"
  matchesFixedRelease: boolean;
  evidenceId: string;
}

export type FixVerdict = "verified_fixed" | "patched_unverified" | "regression" | "blocked";

export interface FixGateResult {
  verdict: FixVerdict;
  reason: string;
}

export interface FixGateInput {
  verification: TargetVerification;
  artifactProof: ArtifactVersionProof | null;
  comparison: TestComparison | null;
  smoke: SmokeResult | null;
  policy: { dockerAvailable: boolean; dockerBlocker?: string };
}

export interface ScopeApproval {
  planHash: string;             // sha256 of canonical inventory+targets shown
  repos: string[];
  rows: string[];               // VulnRecord.id[]
  allowMajorUpgrade: Record<string, boolean>;
  allowMinorUpgrade: Record<string, boolean>;
  allowBaseOsChange: Record<string, boolean>;
  allowAppCodeChange: Record<string, boolean>;
  decidedAt: string;
  decidedBy: "user";
}

export interface CommitApproval {
  repoId: string;
  diffHash: string;
  prBodyHash: string;
  acceptUnverified: boolean;
  decidedAt: string;
  decidedBy: "user";
}

export interface PrApproval {
  repoId: string;
  remote: string;
  base: string;
  draft: boolean;
  decidedAt: string;
  decidedBy: "user";
}

export type RepoPhase =
  | "queued" | "recheck" | "resolve" | "baseline" | "edit"
  | "after" | "fix_gate" | "awaiting_commit" | "committed"
  | "awaiting_pr" | "pr_opened" | "discarded" | "blocked" | "skipped";

export interface RepoPlan {
  repoId: string;
  path: string;                 // run-store clone or worktree
  branch: string;               // loam/remediate/<advisoryId>/<runShort>
  baseBranch: string;
  phase: RepoPhase;
  vulns: string[];              // VulnRecord.id[]
  proposal: FixProposal | null;
  baseline: TestRun | null;
  after: TestRun | null;
  comparison: TestComparison | null;
  runtimeDiff: RuntimeDiff | null;
  smoke: SmokeResult | null;
  artifactProof: ArtifactVersionProof | null;
  fixGate: FixGateResult | null;
  commitApproval: CommitApproval | null;
  prApproval: PrApproval | null;
  commitSha: string | null;
  pr: { number: number; url: string; draft: boolean; provider: string } | null;
  blockedReason: string | null;
  rollbackTarget: { digest?: string; version?: string } | null;
}

export type RemediationEvidenceKind =
  | TargetEvidenceKind
  | "inventory_hit" | "build_log" | "test_log" | "runtime_diff"
  | "smoke_log" | "artifact_version" | "iac_validation" | "deploy_observation";

export interface RemediationEvidence {
  id: string;                   // EV#### from nextEvidenceId()
  sha256: string;               // of canonical JSON of the rest
  kind: RemediationEvidenceKind;
  at: string;
  repoId?: string;
  vulnId?: string;
  assurance: EvidenceAssurance | "network";
  detail: string;
  pathRel?: string;
  url?: string;
  redaction: "ok" | "failed" | "n/a";
}

export type SourceFixState = "unfixed" | "fixed_pending_deploy" | "still_vulnerable" | "closed";

export interface CloseRecord {
  vulnId: string;
  state: SourceFixState;
  rescan: {
    kind: "security_audit" | "assessment_retest" | "runtime_inventory";
    ref: string;                // run id / assessment id / inventory hash
    at: string;
    outcome: "not_observed" | "persistent" | "unverified" | "fixed" | "error";
  };
  deployEvidence?: {
    observedVersion: string;
    observedAt: string;
    note: string;
    evidenceId: string;
  };
}

export interface RemediationRun {
  id: string;                   // uuid
  createdAt: string;
  finishedAt?: string;
  state: RemediationRunState;
  incompleteReason?: IncompleteReason;
  advisoryIds: string[];
  packHashes: Record<string, string>;
  repos: string[];
  inventory: VulnRecord[];
  unsearchable: { repoId: string; reason: string }[];
  scopeApproval: ScopeApproval | null;
  plans: RepoPlan[];
  evidence: RemediationEvidence[];
  closures: CloseRecord[];
  host: { platform: NodeJS.Platform; docker: { available: boolean; blocker?: string } };
  model: string;                // cloud model id; never local
  budget: { limit: number | null; spent: number };
}

export interface RemediationStartInput {
  advisory_ids?: string[];
  repos?: string[];
  from_audit_run?: string;
  from_assessment?: string;
  allow_docker?: boolean;
  budget?: number | null;
}

export interface RemediateLimits {
  maxRepos: 50;
  maxRows: 5_000;
  maxEditsPerRepo: 200;
  maxLogBytesPerStep: 5_242_880;          // 5 MiB
  maxNetworkBytesPerResponse: 2_000_000;
  maxNetworkBytesPerRun: 20_000_000;
  inventoryAgentTimeoutMs: 180_000;
  buildTimeoutMs: 600_000;
  testTimeoutMs: 600_000;
  smokeTimeoutMs: 60_000;
  resolverTimeoutMs: 30_000;
  maxConcurrentInventoryAgents: 4;       // == DEFAULT_MAX_CONCURRENT_CHILDREN
}

export const REMEDIATE_LIMITS: RemediateLimits = {
  maxRepos: 50, maxRows: 5_000, maxEditsPerRepo: 200,
  maxLogBytesPerStep: 5_242_880,
  maxNetworkBytesPerResponse: 2_000_000, maxNetworkBytesPerRun: 20_000_000,
  inventoryAgentTimeoutMs: 180_000, buildTimeoutMs: 600_000,
  testTimeoutMs: 600_000, smokeTimeoutMs: 60_000, resolverTimeoutMs: 30_000,
  maxConcurrentInventoryAgents: 4,
};
```

### 7.1 Canonical hashes

```ts
import { createHash } from "node:crypto";

/** Stable SHA-256 of a JSON-canonicalised value (sorted keys, no whitespace). */
export function canonicalSha256(value: unknown): string {
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
    const obj = v as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(",")}}`;
  };
  return createHash("sha256").update(canon(value)).digest("hex");
}

export function planHash(inventory: VulnRecord[], targets: Record<string, string | null>): string {
  return canonicalSha256({
    rows: inventory.map((r) => ({
      id: r.id, repoId: r.hit.repoId, file: r.hit.file, line: r.hit.line,
      signal: r.hit.signal, current: r.hit.currentVersion, status: r.status,
      target: targets[r.id] ?? r.proposedTarget, upgradeClass: r.upgradeClass,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}
```

### 7.2 Run store layout

```
<DATA_DIR>/security-remediations/<runId>/
  run.json                         RemediationRun (parent-only writer)
  inventory.json                   VulnRecord[]
  packs/                           copies of the packs used (pinned by hash)
  repos/<repoId>/                  shallow clones (remote) 
  worktrees/<repoId>/              git worktrees (local workspace repos)
  plans/<repoId>/
    proposal.json
    baseline/                      logs + image digest
    after/
    diff.patch                     unified diff (GATE 2 input)
    PR_BODY.md                     deterministic
    commit.json                    { sha, approvedAt, diffHash }
    pr.json                        { number, url, draft, provider }
  evidence/<EV####>.json
  REMEDIATION.md
  rollup.json
  state.sqlite                     stage index (optional; JSON is truth)
```

Parent is the only writer of `run.json`, `REMEDIATION.md`, `rollup.json`. Agents write only under a per-agent scratch path that the parent promotes with the parent's `promote.ts` rules when the parent lands; until then Remediate uses a local `promoteWin32` copy of the same algorithm (parent §10.4), labelled `reduced-win32` on win32.

### 7.3 State machine

```
[*] → INVENTORY
INVENTORY → AWAIT_SCOPE: inventory done (0 rows → COMPLETE with no_vulnerable_rows)
AWAIT_SCOPE → SCOPE_APPROVED: GATE 1 approved and planHash matches
AWAIT_SCOPE → COMPLETE(incomplete:scope_denied): user cancels / denies
SCOPE_APPROVED → WORKING: per approved repo, sequentially or ≤ 4 inventory-rechecks then resolve/baseline/edit/after/fix_gate
WORKING → AWAIT_COMMIT: fix gate finished for a repo
AWAIT_COMMIT → COMMITTED: GATE 2 approved and diffHash matches; git commit on the Remediate branch
AWAIT_COMMIT → DISCARDED: user discards
COMMITTED → AWAIT_PR
AWAIT_PR → PR_OPENED: GATE 3 approved; push (via existing approvePush) + createPr(draft)
PR_OPENED → RESCAN → CLOSE_WAIT
CLOSE_WAIT → COMPLETE: all approved repos are pr_opened|discarded|blocked and every closure is fixed_pending_deploy|closed|still_vulnerable
any → CANCELLED: remediation_cancel
```

Rules: write `run.json` before every transition; never leave `working` with a dirty user tree; never commit without GATE 2; never push without GATE 3 + `approvePush`.

### 7.4 Deterministic PR body template

`pr/body.ts` fills this template; no model prose:

```
# Remediate: {{advisoryTitle}}

> نتريو · مسار الإصلاح المُتحقَّق · run {{runId}}
> This PR was opened as a **draft**. Nothing has been deployed.

## Summary
| Path | Before | After | Pin | Production | Risk |
|---|---|---|---|---|---|
{{#rows}}| `{{file}}:{{line}}` | {{before}} | {{after}} | {{pinStyle}} | {{production}} | {{riskLabel}} |
{{/rows}}

## Verification
- Target evidence: {{verificationStatus}} ({{verificationDetail}})
- After-artifact: `{{artifactCommand}}` → `{{artifactObserved}}`
- Baseline tests: {{baselineStatus}} (log sha {{baselineLogSha}})
- After tests: {{afterStatus}} (log sha {{afterLogSha}})
- New failures: {{newFailuresCount}} · New deprecations: {{newDeprecationsCount}}
- Runtime diff: {{runtimeChanged}}
- Smoke: {{smokeStatus}}
- Fix gate: **{{fixVerdict}}**{{#fixReason}} — {{fixReason}}{{/fixReason}}

## Rollout
1. Merge this draft after review.
2. Deploy to staging/canary first.
3. Confirm the running version/digest matches **{{after}}**.
4. Then production.

## Rollback
Previous artifact: `{{rollbackTarget}}` (still vulnerable — roll back only briefly).
{{#mitigations}}
### Temporary mitigations (not a fix)
- {{summary}}
{{/mitigations}}

## Closure
Source state after re-scan: `fixed_pending_deploy`. Mark **closed** in Loam only after you paste deploy evidence that matches {{after}}.

## Attribution
Procedure derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.), commit 39a04007a1cb19aafd3c487d615c524479963ebf. Advisory facts from {{sourceUrls}}.
```

---

## 8. Phased build plan with acceptance criteria

> **ROADMAP ONLY — NO TASKS, NO PROMPTS, awaiting Khamis coding approval.** Nothing here is a queue entry, size, owner, or schedule. Phases express architectural dependency. Each begins only after Khamis approves coding for it.

### 8.0 Fixture set (used by every phase's acceptance tests)

Create under `src/security/remediate/__fixtures__/` (test-only; never shipped):

| Fixture | Contents | Expected inventory |
|---|---|---|
| `node-vuln-app/` | `Dockerfile` `FROM node:22.21.0-alpine` (line 1); `.nvmrc` = `22.21.0`; `.github/workflows/ci.yml` with `actions/setup-node@v4` / `node-version: 22`; `package.json` with a trivial `test` script that exits 0; no app-code breakers | 3 vulnerable rows (dockerfile exact, version_file exact, ci_setup floating); status `vulnerable`; proposed target `22.23.4` |
| `node-eol-app/` | `.nvmrc` = `20.19.0` | 1 row, status `eol`, upgradePath includes `22.23.4`; major upgrade blocked until `allowMajorUpgrade` |
| `node-regression-app/` | Same as `node-vuln-app` but `test` script exits 1 on Node ≥ 22.23 (simulates a regression) | After-tests → `regression`; bump uncommitted |
| `php-vuln-app/` | `Dockerfile` `FROM php:8.3.12-fpm-bookworm`; `composer.json` with a `test` script | 1 vulnerable row; target `8.3.36`; SAPI `fpm` |
| `gitlab-omnibus-iac/` | `ansible/gitlab.yml` with `gitlab-ee=19.4.0-ee.0` | 1 vulnerable row; target `19.4.3-ee.0`; downtime note for single-node |
| `electron-app/` | `package.json` `"electron": "44.7.2"` + a lockfile entry resolving 44.7.2 | 1 row, status `vendor_update_required`, target `null`, nextStep names the watch-Electron action |
| `clean-node-app/` | `Dockerfile` `FROM node:22.23.4-alpine` | 1 row, status `fixed`; no GATE 1 work |

All fixtures are git repos initialised in the test harness with one commit on `main`. Tests assert `git status --porcelain` is empty in the **user's** tree after every phase (work happens in worktrees/clones under the run store).

### Phase A — Types, packs, store, inventory detectors (no Docker, no agents)

**Deliverables:** `types.ts`, `errors.ts`, `store.ts`, `packs/*`, the four pack JSON files + `index.json`, `inventory/{node,php,gitlab,electron,packages,classify,index}.ts`, unit tests.

**Acceptance:**
1. `npm run test:remediate-packs` — every pack parses; every `fixed` has a `sourceUrls` entry; `canonicalSha256` of each pack matches `index.json` after a fresh hash.
2. `npm run test:remediate-inventory` — on each fixture, the inventory table equals the expected table in §8.0 (file, line, signal, current, pin, status, proposedTarget). Zero writes (`git status --porcelain` empty).
3. `electron-app` classifies `vendor_update_required` with `proposedTarget: null`.
4. `clean-node-app` classifies `fixed`.
5. A tampered pack (hash mismatch with `index.json`) is refused at load with `RemediationError(code:"pack_hash_mismatch")`.

**Verification commands:**
```
npm run typecheck
npm run test:remediate-packs
npm run test:remediate-inventory
```

### Phase B — TargetResolver (network read-only)

**Deliverables:** `resolve/*`, resolver unit tests with injected fetch/docker stubs, one live-optional test.

**Acceptance:**
1. Stubbed registry returns a manifest for `node:22.23.4-alpine` → `verification.status === "verified"` with `digest` set.
2. Stubbed 404 → `not_found`.
3. Stubbed network error → `unverified` with the error in `reason`.
4. OSV fixed-event stub for a known GHSA → smallest fixed version selected; `npm view` stub confirms existence.
5. Electron resolver with the observed table (§6.4.4) → no verified Electron release; status stays `vendor_update_required`.
6. Optional live test (`REMEDIATE_LIVE=1`): resolve `node:22.23.4` against `docker.io` and assert a digest is returned. Skipped offline.

**Verification:**
```
npm run test:remediate-resolve
REMEDIATE_LIVE=1 npm run test:remediate-resolve:live   # optional
```

### Phase C — Gates + edit engine + worktrees (no Docker)

**Deliverables:** `gate/*`, `edit/*`, HTTP approve/discard endpoints, UI GATE 1/2 forms (without test panels).

**Acceptance:**
1. Starting a run on `node-vuln-app` ends in `awaiting_scope_approval`; no branch exists.
2. Approving with a wrong `planHash` → HTTP 409.
3. Approving the correct hash → `scope_approved`; worktree created under the run store; user's tree untouched.
4. `applyEdits` rewrites the Dockerfile line `FROM node:22.21.0-alpine` → `FROM node:22.23.4-alpine` and `.nvmrc` `22.21.0` → `22.23.4`; if the line was changed underneath, edit is refused.
5. GATE 2 with matching `diffHash` creates one commit on `loam/remediate/node-2026-10-21/<short>` and refuses a second commit with a stale hash.
6. Discard removes the worktree and the branch from the run-store clone only.

**Verification:**
```
npm run test:remediate-gates
npm run check:remediate-http        # local server, Arabic UI labels present
```

### Phase D — Build/test runner + fix gate `[U2]`

**Deliverables:** `build/*`, `gate/fixGate.ts`, UI test panels.

**Acceptance (Docker available):**
1. On `node-vuln-app`, baseline digest recorded; after image reports `v22.23.4`; `compareTestRuns` shows zero new failures/deprecations; smoke ok; `evaluateFixGate` → `verified_fixed`.
2. On `node-regression-app`, `evaluateFixGate` → `regression`; working tree has the bump uncommitted; GATE 2 offers only discard/keep.
3. On `php-vuln-app`, after image `php -v` reports `8.3.36`; runtime diff records extension/ini changes; gate → `verified_fixed`.

**Acceptance (Docker unavailable — Khamis's current U2 state):**
4. `dockerProbe` returns `{available:false, blocker:"…"}`; fix gate → `patched_unverified` with that blocker; GATE 2 requires the `acceptUnverified` checkbox; PR title prefix `[unverified]`.

**Verification:**
```
npm run test:remediate-fixgate
# with Docker:
REMEDIATE_DOCKER=1 npm run test:remediate-build
# without:
npm run test:remediate-build:nodocker
```

### Phase E — PR planner + provider draft flag + roll-up

**Deliverables:** `pr/*`, `CreatePrInput.draft` (§6.3), `report/*`, GATE 3.

**Acceptance:**
1. With the local PR provider, GATE 3 creates exactly one PR per approved repo under `.loam/prs`, `draft:true` by default (OD-5).
2. PR body matches the template in §7.4 for the fixture (snapshot test).
3. Roll-up table lists every approved repo with verdict / PR URL / blocked reason.
4. Push goes through `approvePush` + `createApproval`/`waitForDecision` (existing path); denying the live approval leaves the commit local and the PR unopened.
5. `allowedOwners` default `["khamis1992"]`: a foreign `owner/repo` is refused at GATE 3.

**Verification:**
```
npm run test:remediate-pr
npm run check:remediate-pr-local
```

### Phase F — Re-scan + closure (Phase 8)

**Deliverables:** `rescan/*`, close endpoint, UI «إغلاق بعد النشر».

**Acceptance:**
1. After a `verified_fixed` Node PR is opened, Phase 8a re-inventory on the fix branch classifies the row `fixed`; closure state `fixed_pending_deploy`.
2. Pasting deploy evidence whose version equals the target → `closed`.
3. Pasting a mismatched version → refused with 409.
4. When seeded from an assessment, Phase 8a calls `retestAssessment` with `queryAdvisories:true` and maps `comparison.notObserved` → `fixed_pending_deploy`, `persistent` → `still_vulnerable`, `unverified` → keep open with reason.
5. When seeded from a security-audit run (parent present), Phase 8a starts `profile:"quick"` scoped to changed files; prior `confirmed` with changed source becomes re-checked (parent §6.3), not carried.

**Verification:**
```
npm run test:remediate-rescan
```

### Phase G — Playbooks, mode card, dogfood, end-to-end

**Deliverables:** five `skills/remediate*/SKILL.md`, mode-card update (§6.2), raw-upstream guard (§6.7), dogfood test, `THIRD_PARTY_NOTICES` entry, `electron-builder.yml` pack include.

**Acceptance (= Definition of Done §0.3):**
1. D-1 … D-8 all green on the fixture set.
2. Dogfood against `/workspace/re/loam-dvf` (or the installed app's sources) reports the Electron finding as `vendor_update_required` and proposes no bump.
3. `skill_list` in Security mode shows the four ecosystem playbooks + umbrella; `skill_view remediate` returns the umbrella text.
4. Dropping a raw `fix-node-vuln` into `.agents/skills/` surfaces the guard warning and is not auto-invoked.
5. `THIRD_PARTY_NOTICES` contains the Cognition AI MIT notice (§10.4).
6. Packaged build includes `security/advisories/**` (asar list check).

**Verification:**
```
npm run typecheck
npm run test:remediate
npm run check:remediate
npm run check:security-repairs          # must stay green
npm run verify                          # existing suite
```

### 8.1 Real-CVE test cases (mapping)

| CVE class | Fixture | Pack | Expected end state |
|---|---|---|---|
| Node Brotli CVE-2026-111497 (patch) | `node-vuln-app` | `node-2026-10-21` | `verified_fixed` (or `patched_unverified` without Docker), one draft PR |
| Node EOL major | `node-eol-app` | `node-2026-10-21` | blocked until `allowMajorUpgrade`; then high-risk PR |
| Node regression | `node-regression-app` | `node-2026-10-21` | `regression`, uncommitted |
| PHP2Shell CVE-2026-109618/-109619 | `php-vuln-app` | `php-2026-10-21` | `verified_fixed` / `patched_unverified` |
| GitLab CVE-2026-110264 | `gitlab-omnibus-iac` | `gitlab-2026-10-21` | PR with downtime note + post-deploy checklist; no production commands |
| Electron bundled Node | `electron-app` + Loam itself | `electron-bundled-node` | `vendor_update_required`, no PR |

### 8.2 Scripts to add to `package.json`

```json
"test:remediate": "node --import tsx --test src/security/remediate/__tests__/*.test.ts",
"test:remediate-packs": "node --import tsx --test src/security/remediate/__tests__/packs.test.ts",
"test:remediate-inventory": "node --import tsx --test src/security/remediate/__tests__/inventory.test.ts",
"test:remediate-resolve": "node --import tsx --test src/security/remediate/__tests__/resolve.test.ts",
"test:remediate-gates": "node --import tsx --test src/security/remediate/__tests__/gates.test.ts",
"test:remediate-fixgate": "node --import tsx --test src/security/remediate/__tests__/fixGate.test.ts",
"test:remediate-build": "node --import tsx --test src/security/remediate/__tests__/build.test.ts",
"test:remediate-pr": "node --import tsx --test src/security/remediate/__tests__/pr.test.ts",
"test:remediate-rescan": "node --import tsx --test src/security/remediate/__tests__/rescan.test.ts",
"check:remediate": "node --import tsx src/scripts/check-remediate.ts",
"check:remediate-http": "node --import tsx src/scripts/check-remediate-http.ts",
"check:remediate-pr-local": "node --import tsx src/scripts/check-remediate-pr-local.ts"
```

---

## 9. Open decisions for Khamis (OD-1 … OD-12)

Each decision has a recommended default. Coding may proceed on the defaults; changing a default later is a pack/config edit, not a redesign.

| ID | Question | Options | Recommended default | Why |
|---|---|---|---|---|
| **OD-1** | Approach | (a) skills as-is · (b) native only · (c) hybrid | **(c) Hybrid** | §4: code-enforced gates + data packs + playbooks |
| **OD-2** | Playbook prose | Rewrite fresh (D2) · Ship upstream SKILL.md verbatim with MIT notice | **Rewrite fresh** | Consistency with parent D2; Arabic-friendly; engine owns guarantees. Verbatim is lawful if preferred. |
| **OD-3** | First advisory packs enabled | Node only · Node+PHP · Node+PHP+GitLab · all four (incl. Electron tracker) | **Node + Electron tracker** | Loam itself is a Node/Electron app; PHP/GitLab packs ship disabled (`enabled:false` in `index.json`) until Khamis turns them on |
| **OD-4** | Approval granularity | Per-row (GATE 1) + per-repo (GATE 2/3) · Per-repo only · Per-run (one yes for everything) | **Per-row GATE 1, per-repo GATE 2/3** | Matches upstream "which repos" and adds row precision for mixed inventories |
| **OD-5** | PR default | Draft · Ready for review | **Draft** | Nothing merges by accident; matches "fixes take effect only after deploying" |
| **OD-6** | Auto-PR vs plan-only | Open PR after GATE 3 · Stop at PR_BODY.md + branch (user opens PR by hand) | **Open draft PR after GATE 3** | Reuses `PrProvider`; GATE 3 is the control. Plan-only remains one checkbox away (`approve-pr` with `createPr:false` — Design decision if OD-6 flips) |
| **OD-7** | Docker for before/after | Required (fail closed) · Optional (`patched_unverified` without it) · Off | **Optional** (honours parent U2) | Khamis's PC currently has no Docker server (parent U2); fail-closed would block every run |
| **OD-8** | Build-network profile | Allow network during `docker build`/`npm ci` · Require a pre-loaded local registry mirror | **Allow network during build; isolate during test** | §5.6; mirror can be added later |
| **OD-9** | Allowed PR owners | `["khamis1992"]` · Any owner the GitHub connector can write · Prompt each time | **`["khamis1992"]`** | Standing rule: no third-party messaging |
| **OD-10** | Closure policy | Source-fixed = closed · Source-fixed = `fixed_pending_deploy` until deploy evidence | **`fixed_pending_deploy` until deploy evidence** | Upstream honesty (`fix-node-vuln/SKILL.md:55`) |
| **OD-11** | Raw upstream skill found in `.agents/skills` | Warn only · Warn + offer archive · Auto-archive | **Warn only** | Least surprise; user may have installed it for another agent |
| **OD-12** | Major-upgrade default on GATE 1 | Unticked (must opt in) · Ticked when only majors remain | **Unticked** | Upstream Forbidden: no major without explicit approval |

---

## 10. Evidence log, UNKNOWNs, licence posture

### 10.1 Evidence log (OBSERVED → path / URL / command)

**Upstream (clone `/workspace/re/devin-vuln-fixes-src`, HEAD `39a04007a1cb19aafd3c487d615c524479963ebf`):**

| Fact | Where |
|---|---|
| Three skills, five-step shape, agent-neutral, no `allowed-tools` | `README.md:3-17,87-93` |
| Install via `npx skills`, Node ≥ 22.20, `skills-lock.json` | `README.md:21-39,97` |
| Fixed versions + CVE ids | `README.md:7-9`; each skill Overview; `CHANGELOG.md:5` |
| MIT © 2026 Cognition AI, Inc. | `LICENSE:1-3`; skill frontmatter `license: MIT` |
| Approval gate + no-guess + before/after + one PR | `README.md:89-91`; each skill Specifications + Forbidden |
| Node procedure, channels, tests, PR, Forbidden | `skills/fix-node-vuln/SKILL.md` (73 lines; SHA-256 `0d1c3558eee01a55b4c58ccde92add9bd962e9d0fbd90f002d767a6024aae356`) |
| PHP procedure, backports, mitigations, Forbidden | `skills/fix-php-vuln/SKILL.md` (82 lines; SHA-256 `14e4b19e5d059b8ec07925efd5256902e3d937716c1c0020c42a80162fc4f46a`) |
| GitLab procedure, chart mapping, post-deploy, Forbidden | `skills/fix-gitlab-vuln/SKILL.md` (69 lines; SHA-256 `0cda7b1e0dea9fa61eff5da6e75e9986ce3de1eb239178c88dfe69a7ec614fd0`) |
| Contributing rules (portable wording, keep the three gates) | `CONTRIBUTING.md:12-17` |
| Plugin manifests | `.claude-plugin/*`, `.codex-plugin/plugin.json`, `.devin-plugin/plugin.json`, `.factory-plugin/*`, `.agents/plugins/marketplace.json` |
| Empty `logo.svg`, two-commit history | `logo.svg` (0 bytes); `git log --oneline` |

**Vendor corroboration (fetched 2026-10-25):** Node security release + v22.23.4 + v24.22.1 pages; PHP.net advisory + PHP Foundation post + CERT VU#763488 + php.announce 8.4.27 (tarball SHA-256); GitLab critical patch page + NVD CVE-2026-110264; Electron releases (44.7.2 → Node 24.21.0; 44.9.3 → 24.22.0) and schedule (24.22.1 from 46.0.0).

**Loam (clone `/workspace/re/loam-dvf`, `main` @ `5227df4300338547d8f5f942d38b67c6d77622a1`, v0.5.31):**

| Anchor | Proves |
|---|---|
| `src/modes/catalog.ts:66-69` | Security mode tools/panels/starters — where `remediation_*` and `skill_view` plug in |
| `src/security/repairs.ts:4,7,9,15-18,27-28,36,60-61` | RepairDraft; one AST class; durable write; "not a verified fix"; `reviewed:true`; assessment lock |
| `src/security/orchestrator.ts:33,61-81,191-209,223-248` | `assertLocalhost`; `Evidence`; `nextEvidenceId` → `EV####`; `isValidEvidence` / `demonstratesClaim` / `evaluateEvidenceGate` |
| `src/security/dependencies.ts:6,38,57-73` | DependencyInventory + OSV querybatch caps |
| `src/security/assessments.ts:27-45,46,95,105` | Assessment shape; `assessmentActive`; report; retest |
| `src/security/findings.ts:4-18,20` | SecurityFinding, RetestComparison, sarif |
| `src/tools/skills.ts:23,75-94,109,132,186,344,477` | `.agents/skills` root; frontmatter parser; list/discover; tools; `skill_install` |
| `src/agent/prompt.ts:144-146` | Skills listed only when `skill_view` is in the mode |
| `src/tools/mcp.ts:99,106-114` | `mcp__<server>__<tool>` registration (pattern reference; Remediate is not MCP) |
| `src/tools/gitWorkflowTools.ts:5-9,18,31,87-89,213-246` | No force-push; `approvePush` + approvals; protected branches; `pr_create` |
| `src/tools/gitPrProvider.ts:40-50,106-120,199-206` | `CreatePrInput` (no draft today); `PrProvider`; GitHub POST `/pulls` |
| `src/server/approvals.ts:12-24,26-34,36,58,82` | ApprovalRecord; BoundedMap 256 / 15 min TTL (why Remediate persists its own gates) |
| `src/server/pending.ts:7,18` | `PendingKind` / `WriteGate` — pack-bump staging |
| `src/server/http.ts:772,796-799,802,808-812` | `/api/security/assessments` block; repairs; same-origin; retest |
| `src/policy/riskTier.ts:291,433,641` | `UNTRUSTED_TOOL_NAMES`; `classifyToolCall`; `markUntrusted` |
| `src/subagent/registry.ts:5,46` | `DEFAULT_MAX_CONCURRENT_CHILDREN = 4`; `acquireChild` |
| `src/tools/subagents.ts:188` | `buildSubagentToolRegistry` |
| `src/agent/backendSandbox.ts:124,134` | Hardened Docker flags (audit profile; Remediate test profile reuses them) |
| `src/setup/runtime.ts:22,36,46,99,143` | Registration points for pentest / skills / git / remediate tools |
| `ui/security.js:88-91` | Reviewed-repair checkbox pattern to reuse for GATE 2/3 |
| `electron-builder.yml:16` | `skills/**/*` already packaged; packs need a parallel entry |
| `THIRD_PARTY_NOTICES` | Existing notice file to append Cognition AI |
| `package.json:5-6,127` + lockfile | `engines.node >=22.13.0`; `electron ^44.7.2` → resolved `44.7.2` |

**Parent design:** `/workspace/re/loam-security-system/BUILD_SPEC.md` §6.2 (known-bad-version fast path), §6.3 (prior-run carry), §6.9 (reports), §7.1 (types), §9.1 (state machine ending at REPORT), §10.3–10.4 (sandbox + D5), §11 (roadmap), §13.3 D2/D5/D6/D11.

**House style:** `/workspace/re/rea/REA_INTO_LOAM_INTEGRATION.md` §0–§4 (proposal banner, claim tags, enterprise/safety shape).

### 10.2 UNKNOWNs (each with a Design decision)

| ID | Unknown | Design decision (so the build is not blocked) | How to resolve later |
|---|---|---|---|
| **U-1** | Does Khamis's PC have a working Docker Engine today? Parent U2 recorded `docker version` printing no server. | Remediate treats Docker as optional (OD-7). Without it every fix gate returns `patched_unverified` with the blocker; GATE 2 requires an explicit accept. | Khamis answers parent U2 / OD-7 |
| **U-2** | Exact GitHub connector scopes available for `pulls` create with `draft:true` | GATE 3 uses `PrProvider`; if the connector rejects `draft`, fall back to ready PR and label the title `[draft-fallback]`. Local provider always supports draft. | One live call in Phase E on a throwaway repo |
| **U-3** | Machine-readable shape of `https://releases.electronjs.org/releases.json` (field names for version ↔ Node) | Electron detector scrapes the already-fetched HTML table shape as a fallback and prefers the JSON if it parses with `{ version, node }`. Recorded as `TargetEvidence.detail`. | One live fetch in Phase B live test |
| **U-4** | Whether Loam's GitHub provider normalises draft PRs into `PrInfo` | Extend `PrInfo` with `draft?: boolean` in the same change as §6.3; local provider sets it; GitHub provider reads `data.draft`. | Phase E |
| **U-5** | Preferred Arabic wording for GATE checkboxes beyond the drafts in §6.6 | Ship the drafts in §6.6; Khamis can edit UI strings without engine changes. | UI review |
| **U-6** | Whether `manus-parity` (not only `main`) is the branch this will land on | Spec is branch-agnostic; wiring cites paths, not branches. Protected-branch list already includes both (`gitWorkflowTools.ts:31`). | Khamis's coding approval names the branch |
| **U-7** | Will the parent Security System land before Remediate? | Remediate ships with assessment + runtime-inventory seeds first (Phase A–E); security-audit seeding is Phase F behind a feature flag `remediate.seedFromAudit`. | Parent roadmap |

### 10.3 Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Model invents inventory rows | Engine re-reads `file:line` and drops hits whose signal is absent (§6.5) |
| R2 | Stale advisory pack | Hash pin + staged review (§6.4.5); CI pack test |
| R3 | Registry poison / wrong digest | After-image `node -v`/`php -v` must match; digest recorded |
| R4 | Secrets in logs/PRs | §5.7 redaction; summaries by default |
| R5 | User tree disturbed | Worktrees/clones only; never `reset`/`stash`/`checkout` in the user tree (§5.8) |
| R6 | Draft PR merged without deploy | Closure stays `fixed_pending_deploy` until deploy evidence (OD-10) |
| R7 | Dockerless Windows → everything `patched_unverified` | Honest label; CI must prove; OD-7 |
| R8 | Raw upstream skills installed via `npx skills` | Guard (§6.7); OD-11 |
| R9 | Cost of cloud calls for inventory agents | Cap 4 concurrent; budget field; inventory is read-only and short |

### 10.4 Licence posture (MIT)

Upstream licence (OBSERVED `LICENSE`):

```
MIT License

Copyright (c) 2026 Cognition AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**What Loam may do under MIT:** copy, modify, redistribute, sell; private or public; including verbatim skill text (OD-2) or a clean rewrite.

**What Loam must do:** keep the copyright and permission notice in all copies or substantial portions. Concrete actions:

1. Append to `THIRD_PARTY_NOTICES`:

```
CognitionAI/devin-vuln-fixes (MIT)
----------------------------------
Vulnerability-fix skill procedures (Node, PHP, self-managed GitLab) and the
five-step remediation shape (inventory → approval gate → verified target →
before/after tests → one PR per repo) inform Loam's Remediate engine and
playbooks.

  https://github.com/CognitionAI/devin-vuln-fixes
  commit 39a04007a1cb19aafd3c487d615c524479963ebf

Copyright (c) 2026 Cognition AI, Inc.

MIT License — see full text above (jcode notice style). The full MIT text from
the upstream LICENSE file is reproduced in this section.
```

2. Every Loam-authored playbook carries the attribution footer in §6.7.
3. Every PR body carries the attribution line in §7.4.
4. Advisory-pack `sourceUrls` point at vendor pages (facts are not copyrighted); the *selection and structure* of the packs is Loam's, informed by the upstream skills.

**What Loam must not do:** remove the notice; claim Cognition AI endorses Loam; copy plugin manifests into Loam as if Loam were a Claude/Codex/Devin/Factory plugin host.

### 10.5 Decisions made in this spec (not open)

| ID | Decision |
|---|---|
| D-R1 | Hybrid approach (c) |
| D-R2 | New service `src/security/remediate/`, not an extension of `repairs.ts` |
| D-R3 | Three persisted, hash-bound gates; no model tool can decide them |
| D-R4 | Advisory packs as reviewed data; version facts leave prose |
| D-R5 | `evaluateFixGate` mirrors `evaluateEvidenceGate`'s ordered-rules shape |
| D-R6 | Worktrees/clones only; never touch the user's dirty tree |
| D-R7 | Draft PRs by default; allowed owners default `["khamis1992"]` |
| D-R8 | Closure = `fixed_pending_deploy` until deploy evidence |
| D-R9 | Electron dogfood is `vendor_update_required`, not a guessed bump |
| D-R10 | Subagent concurrency ≤ 4 (Loam semaphore), not the upstream 5 |
| D-R11 | Clean rewrite of playbook prose (OD-2 default), MIT notice retained |
| D-R12 | Writing/study only until a separate coding approval |

---

*Attribution: design derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.), commit 39a04007a1cb19aafd3c487d615c524479963ebf, and linked into `/workspace/re/loam-security-system/BUILD_SPEC.md` as Phases 7–8 (Remediate + Re-scan). Contains no upstream source code and no upstream prose in the engine; advisory facts are reproduced from vendor-corroborated skill tables; playbooks are rewritten fresh. Proposal only; not queued; separate coding approval required.*

---

## 12. Repo deltas — anchoring to `manus-local` (2026-10-25, Khamis-approved plan)

> Follows the REA (§16/A), Cua (§12/B) and sandbox-runtime (§12/C) precedents.
> Anchors below were verified DIRECTLY on this working tree (it has drifted far
> from the public clone `5227df4` this spec cites). Where this appendix and the
> body disagree on repo mechanics, this appendix wins; the capability scope of
> the body is unchanged.

| # | Delta vs spec body | Resolution |
|---|---|---|
| E1 | Spec §5.5/§7.1 proposes new canonical-hash + EV#### helpers | Reuse the LIVE-PROVEN infrastructure from the REA programme: `canonicalJson` in `src/security/reaEvidence.ts` (verified exact against real server exports) backs `canonicalSha256`; `nextEvidenceId` from `src/security/orchestrator.ts` mints `EV####` |
| E2 | Parent (loam-security-system) is not in this repo | Audit seeding targets THIS repo's real audit service (`src/security/audit/`, runs under `<DATA_DIR>/security-audits`) behind `remediate.seedFromAudit` (U-7 default); primary seeds are assessments + runtime inventory |
| E3 | Spec §6.6 proposes new UI surfaces | The remediation tab lands INSIDE the existing `ui/security.html`/`ui/security.js` Arabic panel, cloning its reviewed-checkbox pattern (the repair review form) — no new page |
| E4 | `CreatePrInput` has no `draft` (verified: 0 occurrences in `gitPrProvider.ts`) | Additive `draft?: boolean` + `PrInfo.draft`; existing callers unchanged |
| E5 | Route placement | `/api/security/remediations*` rides the existing assessments block (`src/server/http.ts` ~:796) under the same-origin guard already at ~:541; gates are HTTP/UI-only, never model tools |
| E6 | Security mode card already extended by the concurrent session (recon_scan/llm_scan/mcp_scan) | EXTEND not replace: + 4 `remediation_*` tools + `skill_list`/`skill_view` + Arabic starter; `catalog.ts` is a HOT file → surgical blob |
| E7 | Branch/label conventions | Commits `remediate MPn:` on the current branch, label `remediate-capability`; surgical blob staging for every shared hot file (~100 pending files from the concurrent session) |
| E8 | Anti-hallucination inventory | Every hit re-reads file:line and is dropped unless the signal text matches; all network/repo content wrapped `markUntrusted` with size caps |
| E9 | Packaging | `security/advisories/**` added to `electron-builder.yml` via surgical blob (hot file); skills already ship |
| E10 | Docker verified UNAVAILABLE on this machine (`docker version` → no server) | OD-7 optional confirmed: primary acceptance path is no-Docker (`patched_unverified` + acceptUnverified checkbox + `[unverified]` PR prefix); the Docker path ships fully coded behind `REMEDIATE_DOCKER=1` with stub-governed tests |
| E11 | Anchors verified live 2026-10-25 | repairs/dependencies/assessments/findings/gitWorkflowTools/gitPrProvider/approvals/pending/subagent-registry + `ui/security.*` all present; `DEFAULT_MAX_CONCURRENT_CHILDREN = 4`; `approvePush` path live |

*End of REMEDIATE_INTO_LOAM_INTEGRATION.md. Approved 2026-10-25; implementation as commits `remediate MPn:` with branch label `remediate-capability`.*
