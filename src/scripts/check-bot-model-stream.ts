import assert from "node:assert/strict";
import http from "node:http";
import { OllamaClient, IncompleteModelStream } from "../ollama.js";

let chunks: string[] = [];
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain actual request */ }
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const chunk of chunks) {
    res.write(chunk);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  res.end();
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const client = new OllamaClient(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`);
const call = () => client.chat({ model: "fixture", messages: [{ role: "user", content: "test" }], timeoutMs: 5000 });
const terminal = JSON.stringify({ done: true, prompt_eval_count: 2, eval_count: 3 });
try {
  chunks = ['{"message":{"content":"تم"}}\n', terminal.slice(0, 9), terminal.slice(9)];
  const valid = await call();
  assert.equal(valid.content, "تم");
  assert.equal(valid.usage.completionTokens, 3);
  chunks = ['{"message":{"content":"{\\"verdict\\":\\"pass\\"}"}}\n'];
  await assert.rejects(call(), e => e instanceof IncompleteModelStream);
  chunks = [];
  await assert.rejects(call(), /ended before completion/);
  chunks = ['{"done":true'];
  await assert.rejects(call(), /malformed JSON/);
  chunks = ['broken\n', terminal + '\n'];
  await assert.rejects(call(), /malformed JSON/);
  chunks = ['null\n', terminal + '\n'];
  await assert.rejects(call(), /invalid chunk/);
  chunks = [terminal + '\n', '{"message":{"content":"late"}}\n'];
  await assert.rejects(call(), /after completion/);
  chunks = ['{"error":"provider unavailable"}\n'];
  await assert.rejects(call(), /provider unavailable/);
  chunks = [terminal + '\n\n'];
  await call();
  console.log("PASS actual HTTP stream: fragmented terminal without newline accepted; truncated, empty, malformed, late and provider-error replies rejected");
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
