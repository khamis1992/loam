import { loadConfig } from "../config.js";
import { OllamaClient } from "../ollama.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ollama = new OllamaClient(cfg.ollamaUrl);

  console.log(`ollama: ${cfg.ollamaUrl}`);
  const models = await ollama.listModels();
  console.log(`models (${models.length}):`);
  for (const m of models) console.log(`  - ${m}`);

  console.log(`\ntesting tool-calling with model="${cfg.model}" ...`);
  try {
    const res = await ollama.chat({
      model: cfg.model,
      messages: [
        { role: "system", content: "You are a helpful agent. Use tools when appropriate." },
        { role: "user", content: "List the files in the workspace." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "file_list",
            description: "List files in a directory",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      temperature: 0,
      timeoutMs: 120_000,
    });
    console.log("tool_calls:", JSON.stringify(res.toolCalls));
    console.log("text:", res.content.slice(0, 200));
    console.log(res.toolCalls.length > 0 ? "OK: model supports tool calling" : "WARN: no tool_calls returned (model may lack tool support)");
  } catch (err) {
    console.error("chat failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
