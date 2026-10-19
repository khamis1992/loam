# Mobile builder: Bolt review and local-first implementation

Reviewed 2026-10-18 in the user's open [Bolt project](https://bolt.new/~/sb1-1kf54myc). This is a capability inventory and implementation record, not a claim of complete functional parity. The user selected **local services inside Loam first** for authentication, users, storage and publishing. No cloud accounts, subscriptions or external deployments were created.

## Reference behavior observed

The landing page centers the prompt composer. A project switches to chat on the left and a workbench on the right. User requests appear in a bounded bubble; the assistant response uses readable paragraphs, collapsible execution actions and a version card. The composer stays at the bottom.

An actual reversible request changed the reference app heading from “My Day” to “مهامي اليومية” and its introductory copy. Bolt completed four actions and saved Version 2; existing task content remained. Plan mode and the context/model menus were opened. Plan mode was returned to its original setting. No publishing, sharing, connector permissions or database settings were changed.

## Reference order and Loam status

The following orders were read from the open reference interface. Labels below describe services, not promises that Loam implements all of them.

| Area | Reference order | Loam in this change |
| --- | --- | --- |
| Workbench | Preview → Code → Database → More Options | Compact toolbar in reference order; actual web/Expo/Kotlin file explorer and editor, syntax colors/line numbers, validated `mobile.json`, database, settings, route/reload/device controls and local Git. |
| Database | Tables → Security → Authentication → User Management → Server Functions → File Storage → Secrets → Logs → Advanced | Same ordered navigation. Tables use the real preview record store. Existing field/relation/business validation and schema editor are linked. Build logs are real. Auth, users, server functions, file storage and secret vault explicitly show that implementation is needed. |
| Project settings | General → Domains & Hosting → Analytics → Knowledge → Skills → Backups | Same ordered groups. Immutable local publishing and rollback, searchable/bookmarked source versions, JSON backup and undo/redo work. Public domain hosting, usage analytics and per-project model knowledge remain pending. |
| Account settings | General → Applications → Knowledge → Connectors (MCP) → Add-on features | Same ordered inventory with links to the existing Loam settings, knowledge and integration services. Per-mobile-project context/execution integration is explicitly partial. |
| Workspace settings | Subscription & Tokens → Cloud → Skills library | Local equivalents: Usage & Models → Local Infrastructure → Skills Library. No fictitious billing, token balance or cloud usage is displayed. |
| More Options | Analytics → Knowledge → Skills → Connectors → All project settings; integrations Stripe and Bolt Database | Relevant local service settings are grouped above. Stripe and a Bolt account/database connection are not implemented or imitated. |
| Chat header | Comments → Version history → Collapse chat | Searchable persistent version drawer, bookmarks and restore of schema plus code; collapse/restore chat. Comment threads remain pending. |
| Composer context | Attach file → Figma import → Prompt library → Enhance prompt → Help Center → Connectors → Skills | Not all implemented. The existing suggestion prompts, model picker and click-to-edit work. Upload/Figma/voice/Plan and mobile-scoped connectors/skills remain gaps. |
| Code footer | Bolt → Publish Output → Terminal | Loam build events → real local publish output → multiple real xterm/node-pty sessions, add/close controls and collapsible bottom panel. Terminal cwd is the isolated generated app worktree. |
| Share | Copy link → Invite by email → Project access → Viewers | Local saved-screen link works. Collaboration, invitations and access management are absent. |
| Publish | Visibility → Security audit → Publish | Immutable local web releases, actual links, active-release rollback and source export. Public hosting and per-application backend security checks remain pending. |

Additional observations: reference File Storage management itself showed “coming soon”; account models/add-ons and project design systems contained paid or locked features. No secret values or billing details were read. The Secrets control was inventoried, but its detail screen did not visibly open and is not claimed as inspected.

## Implemented UI and behavior

- Existing Loam colors and RTL content; source/focus order is chat then workbench, visually matching the reference's left chat/right preview.
- A centered new-project prompt, then persistent per-project conversation, actual build/repair events and concise replies based on server result checks.
- Preview remains the default; advanced tools move into dialogs and the project menu.
- Code panel validates the JSON on the server, preserves rejected drafts, saves revisions, and supports existing undo/redo. Unapplied source drafts trigger a leave confirmation.
- Source files are editable with revision/hash conflict checks. Web source has a separate working preview; edited Expo files are exported and edited Kotlin files enter the Android compiler. Generated updates preserve source overrides and report terminal edits for explicit import.
- Custom web code runs in an opaque-origin iframe with no network/API access. A frame-bound storage bridge persists only this application's values and validates record changes under the existing host Web Lock. Published apps use a trusted wrapper around the same sandbox; their source snapshots are immutable.
- Version history persists beyond the eight-step undo window, supports search/bookmarks, and restores schema plus code without clearing browser-local application data. Legacy versions have no fabricated timestamp.
- Table panel mounts the same collection forms/validation/store as the phone preview; changes propagate between panes and survive reload. Records remain browser-local; they are not a server database and do not sync between devices.
- Service navigation follows the reference order and states availability. Missing services have explanatory content, not simulated success forms.
- Narrow layouts switch between chat and workbench. Tools and service settings remain reachable at 320 CSS pixels.
- Content generation preserves existing screen identities, primary/detail classification, parents and navigation links. A one-request opt-in in project tools allows restructuring. Explicitly selected element edits can change the selected element's type without regenerating the other screens. An identical model output is rejected and retried instead of reported as a successful change.

## Verification

`npm run check:mobile` passed after the workbench integration. It uses an isolated real HTTP server and deterministic model fixture, covering generation/repair, conflicts, persistence after server restart, navigation/storage, 40-screen navigation, source rejection/save/undo/redo, source draft protection, shared records between workbench and phone, ordered services, responsive dialogs and 320px layout. This fixture test does not establish local-model quality.

A separate visible-browser run used **qwen2.5:14b** on the live server at port 3941. It created the new “يومي” project (`task_mvdsbysy50da161f7bbd`) with two main sections and a child task-details page. Generation needed automatic repair; navigation, parent Back and saving/reloading the task description were checked. The first output made the completion toggle a self-navigation button. A whole-project follow-up corrected the toggle but changed a main section into a detail page. That revision was undone. This led to the navigation guard and identical-output check above.

After the fixes, click-to-edit selected the completion element and the local model converted it to a toggle in one attempt. Revision 5 retained all three screens, both primary sections and the task-details input. Checking the toggle and reloading retained its value; opening the details page retained “مراجعة تجربة البناء الجديدة وإنجاز اختبار التنقل”. Undo and redo were tested, ending at revision 7 with the correct toggle and its saved value. The original Rafiq project remained revision 14 and retained its existing input. Embedded fullscreen was also opened and closed successfully.

`npx tsx src/scripts/check-mobile-build.ts` passed, including bounded repairs, no-change rejection, navigation classification preservation, deleted-link rejection without saving, scoped type conversion, cancellation and revision conflicts. `npm run check:mobile -- --bundle` passed against the final bundled server. The live preview server was restarted on port 3941 (process 57988); no other application port was stopped.

Screenshots: [preview](../release/mobile-live/builder-review/preview.png), [service settings](../release/mobile-live/builder-review/services.png).

Global TypeScript checking currently reports errors in concurrent Creative/Office work outside the mobile change. No mobile file appeared in the final typecheck diagnostics. The mobile integration tests are the relevant passing verification; global typecheck must not be described as passing.

## Remaining local service implementation order

1. App-specific SQLite data service and migrations, keeping browser-local export compatibility explicit.
2. Local authentication, session lifecycle and user administration, then server-enforced ownership/permissions. Do not present client-side validation as authorization.
3. Local file service with bounded uploads and app/user isolation; encrypted secret storage with redacted logs and model context.
4. Usage events/analytics. Immutable local releases and rollback are now implemented.
5. Project knowledge/skills/connectors in the actual mobile generation pipeline; prompt assets, Plan mode and collaboration tools. Full version browser is now implemented.

These backend services are authorized for local-first implementation by the user's preference, but are **not completed by this interface change**.

## Screenshot-request completion (2026-10-18)

The missing toolbar, source IDE, searchable version history and interactive console shown in the user's three screenshots are now implemented. Local Git initialization/commit works; no GitHub authentication, remote setup or push is implied. The application remains a schema-driven generator: web edits have a web preview, while Expo/Kotlin are native source targets. This does not claim arbitrary React TSX compilation in the browser.

`npm run check:mobile` and `npm run check:mobile -- --bundle` pass with the new `check-mobile-ide.ts` integration: real source file editing, stale revision/path rejection, source undo/redo, changed CSS visible in the sandbox, record creation/reload/publication, bookmarks/version restore without data loss, immutable published output after restore, real local Git commit, a real PTY command, session cleanup and 320px layout. The enclosing test restarts the HTTP server and verifies bookmark/release persistence. `check-mobile-build.ts` also passes. Bundled server build succeeds. Global typecheck still reports an unrelated concurrent Security file error; no mobile diagnostics remain.

The live 3941 workspace was inspected in the browser on Rafiq revision 14, with its existing task description intact. A real PowerShell session in the application's isolated worktree executed `echo LOAM_MOBILE_TERMINAL_OK` and displayed the result. No external service or remote repository was contacted.

Final browser evidence: [source editor and terminal](../release/mobile-live/ide-review/code-terminal.png), [version drawer](../release/mobile-live/ide-review/history.png). The verification shell was stopped after the command, leaving the output visible. The updated test server remains running on port 3941.
