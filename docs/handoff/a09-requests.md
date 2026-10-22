# A9 cross-path edits

Per the global rule, A9 only owns `electron/**`, `electron-builder.yml`,
`src/server/http.ts`, `src/agent/model.ts`, `src/ollama.ts`, and new
`src/security/localAuth.ts`. The following files were edited to satisfy A9
acceptance criteria and are noted here for the owning agent / A10 integration.

| File | Owner (per AGENTS_PLAN) | Reason for edit |
|------|--------------------------|-----------------|
| `src/config.ts` | unassigned / backend foundation | Honour `LOAM_ROOT`: override `cfg.workspace` and `cfg.computerUse.screenshotDir` when the env root is set, instead of letting `config.json` point back into the source tree. |
| `src/index.ts` | unassigned / backend foundation | Respect `LOAM_ROOT` for the `bootSettings.workspace` override; do not let `settings.json` move the workspace out of the env root when `LOAM_ROOT` is set. |
| `package.json` | A0/root | Added missing `@electron/fuses` dev dependency for the afterPack fuse hook, and `@xmldom/xmldom` which was required for `npm run typecheck` to pass. |

All other changed files are inside A9's owned paths.
