// Parses recorder state lines from the server process. Electron is not required
// here so the parser can be tested without a window.
const MARKER = "loam-recorder-state ";

function createFeed(ui) {
  let pending = "";
  let sessionId = "";
  return {
    sessionId() {
      return sessionId;
    },
    push(chunk) {
      pending += String(chunk);
      const lines = pending.split(/\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const at = line.indexOf(MARKER);
        if (at < 0) continue;
        try {
          const state = JSON.parse(line.slice(at + MARKER.length));
          if (typeof state.sessionId === "string" && state.sessionId) sessionId = state.sessionId;
          if (state.state === "countdown") ui.showCountdown(Number(state.seconds) || 3);
          else if (state.state === "recording" || state.state === "paused") ui.showRecording();
          else ui.clear();
          if (state.state === "idle") sessionId = "";
        } catch {
          // A split or noisy line is ignored. The next state line replaces it.
        }
      }
    },
  };
}

module.exports = { createFeed, MARKER };
