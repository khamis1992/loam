// IPC channel names from BUILD_SPEC §8.3 (desktop-ipc-meta / desktop-ipc-api / desktop-ipc-event).
const IPC_INVOKE = "desktop-ipc-api";
const IPC_EVENT_PREFIX = "desktop-ipc-event";
const IPC_META = "desktop-ipc-meta";
const IPC_SYNC = "desktop-sync-info";

// MVP namespaces required by the spec; all others are stubbed where referenced.
const NAMESPACES = [
  "auth",
  "window",
  "system",
  "updater",
  "theme",
  "appearance",
  "desktopOperator",
  "terminal",
  "keepAwake",
  "shortcut",
  "env",
  "diagnosticLogs",
  "desktopActivityIndicator",
  "storage",
];

module.exports = { IPC_INVOKE, IPC_EVENT_PREFIX, IPC_META, IPC_SYNC, NAMESPACES };
