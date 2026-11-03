import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { Tool, ToolResult } from "./registry.js";
import { str } from "./registry.js";
import { createOfficeModelGateway } from "../office/intelligence/modelGateway.js";
import { runOfficeWorkflow } from "../office/intelligence/workflows.js";

export function createOfficeWorkflowTools(cfg: Config, ollama: OllamaClient): Tool[] {
  return [{
    name: "office_workflow_run",
    description: "شغّل سير عمل Office مسجلًا بالمعرف: مزامنة تقرير شهري وتحليله، متابعة اجتماع، أو تحديث الروابط المعتمدة. لا ينشر أو يرسل محتوى خارجيًا.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "معرف سير العمل wf_..." } },
      required: ["id"],
    },
    async run(args): Promise<ToolResult> {
      try {
        const result = await runOfficeWorkflow(str(args, "id").trim(), { baseWorkspace: cfg.workspace, model: createOfficeModelGateway(cfg, ollama) });
        return { ok: true, content: JSON.stringify(result) };
      } catch (error) {
        return { ok: false, content: `فشل سير العمل: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  }];
}
