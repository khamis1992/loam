# Installed security runtime verification — 2026-10-18

Installed application: Loam 0.5.12, `http://127.0.0.1:3939`.
Security engine revision: 8.

Deployment copied the built server and security HTML/JS/CSS, preserving the profile and all 28 existing tasks. Installer refused active tasks and active assessments before restarting. Installed files were SHA-256 compared with source artifacts. Backup and installation verification: `output/verification/security-runtime-backup-20261018-102602/verification.json`.

Verified installed capabilities: browser rendering, login/SPA flows, scoped POST, explicit API origins, cross-origin authorization, browser resource budgets, evidence and retesting. Capability flags alone are not proof of comprehensive coverage.

`LOAM_SECURITY_TEST_BASE=http://127.0.0.1:3939 npm run check:security-http` passed against the installed runtime. It exercised API validation, origin protection, task isolation, multi-account UI configuration, matrix results, evidence export, resource/API configuration serialization and installed-runtime retest/persistence. The test created two isolated draft tasks; the earlier 28 were retained.

## Nutrio local run

Task: `task_mvdgpt5nebe502e9c213`.
Run: `c6a590d2-d14e-4743-9a12-83585c9b1b31`.
Evidence: `output/verification/nutrio-installed-revision8.json`.

The installed engine reproduced 718 requests and 43,732,376 received browser bytes. All four sign-in-screen assertions completed. The render verified a visible readiness selector, complete document and settled network, with no failed browser HTTP resources or runtime errors.

Overall status remains partial: six Vite WebSocket connections were blocked, and the initial HTTP root check reported a redirect. No real Nutrio credentials were used; no Supabase origin was granted. These observations prove anonymous UI loading, not authenticated API or application authorization coverage. Screenshots of Nutrio were disabled; the saved installed-UI screenshot uses synthetic test accounts.

Outstanding: supply dedicated Nutrio test identities and synthetic records, explicitly designate the test backend, verify real authenticated workflows and API matrix, and expand detector/remediation coverage and independent benchmark evidence. Frontier capability remains unproven.
