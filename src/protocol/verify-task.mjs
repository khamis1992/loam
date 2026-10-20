#!/usr/bin/env node
/**
 * End-to-end protocol verification for a real agent task.
 *
 * 1. Logs in via the dev login redirect flow.
 * 2. Creates a session by sending user_message over the chat socket.
 * 3. Streams events until the final assistant result arrives.
 *
 * Usage: node src/protocol/verify-task.mjs
 */

import { io } from "socket.io-client";

const API_BASE = process.env.AS_PROTOCOL_API_BASE || "http://localhost:8787";
const PROMPT = process.env.VERIFY_PROMPT || "write hello world in python";
const TASK_MODE = process.env.VERIFY_MODE || "standard";

async function httpJson(path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function login() {
  const nonce = "verify-" + Date.now();
  const loginUrl = `${API_BASE}/login?nonce=${encodeURIComponent(nonce)}`;
  const res = await fetch(loginUrl, { redirect: "manual" });
  const location = res.headers.get("location") || "";
  const tokenMatch = location.match(/[?&]token=([^&]+)/);
  if (!tokenMatch) throw new Error(`login redirect missing token: ${location}`);
  const loginToken = tokenMatch[1];

  const { token: tempCode } = await httpJson("user.v1.UserAuthService/GenerateTempAuthCode", {}, loginToken);
  const { token: sessionToken } = await httpJson("user.v1.UserAuthPublicService/ExchangeTokenByCode", { token: tempCode });
  return sessionToken;
}

function shortUid() {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, (b) => alphabet[b % 62]).join("");
}

async function run() {
  const token = await login();
  console.log("logged in, session token", token.slice(0, 8) + "...");

  const list = await httpJson("session.v1.SessionService/ListSessions", { limit: 10 }, token);
  console.log("existing sessions:", list.total);

  const sessionId = shortUid();
  const socket = io(API_BASE, {
    transports: ["websocket"],
    auth: { token },
    query: { locale: "en", tz: "UTC", clientType: "desktop", clientVersion: "0.0.0", "x-product-name": "Agent Studio" },
  });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  socket.emit("message", {
    type: "join_session",
    id: shortUid(),
    timestamp: Date.now(),
    sessionId,
    version: 2,
  });

  // Wait briefly for join ack, then send the task.
  await new Promise((r) => setTimeout(r, 200));

  socket.emit("message", {
    type: "user_message",
    id: shortUid(),
    sessionId,
    timestamp: Date.now(),
    messageStatus: "pending",
    messageType: "text",
    taskMode: TASK_MODE,
    content: "",
    contents: [{ type: "text", value: PROMPT }],
    attachments: [],
    extData: { capabilities: { enabledAddons: [], connectorAccounts: [], enabledConnectors: [] } },
  });

  console.log(`sent user_message for session ${sessionId}`);

  let done = false;
  const events = [];

  socket.on("message", (frame) => {
    events.push(frame);
    const ev = frame.event || {};
    const summary = ev.type === "chat" && ev.sender === "assistant" && ev.deliveryKind === "result"
      ? ` -> assistant result: ${ev.content.slice(0, 120).replace(/\n/g, " ")}`
      : ev.type === "chat" && ev.sender === "user"
        ? " -> user"
        : ev.type === "toolUsed"
          ? ` -> tool ${ev.tool} ${ev.status}`
          : ev.type === "statusUpdate"
            ? ` -> status ${ev.agentStatus}`
            : ` -> ${ev.type}`;
    console.log(`[${new Date().toISOString()}]${summary}`);

    if (ev.type === "chat" && ev.sender === "assistant" && ev.deliveryKind === "result") {
      done = true;
      console.log("\n✓ final assistant answer received");
      console.log(ev.content);
      socket.disconnect();
      process.exit(0);
    }
  });

  // Timeout safety.
  setTimeout(() => {
    if (done) return;
    console.error("\n✗ timed out waiting for final assistant answer");
    console.error("events received:", events.length);
    socket.disconnect();
    process.exit(1);
  }, 120_000);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
