#!/usr/bin/env node
// Minimal ACP agent used only by tests. Speaks NDJSON JSON-RPC over stdio.
// Behavior is controlled by env vars so one fixture covers every scenario:
//   FAKE_ACP_MODE       normal (default) | silent | hang | permission
//   FAKE_ACP_ECHO_ENV   name of an env var whose value is echoed back as text
import readline from "node:readline";

const mode = process.env.FAKE_ACP_MODE || "normal";
const echoEnv = process.env.FAKE_ACP_ECHO_ENV;

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = readline.createInterface({ input: process.stdin });

let sessionId = null;
let pendingPermission = null;

function chunk(text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  // A response to a server-initiated request (e.g. session/request_permission).
  if (!method && id !== undefined) {
    if (pendingPermission) {
      const resolve = pendingPermission;
      pendingPermission = null;
      resolve(msg.result);
    }
    return;
  }

  if (method === "initialize") {
    const result = { protocolVersion: 1, agentCapabilities: {} };
    const delay = Number(process.env.FAKE_ACP_INIT_DELAY_MS || 0);
    if (delay > 0) setTimeout(() => respond(id, result), delay);
    else respond(id, result);
  } else if (method === "session/new") {
    sessionId = "sess-1";
    respond(id, { sessionId });
    if (echoEnv) chunk(`echo:${process.env[echoEnv] ?? "<unset>"}`);
  } else if (method === "session/prompt") {
    if (mode === "silent" || mode === "hang") return;
    if (mode === "permission") {
      const reqId = `perm-${Date.now()}`;
      send({
        jsonrpc: "2.0",
        id: reqId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tc1", title: "Write file" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
          ],
        },
      });
      pendingPermission = (result) => {
        chunk(`permission:${JSON.stringify(result)}`);
        respond(id, { stopReason: "end_turn" });
      };
      return;
    }
    chunk("hello ");
    chunk("world");
    respond(id, { stopReason: "end_turn" });
  }
});

rl.on("close", () => process.exit(0));
