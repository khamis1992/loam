import http from "node:http";

export interface StubServer {
  url: string;
  close: () => Promise<void>;
}

export function listen(handler: http.RequestListener): Promise<StubServer> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export function ollamaTagsStub(): Promise<StubServer> {
  return listen((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen-test:latest" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

export function failingModelsStub(): Promise<StubServer> {
  return listen((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  });
}

export function openaiToolStub(): Promise<StubServer> {
  return listen((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\":\"a\"}" } }] } }] })}\n\ndata: [DONE]\n`);
  });
}

export function anthropicToolStub(expectedKey: string): Promise<StubServer> {
  return listen((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.headers["x-api-key"] !== expectedKey || body.includes(expectedKey)) {
        res.writeHead(400);
        res.end("rejected");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "lookup" } })}\n\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"q\":\"a\"}" } })}\n\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } })}\n\n`);
    });
  });
}

export function geminiToolStub(): Promise<StubServer> {
  return listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "a" } } }] }, finishReason: "STOP" }] })}\n`);
  });
}
