/**
 * Nuclei template generation from natural language (Supremacy M5.1): describe a
 * vulnerability and the local model drafts a working nuclei YAML template.
 */
import type { OllamaClient } from "../../../ollama.js";

export interface GeneratedTemplate {
  yaml: string;
  validated: boolean;
  error?: string;
}

const TEMPLATE_PROMPT = (description: string) => `You are a nuclei template generator. Given a vulnerability description, output ONLY a valid nuclei YAML template (no markdown fences, no explanation). The template must use the http protocol, include at least one matcher, and set an appropriate severity (info/low/medium/high/critical).

Vulnerability description: ${description}

Output the YAML template:`;

/** Generate a nuclei template from a natural-language description. */
export async function generateNucleiTemplate(
  description: string,
  model: { chat: OllamaClient["chat"] },
): Promise<GeneratedTemplate> {
  if (!description.trim()) return { yaml: "", validated: false, error: "description required" };
  const result = await model.chat({
    model: "loam",
    messages: [{ role: "user", content: TEMPLATE_PROMPT(description) }],
    temperature: 0.1,
    timeoutMs: 60_000,
  });
  let yaml = result.content.trim();
  // Strip markdown fences if present.
  yaml = yaml.replace(/^```(?:yaml)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  if (!yaml.startsWith("id:")) return { yaml, validated: false, error: "output does not look like a nuclei template" };
  return { yaml, validated: true };
}

/**
 * Save the generated template to a directory and return the file path.
 * The caller validates with `nuclei -t <path> -validate`.
 */
export function saveGeneratedTemplate(yaml: string, outDir: string, name: string): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  fs.mkdirSync(outDir, { recursive: true });
  const safe = name.replace(/[^\w-]/g, "-").slice(0, 60) || `gen-${Date.now()}`;
  const filePath = path.join(outDir, `${safe}.yaml`);
  fs.writeFileSync(filePath, yaml, "utf8");
  return filePath;
}
