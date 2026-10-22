# Navigation journey review — 2026-10-18

Implemented persistent back/home/breadcrumb controls in the application shell across collections, task pages, modes, studios and service pages. The back action uses app-owned route history, with a parent fallback for direct entry; it does not traverse embedded-frame history or leave the application. Fallback resets the trail to avoid parent/child loops.

Standalone tool pages receive safe return/home links. Existing home links in embedded tools target the top window; Escape no longer navigates an embedded tool into a nested app shell. Failed routes expose retry/home actions and retain navigation. Late failures from a route that has already changed are ignored.

Validation: existing Loam UI regression plus route checks for tasks/projects/schedules/services, seven service pages, five studios and seven modes; direct-entry back, repeated fallback to home, internal back, unknown service recovery and return links on eleven standalone pages. Existing responsive checks cover 320/768/1440 widths, RTL/LTR and 200% zoom. Installed UI assets copied with hash verification. Reviewed installed companions page and exercised return to services. Evidence: output/verification/journey-companions.png.

Scope: navigation and recovery paths, not certification of every business operation in each studio. Renderer-only pages (Office/PDF, mobile preview and creative render) intentionally retain host navigation rather than injected standalone controls. Unsaved-draft protection across all tools, cross-route form-state restoration and comprehensive keyboard/focus behavior remain separate review areas.
