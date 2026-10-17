import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { runAgent } from "../agent/loop.js";
import { listAgents } from "../server/agents.js";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { num, str } from "./registry.js";

export interface SubagentProfile {
  name: string;
  description: string;
  instructions: string;
  allowTools?: string[];
  denyTools?: string[];
  model?: string;
  maxSteps?: number;
  source: "builtin" | "file" | "custom";
}

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "explore",
    description: "Fast read-only codebase explorer. Use to search files, symbols, outlines, and architecture without polluting the main context.",
    instructions:
      "You are the Explore subagent (read-only). Use code_symbols, code_outline, file_search, file_list, and file_read to answer the question concisely with exact file paths and line numbers. Never attempt to modify files.",
    allowTools: ["code_symbols", "code_outline", "file_read", "file_list", "file_search", "file_stat", "file_extract_text"],
    maxSteps: 10,
    source: "builtin",
  },
  {
    name: "reviewer",
    description: "Code quality, bug, and security reviewer. Inspects files and diffs and reports concrete issues.",
    instructions:
      "You are the Reviewer subagent. Inspect the relevant code and return a concise, prioritized list of bugs, edge cases, type/lint issues, or security risks with exact file:line references.",
    allowTools: ["code_symbols", "code_outline", "file_read", "file_list", "file_search", "file_stat", "shell_run"],
    maxSteps: 10,
    source: "builtin",
  },
  {
    name: "coder",
    description: "Focused implementation subagent for self-contained coding subtasks with verification.",
    instructions:
      "You are the Coder subagent. Implement the requested change cleanly, run verification (typecheck/test) if applicable, and return a concise summary of modified files and verification output.",
    denyTools: ["delegate_subagent"],
    maxSteps: 16,
    source: "builtin",
  },
];

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseAgentMarkdown(file: string): SubagentProfile | null {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(raw);
    const meta: Record<string, string> = {};
    let body = raw;
    if (m) {
      body = m[2] ?? "";
      for (const line of (m[1] ?? "").split(/\r?\n/)) {
        const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line);
        if (kv?.[1] && kv[2]) {
          meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
        }
      }
    }
    const name = (meta.name || path.basename(file, ".md")).trim();
    if (!name) return null;
    const maxSteps = meta.maxSteps || meta.maxTurns ? Number(meta.maxSteps ?? meta.maxTurns) : undefined;
    return {
      name,
      description: meta.description || "Custom markdown subagent.",
      instructions: body.trim(),
      allowTools: parseList(meta.tools),
      denyTools: parseList(meta.disallowedTools),
      ...(meta.model ? { model: meta.model } : {}),
      ...(maxSteps && Number.isFinite(maxSteps) ? { maxSteps } : {}),
      source: "file",
    };
  } catch {
    return null;
  }
}

export function discoverSubagents(workspace: string): SubagentProfile[] {
  const byName = new Map<string, SubagentProfile>();
  for (const p of BUILTIN_PROFILES) byName.set(p.name.toLowerCase(), p);

  const dirs = [
    path.join(ROOT, "agents"),
    path.join(workspace, "agents"),
    path.join(workspace, ".manus", "agents"),
    path.join(workspace, ".claude", "agents"),
  ];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        const parsed = parseAgentMarkdown(path.join(dir, entry.name));
        if (parsed) byName.set(parsed.name.toLowerCase(), parsed);
      }
    } catch {
      /* ignore */
    }
  }

  for (const ag of listAgents()) {
    byName.set(ag.name.toLowerCase(), {
      name: ag.name,
      description: ag.description || "Custom agent from data/agents.json",
      instructions: ag.instructions,
      denyTools: ag.disabledTools,
      model: ag.model,
      source: "custom",
    });
  }

  return [...byName.values()];
}

export function createSubagentTools(ollama: OllamaClient, parentRegistry: ToolRegistry): Tool[] {
  return [
    {
      name: "subagent_list",
      description: "List available specialized subagents (built-in, agents/*.md, and custom agents) that can be invoked via delegate_subagent.",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const list = discoverSubagents(ctx.workspace);
        const lines = list.map((p) => {
          const scope = p.allowTools ? `allow=[${p.allowTools.join(",")}]` : p.denyTools?.length ? `deny=[${p.denyTools.join(",")}]` : "all-tools";
          return `- ${p.name} (${p.source}, ${scope}): ${p.description}`;
        });
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "delegate_subagent",
      description:
        "Delegate a self-contained subtask to an isolated specialized subagent (e.g. 'explore' for codebase research, 'reviewer' for code review, 'coder' for focused implementation, or any agent from agents/*.md). The subagent runs in its own context window and returns only its final report.",
      parameters: {
        type: "object",
        properties: {
          subagent: { type: "string", description: "Subagent name (e.g. explore, reviewer, coder)." },
          task: { type: "string", description: "Complete, self-contained instructions for the subagent." },
          maxSteps: { type: "number", description: "Max tool steps for the subagent (default from profile or 12)." },
        },
        required: ["subagent", "task"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const subName = str(args, "subagent").trim();
        const taskPrompt = str(args, "task").trim();
        if (!subName || !taskPrompt) return { ok: false, content: "delegate_subagent requires both subagent and task" };

        const profiles = discoverSubagents(ctx.workspace);
        const profile = profiles.find((p) => p.name.toLowerCase() === subName.toLowerCase());
        if (!profile) {
          return {
            ok: false,
            content: `unknown subagent "${subName}". Available: ${profiles.map((p) => p.name).join(", ")}`,
          };
        }

        const deny = new Set([...(profile.denyTools ?? []), "delegate_subagent"]);
        const subRegistry = parentRegistry.cloneFiltered({
          allow: profile.allowTools,
          deny: [...deny],
        });

        const maxSteps = Math.min(Math.max(num(args, "maxSteps", profile.maxSteps ?? 12), 1), 30);
        const effectiveCfg = profile.model && profile.model !== "inherit" ? { ...ctx.cfg, model: profile.model } : ctx.cfg;
        let toolCalls = 0;

        const res = await runAgent({
          cfg: effectiveCfg,
          ollama,
          tools: subRegistry,
          emit: (ev) => {
            if (ev.type === "tool_call") toolCalls += 1;
          },
          prompt: taskPrompt,
          systemSuffix: `[Subagent: ${profile.name}]\n${profile.instructions}`,
          maxSteps,
          signal: ctx.signal,
          taskId: ctx.taskId,
          suppressFinal: true,
        });

        return {
          ok: true,
          content: `[Subagent "${profile.name}" finished in ${res.steps} step(s), ${toolCalls} tool call(s)]\n\n${res.text}`,
        };
      },
    },
  ];
}
