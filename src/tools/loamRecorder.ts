// `loam_recorder` — screen recording for the media studio.
// The tool can inspect status and ask the user to consent. It cannot issue a
// consent token, and a refused start is not retried.
import { str, type Tool, type ToolContext, type ToolResult } from "./registry.js";
import { CONSENT_REQUIRED_AR, RecorderSession } from "../server/recorder/session.js";
import { getRecorderSession } from "../server/routes/recorder.js";
import { ROOT } from "../config.js";

const AGENT_METHODS = new Set([
  "status",
  "sources.list",
  "record.start",
  "record.pause",
  "record.resume",
  "record.stop",
  "record.cancel",
  "project.open",
  "project.inspect",
  "edit.apply",
  "captions.generate",
  "export",
  "handoff.video",
]);

export interface LoamRecorderToolOptions {
  session?: RecorderSession;
  root?: string;
}

function textResult(result: { ok: boolean; result?: unknown; error?: { code: string; message: string } }): ToolResult {
  if (!result.ok) {
    const message = result.error?.code === "CONSENT_REQUIRED" ? CONSENT_REQUIRED_AR : result.error?.message ?? "Loam Recorder refused the call.";
    return { ok: false, content: message };
  }
  return { ok: true, content: JSON.stringify(result.result) };
}

export function createLoamRecorderTools(options: LoamRecorderToolOptions = {}): Tool[] {
  const root = options.root ?? ROOT;
  const session = options.session ?? getRecorderSession(root);
  return [{
    name: "loam_recorder",
    description: "Record the screen with Loam Recorder. record.start needs a consent token from the user window. Do not retry a consent refusal. Screen titles stay private.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "status, record.start, record.stop, record.pause, record.resume, record.cancel, project.inspect, edit.apply, export, handoff.video, captions.generate" },
        params: { type: "object" },
      },
      required: ["method"],
    },
    async run(args, ctx: ToolContext): Promise<ToolResult> {
      const method = str(args, "method");
      if (!AGENT_METHODS.has(method)) {
        return { ok: false, content: `Rejected recorder channel: ${method}` };
      }
      const params = args.params && typeof args.params === "object" ? { ...args.params as Record<string, unknown> } : {};
      if (typeof ctx.workspace === "string" && ctx.workspace.trim()) params.workspace = ctx.workspace;
      else delete params.workspace;
      return textResult(await session.call(method, params));
    },
  }];
}
