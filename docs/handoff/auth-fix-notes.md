# Auth: login persists across app relaunches (P0 fix)

## Root cause
The pending login token saved by ipcHandlers.auth.setToken lived only in a
main-process variable (pendingLoginNonce). The login flow spans a relaunch:
the app opens the system browser and the browser reopens the app through the
desktop-ipc-event listener bridge. After that relaunched start, the new main
process had an empty nonce and rejected the login token ("nonce mismatch"),
so the session token was never written into userData/.loam-local-auth-token /
localStorage.json — every later launch showed the login screen again.
