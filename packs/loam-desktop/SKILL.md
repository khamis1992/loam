# Loam Desktop

Use the App Builder project with kind `electron-app`. `desktop_init` scaffolds a local Electron file organizer without replacing existing work. `desktop_attach` resumes it by project id. `desktop_verify` runs the App Builder checks, Vite build, TypeScript and a real Electron search-and-tag smoke test, then stages the verified app resource in the user's task. Call `finish` only after these checks pass; the normal pack gate publishes the staged resource.

`desktop_present` publishes only verified output. `desktop_launch` starts an isolated Electron process, and `desktop_stop` stops only its recorded PID. A project is not an installer until the user explicitly asks electron-builder for one.
