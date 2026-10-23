// Adapted from jcode (MIT) ref/fake_model.py
//
// Scripted OpenAI-compatible fake model used by the J2 memory benchmark. It
// answers /v1/chat/completions with a deterministic read -> edit -> bash test ->
// final tool-call sequence (configurable), streaming SSE or a single JSON body.
// Ports default to 11435 so the harness never clashes with a real Ollama on 11434.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface ScriptedToolCall {
  /** Tool name handed back in the assistant tool call. */
  name: string;
  /** Arguments handed back as the JSON-encoded function arguments. */
  arguments?: Record<string, unknown>;
}

export interface ScriptedTurn {
  /** When set the turn emits a tool call. */
  tool?: ScriptedToolCall;
  /** When set (and no tool) the turn emits plain assistant content. */
  text?: string;
  /** Extra content emitted before the tool call (still a tool-carrying turn). */
  prefixText?: string;
  /** Deliberately skip finish_reason (bad-server behaviour for tests). */
  omitFinishReason?: boolean;
}

export interface FakeModelOptions {
  /** Bind address. Defaults to 127.0.0.1. */
  host?: string;
  /** Bind port; 0 picks a free port. Defaults to 11435. */
  port?: number;
  /** Model id echoed in responses. Defaults to "mock-coder". */
  model?: string;
  /** Turns replayed in order, one per request. The last turn repeats. */
  sequence?: ScriptedTurn[];
  /** Default model id for /v1/models and /api/tags. */
  modelId?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** The default read -> edit -> bash test -> final sequence (calc.py add() bug). */
export function defaultSequence(): ScriptedTurn[] {
  return [
    { tool: { name: "read", arguments: { file_path: "calc.py" } } },
    {
      tool: {
        name: "edit",
        arguments: { file_path: "calc.py", old_string: "return a - b", new_string: "return a + b" },
      },
    },
    { tool: { name: "bash", arguments: { command: "python3 test_calc.py", description: "run tests" } } },
    { text: "Fixed add(): it subtracted instead of adding. Tests pass." },
  ];
}

function chunkBody(model: string, delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  };
}

export class FakeModelServer {
  readonly requests: RecordedRequest[] = [];
  private readonly server: Server;
  readonly host: string;
  readonly requestedPort: number;
  private readonly sequence: ScriptedTurn[];
  private readonly model: string;
  private readonly modelId: string;
  private _port = 0;

  constructor(options: FakeModelOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 11435;
    this.model = options.model ?? "mock-coder";
    this.modelId = options.modelId ?? this.model;
    this.sequence = options.sequence ?? defaultSequence();
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this._port}`;
  }

  async start(): Promise<void> {
    if (this._port > 0) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        this._port = typeof address === "object" && address ? address.port : this.requestedPort;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this._port === 0) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    this._port = 0;
  }

  /** Resolve the turn for a 0-based step; the last turn repeats. */
  turnFor(step: number): ScriptedTurn {
    if (this.sequence.length === 0) return { text: "no sequence configured" };
    const index = Math.min(Math.max(0, step), this.sequence.length - 1);
    return this.sequence[index]!;
  }

  private record(method: string, path: string, req: IncomingMessage, body: unknown): void {
    this.requests.push({ method, path, body, headers: req.headers });
  }

  /** Parse a chat request into the messages the script counts tool results from. */
  private countToolMessages(body: unknown): number {
    return countToolMessages(body);
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const raw = await readRequestBody(req);
    const text = raw.toString("utf8").trim();
    if (text.length === 0) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const body = await this.readBody(req);
    this.record(req.method ?? "GET", path, req, body);

    if (path === "/v1/models" || path === "/models") return sendJson(res, 200, modelListBody(this.modelId));
    if (path === "/api/tags") return sendJson(res, 200, ollamaTagsBody(this.modelId));
    if (path === "/api/version") return sendJson(res, 200, { version: "0.0.0-mock" });
    if (path === "/v1/chat/completions" || path === "/chat/completions" || path === "/api/chat") {
      const requested = (body as { stream?: unknown }).stream;
      const wantsStream = requested === true || req.headers.accept === "text/event-stream";
      if (wantsStream) return sendStream(res, this.buildChunks(body));
      return sendJson(res, 200, this.buildNonStream(body));
    }
    return sendJson(res, 404, { error: { message: `mock model: unknown path ${path}` } });
  }

  /**
   * Resolve the turn for a request. The step index is the number of tool
   * messages already in the transcript, so the last turn repeats. A request
   * with no tool message at all is step 0 (the Python original's `n==0` branch
   * was an off-by-one that skipped the first turn).
   */
  private turnForBody(body: unknown): ScriptedTurn {
    return this.turnFor(this.countToolMessages(body));
  }

  private buildChunks(body: unknown): Array<Record<string, unknown>> {
    const turn = this.turnForBody(body);
    const chunks: Array<Record<string, unknown>> = [];
    const requestId = `chatcmpl-${randomUUID().slice(0, 8)}`;
    const base = (delta: Record<string, unknown>, finishReason?: string): Record<string, unknown> => ({
      id: requestId,
      object: "chat.completion.chunk",
      created: 0,
      model: this.model,
      choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    });
    if (turn.tool) {
      if (turn.prefixText) chunks.push(base({ role: "assistant", content: turn.prefixText }));
      chunks.push(
        base({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments ?? {}) },
            },
          ],
        }),
      );
      if (!turn.omitFinishReason) chunks.push(base({}, "tool_calls"));
    } else {
      chunks.push(base({ role: "assistant", content: turn.text ?? "" }));
      if (!turn.omitFinishReason) chunks.push(base({}, "stop"));
    }
    return chunks;
  }

  private buildNonStream(body: unknown): Record<string, unknown> {
    const turn = this.turnForBody(body);
    const message: Record<string, unknown> = { role: "assistant" };
    if (turn.tool) {
      message.content = turn.prefixText ?? null;
      message.tool_calls = [
        {
          id: "call_mock_1",
          type: "function",
          function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments ?? {}) },
        },
      ];
    } else {
      message.content = turn.text ?? "";
    }
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: 0,
      model: this.model,
      choices: [
        { index: 0, message, finish_reason: turn.tool ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
  }
}

/** Count the `tool` role messages in a chat request (the script's step index). */
export function countToolMessages(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  return messages.filter(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      ((m as { role?: unknown }).role === "tool" ||
        typeof (m as { tool_call_id?: unknown }).tool_call_id === "string" ||
        typeof (m as { tool_name?: unknown }).tool_name === "string"),
  ).length;
}

export function modelListBody(modelId: string): Record<string, unknown> {
  return { object: "list", data: [{ id: modelId, object: "model", owned_by: "mock" }] };
}

export function ollamaTagsBody(modelId: string): Record<string, unknown> {
  return { models: [{ name: modelId, model: modelId, modified_at: new Date(0).toISOString(), size: 0, digest: "mock" }] };
}

/** Serialize chunks as an OpenAI-compatible SSE body plus the trailing [DONE]. */
export function formatSse(chunks: Array<Record<string, unknown>>): string {
  let out = "";
  for (const chunk of chunks) out += `data: ${JSON.stringify(chunk)}\n\n`;
  return `${out}data: [DONE]\n\n`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendStream(res: ServerResponse, chunks: Array<Record<string, unknown>>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(formatSse(chunks));
  res.end();
}

export function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** Spin up a fake model server for the duration of `fn`. */
export async function withFakeModel<T>(
  fn: (server: FakeModelServer) => Promise<T>,
  options: FakeModelOptions = {},
): Promise<T> {
  const server = new FakeModelServer(options);
  await server.start();
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}
