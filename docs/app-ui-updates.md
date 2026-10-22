# UI updates — local release channel

The settings page includes current version, check action, download percentage and an explicit install/restart action. Electron exposes a narrow IPC API to its own main frame only. Ordinary browser tabs explain that installation is available from the installed Loam application.

The updater checks on startup and every four hours, downloads newer releases, and installs only on explicit request. Installation checks active/queued/pending tasks first. No install-on-exit is enabled. The UI prompts the user to save edits before restart.

Default source on this machine is a loopback-only server owned by Electron, serving only release artifacts from `%APPDATA%/manus-local/updates`. A configured updateFeedUrl, GitHub release source or environment override takes precedence. A local channel is not an Internet release service.

`npm run dist` builds the installer and publishes it locally through `npm run publish:local-update`. Future releases need a higher package version. The publishing script copies the installer and blockmap and replaces latest.yml last, with SHA-512 and file size. A missing/unavailable channel is reported as an error, never as proof of being up to date.

Validation: scripts/check-app-updater.mjs checks deduplicated requests, state/progress events, explicit install, active-task guard and channel isolation. scripts/check-app-update-ui.mjs checks the visible workflow, cancelled confirmation and recovery after a blocked install. Existing complete Loam UI regression passed. Full repository TypeScript reports existing errors in src/server/http.ts (duplicate stopped) and src/swarm/service.ts (undefined productType); those unrelated files were not changed in this task.

Installed end-to-end test results are recorded under output/verification/app-update/result.json when completed.

0.5.25 diagnosis: the installed application and local publication both advertised 0.5.24, while dist/server.cjs had newer development contents. A successful check therefore could not deliver those unpublished changes. Current-version messages now explicitly identify the local channel and show installed/published versions and check time; they do not imply a global Internet release check. A different non-upgradable advertised version has its own channel-mismatch state, and synchronous feed failures and concurrent checks return normalized status. Publication refuses downgrades, mismatched package versions and changed installer contents under an already published version.

0.5.25 checks: updater, UI and isolated publication tests pass. The general Loam UI suite currently stops on a hidden journey navigation button in studios/mobile; this unrelated navigation issue is not a passing check for this release. The packaged candidate was launched on port 3941 with an isolated profile, verified against the 0.5.25 manifest and visually reviewed (candidate-current.png). The real 0.5.24 detected and downloaded 0.5.25. A newly started user task prevented installation as intended; installation was confirmed again only after no tasks were active.

Installed verification completed for 0.5.24 -> 0.5.25, preserving the profile ID and all 130 baseline tasks. The restarted installed application reports both currentVersion and published version as 0.5.25 with a successful check timestamp. Its updater, update UI, server bundle and package.json match release/win-unpacked by SHA-256 (installed-files-0.5.25.json). The installed-current.png screenshot was visually reviewed; Loam was reopened for the user afterward.

Installed verification completed: the real installed 0.5.23 was bootstrapped with the update controls, detected/downloaded 0.5.24 through its local feed, displayed the install action, preserved download state on cancelled confirmation, and installed/restarted 0.5.24 after explicit UI confirmation. The test checks the profile ID and every preexisting task after restart. See output/verification/app-update/result.json. The ready-to-install native Electron screenshot was visually reviewed; installed updater, UI/navigation and server files were compared to the packaged release by SHA-256.
