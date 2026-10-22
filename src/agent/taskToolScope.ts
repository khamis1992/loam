import type { ChatMessage } from "../ollama.js";
import type { ToolRegistry } from "../tools/registry.js";

const FILE_TOOLS = ["file_read", "file_write", "file_edit", "file_stat", "file_list", "file_search", "grep", "glob", "file_mkdir", "file_view_image"];
/** Deliberately narrow language support: explicit standalone user commands,
 * never instructions discovered in tool output, assistant history or plans.
 * This is not a general natural-language permission classifier. */
export function fileOnlyRequested(prompt: string, history: ChatMessage[] = []): boolean {
  let restricted = false;
  for (const text of [...history.filter(m => m.role === "user").map(m => m.content), prompt]) {
    const normalized = text.normalize("NFKC").replace(/[\u064B-\u065F\u0670]/g, "");
    for (const sentence of normalized.split(/[\n.!?؟]+/)) {
      const s = sentence.trim();
      if (/^(?:(?:استخدم|استعمل) أدوات الملفات فقط|use (?:only file tools|file tools only))(?:\s|[،,:;]|$)/i.test(s)) restricted = true;
      else if (/^(?:ألغ قيد أدوات الملفات فقط|الغ قيد أدوات الملفات فقط|remove the file-tools-only restriction)(?:\s|[،,:;]|$)/i.test(s)) restricted = false;
    }
  }
  return restricted;
}
export function taskScopedTools(tools: ToolRegistry, prompt: string, history?: ChatMessage[], forceFileOnly = false): ToolRegistry {
  return forceFileOnly || fileOnlyRequested(prompt, history) ? tools.forAllowlist(FILE_TOOLS) : tools;
}
