import type { Config } from "../config.js";
import { runBridge } from "../bridges/exec.js";
import { formatEnvelope } from "../bridges/envelope.js";
import { getManifest, isBridgeEnabled, listBridges, loadManifests } from "../bridges/registry.js";
import type { BridgeEffect } from "../bridges/types.js";
import { assertNoSecret } from "../memory/redact.js";
import type { WriteGate } from "../server/pending.js";
import { gateActive } from "../server/settings.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

/** Effects that change what the program does beyond writing a workspace file. */
const NEEDS_APPROVAL: ReadonlySet<BridgeEffect> = new Set(["exec_script", "external"]);

const UI_HINT =
  "No bridge covers this. As a fallback, drive the window with computer_ui_tree / computer_ui_list to find the control, " +
  "then computer_ui_click or computer_ui_set_text. Those steps are never started for you.";

function asArgs(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Run a staged `app_run` after the user approved it. */
export async function applyAppRun(cfg: Config, payload: Record<string, unknown>): Promise<string> {
  const workspace = typeof payload["workspace"] === "string" && payload["workspace"] ? payload["workspace"] : cfg.workspace;
  const env = await runBridge(
    { cfg, workspace },
    String(payload["app"] ?? ""),
    String(payload["command"] ?? ""),
    asArgs(payload["args"]),
  );
  if (!env.ok) throw new Error(formatEnvelope(env));
  return `app_run ${String(payload["app"])}.${String(payload["command"])}`;
}

export function createAppBridgeTools(opts: { gate?: WriteGate } = {}): Tool[] {
  const { gate } = opts;
  return [
    {
      name: "app_list",
      description:
        "List the desktop apps this machine can drive through command-line bridges (FFmpeg, LibreOffice, Inkscape, Blender, Obsidian), with each one's status: ready, disabled (turned off in Settings › App bridges), missing (not installed) or error. Prefer a ready bridge over clicking through the app's window.",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const infos = await listBridges(ctx.cfg);
        const lines = infos.map((b) => {
          const cmds = b.commands.map((c) => c.id).join(", ");
          return `- ${b.id} [${b.status}] ${b.name}: ${b.description} (commands: ${cmds})`;
        });
        return { ok: true, content: `${lines.join("\n")}\n\nIf none fits: ${UI_HINT}` };
      },
    },
    {
      name: "app_describe",
      description: "Show one app bridge's commands, parameters and side effects, so app_run can be called with the right arguments.",
      parameters: { type: "object", properties: { app: { type: "string", description: "Bridge id from app_list." } }, required: ["app"] },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const m = getManifest(str(args, "app"));
        if (!m) return { ok: false, content: `unknown app. Known: ${loadManifests().map((x) => x.id).join(", ")}. ${UI_HINT}` };
        const out = m.commands.map((c) => {
          const ps = Object.entries(c.params)
            .map(([n, p]) => `    ${n}: ${p.type}${p.required ? " (required)" : ""}${p.values ? ` one of ${p.values.join("|")}` : ""}${p.description ? ` — ${p.description}` : ""}`)
            .join("\n");
          return `${c.id} [${c.effect}] ${c.description}\n${ps}`;
        });
        return { ok: true, content: `${m.name}\n${out.join("\n\n")}` };
      },
    },
    {
      name: "app_run",
      description:
        "Run one command of an enabled app bridge, e.g. convert a video with FFmpeg or a document with LibreOffice. Arguments are validated and passed as an argument list, never a shell line; output files must stay inside the workspace. Commands that run scripts or open the app's window wait for user approval. Call app_describe first for the parameters.",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "Bridge id." },
          command: { type: "string", description: "Command id from app_describe." },
          args: { type: "object", description: "Parameter values keyed by name.", additionalProperties: true },
        },
        required: ["app", "command"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const app = str(args, "app");
        const command = str(args, "command");
        const m = getManifest(app);
        if (!m) return { ok: false, content: `unknown app ${app}. ${UI_HINT}` };
        if (!isBridgeEnabled(ctx.cfg, m.id)) {
          return { ok: false, content: `bridge ${m.id} is disabled. Ask the user to enable it in Settings › App bridges. ${UI_HINT}` };
        }
        const cmd = m.commands.find((c) => c.id === command);
        if (!cmd) return { ok: false, content: `${m.id} has no command ${command}` };
        const callArgs = asArgs(args["args"]);

        if (NEEDS_APPROVAL.has(cmd.effect) && gate && gateActive()) {
          try {
            assertNoSecret(JSON.stringify(callArgs));
          } catch {
            return { ok: false, content: "arguments look like they contain a secret; refusing to stage them" };
          }
          const summary = `app_run ${m.id}.${cmd.id} (${cmd.effect})`;
          const item = gate.stage("app_run", summary, { app: m.id, command: cmd.id, args: callArgs, workspace: ctx.workspace });
          return {
            ok: true,
            content: `staged for approval (id=${item.id}): ${summary}. It has NOT run — approve it at /learning.html or POST /api/pending/${item.id}/approve`,
          };
        }
        const env = await runBridge(ctx, m.id, cmd.id, callArgs);
        return { ok: env.ok, content: formatEnvelope(env) };
      },
    },
  ];
}
