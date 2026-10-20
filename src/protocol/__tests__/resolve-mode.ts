/** Resolve-mode unit tests for protocol mode routing (int-p1). */

import assert from "node:assert";
import { detectModeFromText, resolveLoamMode } from "../../modes/detect.js";
import type { UserMessage } from "../types.js";

function um(opts: { taskMode?: UserMessage["taskMode"]; loamMode?: string; mode?: UserMessage["taskMode"] } = {}): UserMessage {
  return {
    id: "msg-1",
    timestamp: Date.now(),
    type: "user_message",
    sessionId: "sess-1",
    messageStatus: "pending",
    messageType: "text",
    taskMode: opts.taskMode ?? "standard",
    content: "",
    contents: [],
    attachments: [],
    extData: {
      capabilities: { enabledAddons: [], connectorAccounts: [], enabledConnectors: [] },
      ...(opts.loamMode !== undefined ? { loamMode: opts.loamMode } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    },
  };
}

function check(name: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

function detect(name: string, prompt: string, expected: string): void {
  check(`detectModeFromText: ${name}`, detectModeFromText(prompt), expected);
}

function resolve(name: string, message: UserMessage, prompt: string, expected: string): void {
  check(`resolveLoamMode: ${name}`, resolveLoamMode(message, prompt), expected);
}

// Keyword detection rules from int-p1 spec.
detect("media / ffmpeg", "convert with ffmpeg", "media");
detect("media / video", "edit this video", "media");
detect("media / mp4 trim", "trim the mp4", "media");
detect("media / image logo svg", "create an svg logo", "media");
detect("media / design poster", "design a poster", "media");
detect("media / video trim seconds", "trim the first 2 seconds of a video", "media");
detect("write / pptx", "make a pptx", "write");
detect("write / docx memo", "write a memo in docx", "write");
detect("write / pptx slides deck", "create a powerpoint deck with slides", "write");
detect("data / csv", "analyze this csv dataset", "data");
detect("data / spreadsheet", "build an excel spreadsheet with charts", "data");
detect("data / excel bar chart", "excel with a bar chart", "data");
detect("security / pentest", "run a pentest", "security");
detect("security / tls headers", "scan tls headers", "security");
detect("security / port vulnerability scan", "port and vulnerability scan on 127.0.0.1", "security");
detect("research / open website", "open a website for me", "research");
detect("research / browse url", "browse this url http://example.com", "research");
detect("research / open https", "open https://example.com and summarize", "research");
detect("research / web search", "web search the latest news", "research");
detect("research / search", "search for info", "research");
detect("research / look up", "look up the answer", "research");
detect("build / app", "build a mobile app", "build");
detect("build / web app", "build a small todo web app", "build");
detect("build / default", "hello", "build");

// resolveLoamMode precedence and fallbacks.
resolve("explicit loamMode overrides prompt", um({ loamMode: "research" }), "build me an app", "research");
resolve("explicit loamMode alias discuss→ask", um({ loamMode: "discuss" }), "anything", "ask");
resolve("explicit invalid falls back to detection", um({ loamMode: "unknownmode" }), "create a logo", "media");
resolve("lite taskMode stays ask", um({ taskMode: "lite" }), "hello", "ask");
resolve("discuss taskMode stays ask", um({ taskMode: "discuss" }), "hello", "ask");
resolve("max taskMode defaults build", um({ taskMode: "max" }), "hello", "build");
resolve("standard taskMode defaults build", um({ taskMode: "standard" }), "hello", "build");
resolve("detection overrides lite taskMode", um({ taskMode: "lite" }), "create a presentation", "write");
resolve("extData.mode used when no loamMode", um({ mode: "discuss" }), "hello", "ask");
resolve("security mode valid", um({ loamMode: "security" }), "hello", "security");

console.log("PASS resolve-mode unit tests");
