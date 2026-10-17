import { loadConfig } from "../config.js";
import { captureScreen } from "../screen/capture.js";
import { OllamaClient } from "../ollama.js";
import path from "node:path";

/** Verifies: screen capture (JPEG) + Ollama vision input works with a chosen vision model. */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const visionModel = process.argv[2] ?? "qwen3-vl:235b-cloud";
  const ollama = new OllamaClient(cfg.ollamaUrl);

  console.log("capturing screen ...");
  const frame = await captureScreen({
    dir: path.join(cfg.workspace, ".screenshots"),
    format: "jpg",
    quality: 60,
    maxWidth: 1280,
    name: `vision_${Date.now()}`,
  });
  console.log(`frame: ${frame.width}x${frame.height}, ${frame.bytes} bytes -> ${frame.path}`);

  console.log(`asking ${visionModel} ...`);
  const res = await ollama.chat({
    model: visionModel,
    messages: [
      { role: "system", content: "You describe screenshots precisely and briefly." },
      {
        role: "user",
        content: "What is on this screen? Name the main window, any visible app names, and one detail.",
        images: [frame.base64],
      },
    ],
    temperature: 0.1,
    timeoutMs: 180_000,
  });
  console.log("---- vision answer ----");
  console.log(res.content.trim().slice(0, 700) || "(empty)");
}

void main().catch((err) => {
  console.error(`vision check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
