#!/usr/bin/env tsx
/**
 * Neo N17: the external-agent canvas bridge CLI.
 *
 *   loam-canvas submit "prompt" [--canvas <id>] [--agent <ref>] [--parallel <n>]
 *              [--parent <nodeId>] [--follow] [--json]
 *   loam-canvas batch a.md b.md [--canvas <id>] [--json]
 *   loam-canvas nodes [--canvas <id>] [--parent <nodeId>] [--type <t>] [--json]
 *   loam-canvas result <nodeId> [--canvas <id>] [--json]
 *   loam-canvas status [--canvas <id>] [--json]
 *   loam-canvas follow <nodeId> [--canvas <id>] [--timeout <ms>] [--json]
 *   loam-canvas watch [--canvas <id>] [--json]
 *
 * An external agent session (OpenCode / Claude Code / Orca) drives a Loam canvas
 * through the same local HTTP/WS API the web client uses. Authentication is the
 * install token: the CLI reads the file the Electron main process writes
 * (`<userData>/.loam-local-auth-token`, and the `LOAM_LOCAL_TOKEN_DIR` it sets),
 * so an agent never has to hold a secret of its own.
 *
 * Defaults:
 *   --port    from `$LOAM_CANVAS_PORT` / `$LOAM_PORT`, else the port the running app
 *             announced (`.loam-port` next to the data directory), else 3939
 *   --token   from `$LOAM_LOCAL_TOKEN`, else the token file, else none (the server
 *             accepts unauthenticated calls when `LOAM_AUTH_DISABLED=true`)
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";

const DEFAULT_PORT = 3939;
const MAX_FOLLOW_MS = 5 * 60_000;

interface CliOptions {
  port: number;
  token?: string;
  json: boolean;
  color: boolean;
  canvas?: string;
  agent?: string;
  parent?: string;
  type?: string;
  parallel?: number;
  follow?: boolean;
  watch?: boolean;
  timeoutMs: number;
}

type Json = Record<string, unknown>;

/** Exit codes: 0 ok, 1 client error, 2 usage error. */
function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stdout.write(`loam-canvas — drive a Loam canvas from an external agent session

Usage:
  loam-canvas submit <prompt> [options]
  loam-canvas batch <file> [<file> ...] [options]
  loam-canvas nodes [options]
  loam-canvas result <nodeId> [options]
  loam-canvas status [options]
  loam-canvas follow <nodeId> [options]
  loam-canvas watch [options]

Options:
  --port <n>        port of the running Loam server (default: $LOAM_CANVAS_PORT,
                    the announced port, else ${DEFAULT_PORT})
  --token <t>       install token (default: $LOAM_LOCAL_TOKEN, else the token file)
  --canvas <id>     canvas (Loam task) id; created when omitted
  --agent <ref>     Loam agent id or name; an unknown ref with --parallel becomes
                    a fresh bridge agent
  --parent <id>     parent node id for the new node (default: the agent's cursor)
  --parallel <n>    independent arm number, so parallel agents get their own cursor
  --type <t>        node type filter for \`nodes\`
  --follow          submit: block until the node settles and print its result
  --timeout <ms>    follow timeout (default: ${MAX_FOLLOW_MS})
  --watch           hold one WebSocket and print every live node change
  --json            machine-readable output
  --no-color        disable ANSI colour
  -h, --help        this message

Examples:
  loam-canvas submit "Summarise the report" --agent opencode --follow
  loam-canvas submit "Second opinion" --parallel 2 --agent claude
  loam-canvas batch prompts/*.md --canvas task_abc --json
  loam-canvas watch --canvas task_abc
`);
  process.exit(0);
}

/** Parse argv into options plus positional arguments. */
function parseArgv(argv: string[]): { options: CliOptions; positional: string[] } {
  // Parse a copy: `flag` consumes `--name value` pairs, and the caller still owns
  // its own argv.
  const args = [...argv];
  const options: CliOptions = {
    port: Number(process.env.LOAM_CANVAS_PORT) || DEFAULT_PORT,
    json: false,
    color: true,
    timeoutMs: MAX_FOLLOW_MS,
  };
  const positional: string[] = [];
  const flag = (name: string): string | undefined => {
    const index = args.findIndex((arg) => arg === `--${name}`);
    if (index < 0) return undefined;
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };
  const numberFlag = (name: string): number | undefined => {
    const raw = flag(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) fail(`--${name} needs a number`);
    return value;
  };
  const options_ = flag("token");
  if (options_) options.token = options_;
  const port = numberFlag("port");
  if (port !== undefined) options.port = port;
  const canvas = flag("canvas");
  if (canvas) options.canvas = canvas;
  const agent = flag("agent");
  if (agent) options.agent = agent;
  const parent = flag("parent");
  if (parent) options.parent = parent;
  const type = flag("type");
  if (type) options.type = type;
  const parallel = numberFlag("parallel");
  if (parallel !== undefined) options.parallel = parallel;
  const timeout = numberFlag("timeout");
  if (timeout !== undefined) options.timeoutMs = timeout;
  options.follow = args.includes("--follow");
  options.watch = args.includes("--watch");
  options.json = args.includes("--json");
  options.color = !args.includes("--no-color");
  positional.push(...args.filter((arg) => !arg.startsWith("--")));
  return { options, positional };
}

/** Read the install token the way the Electron main process writes it. */
function readToken(options: CliOptions): string | undefined {
  if (options.token) return options.token;
  const fromEnv = process.env.LOAM_LOCAL_TOKEN;
  if (fromEnv) return fromEnv;
  // Electron sets `LOAM_LOCAL_TOKEN_DIR` to the user-data dir; the token file lives
  // there in both the packaged app and the dev server.
  const dir = process.env.LOAM_LOCAL_TOKEN_DIR || process.env.LOAM_DATA_DIR || process.env.MANUS_LOCAL_DATA_DIR || DATA_DIR;
  for (const name of [".loam-local-auth-token", ".loam-local-token"]) {
    try {
      const token = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (token.length > 0) return token;
    } catch {
      /* not in this directory: try the next candidate */
    }
  }
  return undefined;
}

/** The port the running app announced, if it left one behind. */
function announcedPort(): number | undefined {
  const dir = process.env.LOAM_LOCAL_TOKEN_DIR || process.env.LOAM_DATA_DIR || process.env.MANUS_LOCAL_DATA_DIR || DATA_DIR;
  for (const name of [".loam-port", ".loam-canvas-port"]) {
    try {
      const port = Number(fs.readFileSync(path.join(dir, name), "utf8").trim());
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      /* no announcement in this directory */
    }
  }
  return undefined;
}

/** The port every request uses: explicit flag, env, announcement, then the default. */
function resolvePort(options: CliOptions): number {
  const env = Number(process.env.LOAM_CANVAS_PORT || process.env.LOAM_PORT || process.env.MANUS_LOCAL_PORT);
  if (options.port > 0) return options.port;
  if (Number.isFinite(env) && env > 0) return env;
  return announcedPort() ?? DEFAULT_PORT;
}

async function request(options: CliOptions, pathname: string, init: RequestInit = {}): Promise<Response> {
  const port = resolvePort(options);
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  const token = readToken(options);
  if (token) headers["x-loam-local-token"] = token;
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  return response;
}

/** POST a JSON body and return the parsed reply, or throw with the server's reason. */
async function postJson(options: CliOptions, pathname: string, body: unknown): Promise<{ status: number; body: Json }> {
  const response = await request(options, pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

async function getJson(options: CliOptions, pathname: string): Promise<{ status: number; body: Json }> {
  const response = await request(options, pathname);
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

function print(options: CliOptions, payload: unknown): void {
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}\n`);
}

function requireCanvas(options: CliOptions): string {
  if (!options.canvas) fail("this command needs --canvas <id> (submit creates one on demand)");
  return options.canvas;
}

/** The bridge payload for one submit, with the CLI's own aliases. */
function submitPayload(options: CliOptions, prompt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canvasId: options.canvas,
    agentId: options.agent,
    prompt,
    parentIds: options.parent ? [options.parent] : undefined,
    parallel: options.parallel,
    follow: options.follow === true,
    ...extra,
  };
}

async function cmdSubmit(options: CliOptions, positional: string[]): Promise<number> {
  const prompt = positional.join(" ").trim();
  if (!prompt) fail("submit needs a prompt");
  const { status, body } = await postJson(options, "/api/bridge/canvas/submit", submitPayload(options, prompt));
  if (status !== 200 && status !== 202) fail(String(body.error ?? `submit failed (${status})`), 1);
  const node = (body.node ?? {}) as { id?: string; status?: string; type?: string; data?: { text?: string; error?: string } };
  if (options.follow) {
    print(options, {
      canvasId: body.canvasId,
      nodeId: node.id ?? body.nodeId,
      cursorId: body.cursorId,
      status: body.status,
      ...(node.data?.text ? { text: node.data.text } : {}),
      ...(node.data?.error ? { error: node.data.error } : {}),
    });
  } else {
    print(options, {
      canvasId: body.canvasId,
      nodeId: node.id ?? body.nodeId,
      cursorId: body.cursorId,
      status: body.status,
      follow: `loam-canvas follow ${node.id ?? body.nodeId} --canvas ${body.canvasId}`,
    });
  }
  return body.status === "failed" ? 1 : 0;
}

async function cmdBatch(options: CliOptions, positional: string[]): Promise<number> {
  if (positional.length === 0) fail("batch needs at least one file");
  const nodes = await Promise.all(
    positional.map(async (file) => {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const parsed = parsePromptFile(text);
      return parsed ?? { prompt: text.trim() };
    }),
  );
  const { status, body } = await postJson(options, "/api/bridge/canvas/batch", {
    canvasId: options.canvas,
    agentId: options.agent,
    nodes: nodes.map((node, index) => ({ ...node, parallel: index + 1 })),
  });
  if (status !== 202) fail(String(body.error ?? `batch failed (${status})`), 1);
  const accepted = (body.accepted ?? []) as Array<{ nodeId?: string; cursorId?: string; status?: string }>;
  const rejected = (body.rejected ?? []) as Array<{ index: number; reason: string }>;
  print(options, {
    canvasId: body.canvasId,
    accepted: accepted.map((entry) => ({ nodeId: entry.nodeId, cursorId: entry.cursorId, status: entry.status })),
    rejected,
  });
  return rejected.length > 0 ? 1 : 0;
}

/**
 * A batch file is either plain text (one prompt) or a `key: value` header block
 * (`prompt:`, `title:`, `model:`, `mode:`, `agentId:`, `parentId:`) followed by
 * the prompt body. That keeps a whole fan-out in one editable file per arm.
 */
function parsePromptFile(text: string): { prompt: string; title?: string; model?: string; mode?: string; agentId?: string; parentId?: string } | undefined {
  const lines = text.split(/\r?\n/);
  const headers: Record<string, string> = {};
  let index = 0;
  while (index < lines.length) {
    const match = lines[index]!.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!match) break;
    headers[match[1]!.toLowerCase()] = match[2]!;
    index += 1;
  }
  const body = lines.slice(index).join("\n").trim();
  if (!body && !headers.prompt) return undefined;
  return {
    prompt: (headers.prompt ?? body).trim(),
    ...(headers.title ? { title: headers.title } : {}),
    ...(headers.model ? { model: headers.model } : {}),
    ...(headers.mode ? { mode: headers.mode } : {}),
    ...(headers.agentid ? { agentId: headers.agentid } : {}),
    ...(headers.parentid ? { parentId: headers.parentid } : {}),
  };
}

async function cmdNodes(options: CliOptions): Promise<number> {
  const canvasId = requireCanvas(options);
  const query = new URLSearchParams();
  if (options.parent) query.set("parent", options.parent);
  if (options.type) query.set("type", options.type);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const { status, body } = await getJson(options, `/api/bridge/canvas/${encodeURIComponent(canvasId)}/nodes${suffix}`);
  if (status !== 200) fail(String(body.error ?? `nodes failed (${status})`), 1);
  const nodes = (body.nodes ?? []) as Array<{ id: string; type: string; status: string; data?: { title?: string; text?: string } }>;
  print(options, {
    runId: body.runId,
    count: nodes.length,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      status: node.status,
      ...(node.data?.title ? { title: node.data.title } : {}),
      ...(node.data?.text ? { text: String(node.data.text).slice(0, 200) } : {}),
    })),
  });
  return 0;
}

async function cmdResult(options: CliOptions, positional: string[]): Promise<number> {
  const canvasId = requireCanvas(options);
  const nodeId = positional[0];
  if (!nodeId) fail("result needs a node id");
  const { status, body } = await getJson(options, `/api/bridge/canvas/${encodeURIComponent(canvasId)}/result/${encodeURIComponent(nodeId)}`);
  if (status !== 200) fail(String(body.error ?? `result failed (${status})`), 1);
  print(options, body);
  return 0;
}

async function cmdStatus(options: CliOptions): Promise<number> {
  const canvasId = requireCanvas(options);
  const { status, body } = await getJson(options, `/api/bridge/canvas/${encodeURIComponent(canvasId)}/status`);
  if (status !== 200) fail(String(body.error ?? `status failed (${status})`), 1);
  print(options, body);
  return 0;
}

async function cmdFollow(options: CliOptions, positional: string[]): Promise<number> {
  const canvasId = requireCanvas(options);
  const nodeId = positional[0];
  if (!nodeId) fail("follow needs a node id");
  const { status, body } = await getJson(
    options,
    `/api/bridge/canvas/${encodeURIComponent(canvasId)}/follow/${encodeURIComponent(nodeId)}?timeoutMs=${options.timeoutMs}`,
  );
  if (status !== 200) fail(String(body.error ?? `follow failed (${status})`), 1);
  const node = (body.node ?? {}) as { status?: string; data?: { text?: string; error?: string } };
  print(options, {
    canvasId,
    nodeId,
    status: node.status,
    ...(node.data?.text ? { text: node.data.text } : {}),
    ...(node.data?.error ? { error: node.data.error } : {}),
  });
  return node.status === "failed" ? 1 : 0;
}

/**
 * Hold one WebSocket and print every live change.
 *
 * Uses the same handshake as the bridge (install token in the header or `?token=`),
 * so `watch` is the cheapest way to confirm an external agent sees the canvas move.
 */
async function cmdWatch(options: CliOptions): Promise<number> {
  const canvasId = requireCanvas(options);
  const port = resolvePort(options);
  const token = readToken(options);
  const url = new URL(`ws://127.0.0.1:${port}/api/bridge/canvas/${encodeURIComponent(canvasId)}/ws`);
  if (token) url.searchParams.set("token", token);
  const socket = new WebSocket(url);
  let closed = false;
  const close = (code: number): void => {
    if (closed) return;
    closed = true;
    try {
      socket.close(1000);
    } catch {
      /* already closed */
    }
    process.exit(code);
  };
  socket.onopen = () => {
    if (!options.json) process.stderr.write(`watching canvas ${canvasId} (Ctrl-C to stop)\n`);
  };
  socket.onmessage = (event: MessageEvent) => {
    let payload: unknown = event.data;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      /* not JSON: print as-is */
    }
    print(options, payload);
  };
  socket.onerror = () => fail("websocket error: is the Loam app running?", 1);
  socket.onclose = (event: CloseEvent) => fail(`websocket closed (${event.code})`, 1);
  process.on("SIGINT", () => close(0));
  // Never resolve: `watch` runs until the user stops it or the socket dies.
  await new Promise(() => undefined);
  return 0;
}

/** Route a command. */
async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) usage();
  const command = argv[0]!;
  if (command === "-h" || command === "--help" || command === "help") usage();
  const { options, positional } = parseArgv(argv.slice(1));
  switch (command) {
    case "submit":
      return cmdSubmit(options, positional);
    case "batch":
      return cmdBatch(options, positional);
    case "nodes":
      return cmdNodes(options);
    case "result":
      return cmdResult(options, positional);
    case "status":
      return cmdStatus(options);
    case "follow":
      return cmdFollow(options, positional);
    case "watch":
      return cmdWatch(options);
    default:
      fail(`unknown command: ${command}`);
  }
}

const [command] = process.argv.slice(2);
void main(process.argv.slice(2))
  .then((code) => {
    if (command !== "watch") process.exit(code);
  })
  .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err), 1));
