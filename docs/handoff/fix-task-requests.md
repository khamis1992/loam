# Fix requests from `task` agent

## 1. (Optional) Desktop environment values for branch / Downloads

The task page now reads `cwd` from the URL query and passes it into the first `user_message.extData.desktopBinding`. The home page is already sending `desktopSync.env.GIT_BRANCH` and calling `__apis.system.getDownloadsPath()` when available. If the Electron main/preload layer exposes these values, the branch chip and the `cwd=` query parameter will work automatically.

No action required from the web side; this is a heads-up for the desktop/auth agent if those values are not yet wired.
