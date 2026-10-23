/**
 * `report_environment_issue`.
 *
 * Some steps cannot run because of the local environment (missing dependency,
 * no network, unavailable service, broken toolchain, permission error). Instead
 * of silently retrying or papering over it, the agent records the issue on the
 * session (via the `environment_issue` event, which the run loop persists as a
 * task step), surfaces a card to the user, and continues with guidance such as
 * relying on CI or skipping the local step with an explicit note.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

export const REPORT_ENVIRONMENT_ISSUE_TOOL = "report_environment_issue";

const MESSAGE_MAX = 2000;
const DETAILS_MAX = 4000;

const GUIDANCE = [
  "Environment issue recorded on this session and shown to the user.",
  "",
  "Continue without trying to repair the environment: rely on CI for the affected step, skip the local step with an explicit note, or ask the user to fix the environment before retrying. Do not report the step as passed.",
].join("\n");

function reportEnvironmentIssueTool(): Tool {
  return {
    name: REPORT_ENVIRONMENT_ISSUE_TOOL,
    description:
      "Report that a step cannot run because of the local environment (missing dependency, no network, unavailable service, broken toolchain, permission error). Records the issue on this session, surfaces a card to the user, and returns guidance to continue without repairing the environment (rely on CI, skip the step with an explicit note, or ask the user to fix it).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: { type: "string", minLength: 1, maxLength: MESSAGE_MAX, description: "Short description of the environment problem (1..2000 chars)." },
        details: { type: "string", maxLength: DETAILS_MAX, description: "Optional extra context: the failing command, error text, or affected step (0..4000 chars)." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const message = str(args, "message").trim();
      if (message.length === 0) return { ok: false, content: "report_environment_issue requires a non-empty message" };
      if (message.length > MESSAGE_MAX) return { ok: false, content: `message must be at most ${MESSAGE_MAX} characters` };
      const details = str(args, "details").trim();
      if (details.length > DETAILS_MAX) return { ok: false, content: `details must be at most ${DETAILS_MAX} characters` };

      ctx.emit({
        type: "environment_issue",
        message,
        ...(details.length > 0 ? { details } : {}),
      });
      return { ok: true, content: `${GUIDANCE}\n\nIssue: ${message}${details ? `\nDetails: ${details}` : ""}` };
    },
  };
}

/** Build the `report_environment_issue` tool. */
export function createEnvironmentIssueTools(): Tool[] {
  return [reportEnvironmentIssueTool()];
}
