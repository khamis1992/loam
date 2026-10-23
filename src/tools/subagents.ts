import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { runAgent } from "../agent/loop.js";
import { listAgents } from "../server/agents.js";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { num, str } from "./registry.js";
import { registry as subagentRegistry } from "../subagent/index.js";
import type { SubagentRunHandle, SubagentStartOptions } from "../subagent/index.js";
import { createInProcessProvider } from "../subagent/inProcessProvider.js";
import { createAcpProvider } from "../subagent/acpProvider.js";
import { runLifecycleHooks } from "../policy/hooks.js";

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
      "You are the Explore subagent (read-only). Use code_symbols, code_outline, grep, glob, file_search, file_list, and file_read to answer the question concisely with exact file paths and line numbers. Never attempt to modify files.",
    allowTools: ["code_symbols", "code_outline", "grep", "glob", "file_read", "file_list", "file_search", "file_stat", "file_extract_text"],
    maxSteps: 10,
    source: "builtin",
  },
  {
    name: "reviewer",
    description: "Code quality, bug, and security reviewer. Inspects files and diffs and reports concrete issues.",
    instructions:
      "You are the Reviewer subagent. Inspect the relevant code and return a concise, prioritized list of bugs, edge cases, type/lint issues, or security risks with exact file:line references.",
    allowTools: ["code_symbols", "code_outline", "grep", "glob", "file_read", "file_list", "file_search", "file_stat", "shell_run"],
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

/** Split an inline list (`a, b`, `a b` or `[a, b]`) into trimmed tokens. */
function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

interface AgentFrontmatter {
  meta: Record<string, string | string[]>;
  body: string;
}

/** Parse YAML-style frontmatter, accepting both inline (`key: a, b`) and
 *  block (`key:` followed by `- item`) list values. */
function parseFrontmatter(raw: string): AgentFrontmatter {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string | string[]> = {};
  let current: string | null = null;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && current) {
      const value = item[1]!.trim().replace(/^["']|["']$/g, "");
      if (value) {
        const prev = meta[current];
        if (Array.isArray(prev)) prev.push(value);
        else meta[current] = [value];
      }
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv?.[1]) {
      current = kv[1].trim();
      meta[current] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: m[2] ?? "" };
}

function frontmatterString(meta: Record<string, string | string[]>, key: string): string | undefined {
  const value = meta[key];
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : undefined;
  return value && value.trim() ? value.trim() : undefined;
}

function frontmatterList(meta: Record<string, string | string[]>, key: string): string[] | undefined {
  const value = meta[key];
  if (Array.isArray(value)) {
    const items = value.map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return parseList(value);
}

function parseAgentMarkdown(file: string): SubagentProfile | null {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const { meta, body } = parseFrontmatter(raw);
    const name = (frontmatterString(meta, "name") || path.basename(file, ".md")).trim();
    if (!name) return null;
    const maxStepsRaw = frontmatterString(meta, "maxSteps") ?? frontmatterString(meta, "maxTurns");
    const maxSteps = maxStepsRaw ? Number(maxStepsRaw) : undefined;
    const model = frontmatterString(meta, "model");
    return {
      name,
      description: frontmatterString(meta, "description") || "Custom markdown subagent.",
      instructions: body.trim(),
      allowTools: frontmatterList(meta, "tools"),
      denyTools: frontmatterList(meta, "disallowedTools") ?? frontmatterList(meta, "denyTools"),
      ...(model ? { model } : {}),
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
    // Repo-defined custom subagents (Loam's own convention; wins over the
    // generic directories above because it is applied last).
    path.join(workspace, ".loam", "agents"),
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

/** Resolve a profile by name (case-insensitive) from every discovered source. */
export function findSubagentProfile(workspace: string, name: string): SubagentProfile | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return discoverSubagents(workspace).find((p) => p.name.toLowerCase() === needle);
}

/** The toolset a subagent may use: its allowlist (or everything), minus the
 *  profile's denylist and the delegation tools. A subagent is a leaf worker, so
 *  it can never spawn another subagent or escalate its own capabilities. */
export function buildSubagentToolRegistry(parent: ToolRegistry, profile: SubagentProfile): ToolRegistry {
  const deny = new Set([...(profile.denyTools ?? []), "delegate_subagent", "delegate_task"]);
  return parent.cloneFiltered({ allow: profile.allowTools, deny: [...deny] });
}

interface ProfileSubagentOptions {
  profile: SubagentProfile;
  taskPrompt: string;
  ctx: ToolContext;
  ollama: OllamaClient;
  parentRegistry: ToolRegistry;
  /** Optional step-budget override; clamped to 1..30 with the profile default. */
  maxSteps?: number;
  /** Delegation depth for the child's own tool context (prevents recursion). */
  depth?: number;
}

/** Run a repo-defined profile in an isolated in-process context and return only
 *  its final report (no intermediate events reach the parent). */
async function runProfileSubagent(opts: ProfileSubagentOptions): Promise<ToolResult> {
  const { profile, taskPrompt, ctx, ollama, parentRegistry } = opts;
  const subRegistry = buildSubagentToolRegistry(parentRegistry, profile);
  const maxSteps = Math.min(Math.max(opts.maxSteps ?? profile.maxSteps ?? 12, 1), 30);
  const effectiveCfg = profile.model && profile.model !== "inherit" ? { ...ctx.cfg, model: profile.model } : ctx.cfg;

  const subStart = await runLifecycleHooks("SubagentStart", "", { subagent: profile.name, task: taskPrompt }, ctx.workspace);
  if (subStart.blocked) {
    return { ok: false, content: `SubagentStart hook blocked subagent "${profile.name}": ${subStart.message}` };
  }
  const systemSuffix = [subStart.additionalContext, `[Subagent: ${profile.name}]`, profile.instructions]
    .filter((s) => s.trim().length > 0)
    .join("\n");

  let toolCalls = 0;
  let stopFired = false;
  let stopContext = "";
  try {
    const res = await runAgent({
      cfg: effectiveCfg,
      ollama,
      tools: subRegistry,
      emit: (ev) => {
        if (ev.type === "tool_call") toolCalls += 1;
      },
      prompt: taskPrompt,
      systemSuffix,
      maxSteps,
      signal: ctx.signal,
      taskId: ctx.taskId,
      suppressFinal: true,
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    });
    const subStop = await runLifecycleHooks("SubagentStop", "", { subagent: profile.name, steps: res.steps, stopReason: "completed" }, ctx.workspace);
    stopFired = true;
    stopContext = subStop.additionalContext;
    return {
      ok: true,
      content: `[Subagent "${profile.name}" finished in ${res.steps} step(s), ${toolCalls} tool call(s)]\n\n${res.text}${stopContext ? `\n\n${stopContext}` : ""}`,
    };
  } finally {
    if (!stopFired) {
      await runLifecycleHooks("SubagentStop", "", { subagent: profile.name, stopReason: "failed" }, ctx.workspace);
    }
  }
}

export function createSubagentTools(ollama: OllamaClient, parentRegistry: ToolRegistry): Tool[] {
  /** Register the built-in providers once so delegate_task can start them by name. */
  function ensureDefaultProviders(): void {
    if (!subagentRegistry.has("in-process")) subagentRegistry.register("in-process", createInProcessProvider());
    if (!subagentRegistry.has("acp")) subagentRegistry.register("acp", createAcpProvider());
  }

  return [
    {
      name: "subagent_list",
      description:
        "List available specialized subagents (built-in, agents/*.md, .claude/agents/*.md, .loam/agents/*.md, and custom agents) that can be invoked via delegate_subagent or delegate_task.",
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

        return runProfileSubagent({
          profile,
          taskPrompt,
          ctx,
          ollama,
          parentRegistry,
          maxSteps: num(args, "maxSteps", profile.maxSteps ?? 12),
        });
      },
    },
    {
      name: "delegate_task",
      description:
        "Delegate a self-contained task to a subagent and get back only its final report. Pass subagent_type to run a repo-defined agent loaded from .loam/agents/*.md (also agents/*.md and .claude/agents/*.md); the agent runs in-process with its own tool allowlist and model. Or omit subagent_type and pass provider (in-process|acp) plus cwd to run an external or in-process child, providing acpCommand and optional acpArgs for the ACP provider. The child runs with its own context in a cwd that must be inside the workspace, so put everything it needs in the prompt. Delegation depth is limited (default 2) and concurrent children are capped (default 4). Use it for parallel, isolated work such as exploration or independent edits. When NOT to use: do the work directly when it needs your conversation context, use file_*/shell_* for simple steps, and remember the child cannot see the parent's history; never delegate work that requires an approval gate or a secret.",
      parameters: {
        type: "object",
        properties: {
          subagent_type: {
            type: "string",
            description:
              "Repo-defined subagent name (from .loam/agents/*.md or agents/*.md). Runs in-process with the agent's tool allowlist and model; only its final report is returned. Takes precedence over provider.",
          },
          provider: { type: "string", enum: ["in-process", "acp"], description: "Provider to use when subagent_type is omitted." },
          prompt: { type: "string", description: "Complete, self-contained task prompt for the subagent." },
          cwd: { type: "string", description: "Working directory (required for provider mode; must be within workspace)." },
          model: { type: "string", description: "Model override for the in-process provider." },
          timeoutMs: { type: "number", description: "Timeout in ms (default 120000)." },
          acpCommand: { type: "string", description: "Command for ACP provider (e.g. 'node', 'npx')." },
          acpArgs: { type: "array", items: { type: "string" }, description: "Args for ACP command." },
          permissionPolicy: { type: "string", enum: ["allow", "reject"], description: "ACP permission policy (default reject)." },
          maxSteps: { type: "number", description: "Max tool steps for a subagent_type run (default from the profile or 12)." },
        },
        required: ["prompt"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const prompt = str(args, "prompt").trim();
        if (!prompt) return { ok: false, content: "delegate_task requires prompt" };

        const subagentCfg = ctx.cfg.subagent ?? { maxDepth: 2, maxConcurrentChildren: 4 };
        const depth = ctx.depth ?? 0;

        // Repo-defined agent path: resolve the profile and run it in-process.
        const subagentType = str(args, "subagent_type").trim();
        if (subagentType) {
          if (depth >= subagentCfg.maxDepth) {
            return {
              ok: false,
              content: `delegate_task blocked: subagent depth limit ${subagentCfg.maxDepth} reached (current depth ${depth})`,
            };
          }
          const profile = findSubagentProfile(ctx.workspace, subagentType);
          if (!profile) {
            const available = discoverSubagents(ctx.workspace).map((p) => p.name).join(", ");
            return { ok: false, content: `unknown subagent_type "${subagentType}". Available: ${available}` };
          }
          return runProfileSubagent({
            profile,
            taskPrompt: prompt,
            ctx,
            ollama,
            parentRegistry,
            maxSteps: num(args, "maxSteps", profile.maxSteps ?? 12),
            depth: depth + 1,
          });
        }

        const provider = str(args, "provider") as "in-process" | "acp";
        const cwd = str(args, "cwd");
        const model = str(args, "model") || undefined;
        const timeoutMs =
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined;
        const acpCommand = str(args, "acpCommand") || undefined;
        const acpArgs = args.acpArgs as string[] | undefined;
        const permissionPolicy = (str(args, "permissionPolicy") as "allow" | "reject") || "reject";

        if (!provider || !cwd) return { ok: false, content: "delegate_task requires provider and cwd (or subagent_type)" };

        const workspaceRoot = path.resolve(ctx.workspace);
        const targetCwd = path.resolve(cwd);
        const withinWorkspace = targetCwd === workspaceRoot || targetCwd.startsWith(workspaceRoot + path.sep);
        if (!withinWorkspace) {
          return { ok: false, content: "cwd must be within workspace" };
        }

        if (depth >= subagentCfg.maxDepth) {
          return {
            ok: false,
            content: `delegate_task blocked: subagent depth limit ${subagentCfg.maxDepth} reached (current depth ${depth})`,
          };
        }

        const startOpts: SubagentStartOptions = {
          provider,
          prompt,
          cwd: targetCwd,
          model,
          timeoutMs,
          permissionPolicy,
          command: acpCommand,
          args: acpArgs,
          depth: depth + 1,
          cfg: ctx.cfg,
          ollama,
          tools: parentRegistry,
          signal: ctx.signal,
        };

        if (provider === "acp" && !acpCommand) {
          return { ok: false, content: "ACP provider requires acpCommand" };
        }

        const subStart = await runLifecycleHooks("SubagentStart", "", { subagent: provider, task: prompt }, ctx.workspace);
        if (subStart.blocked) {
          return { ok: false, content: `SubagentStart hook blocked subagent "${provider}": ${subStart.message}` };
        }

        ensureDefaultProviders();
        subagentRegistry.setMaxConcurrentChildren(subagentCfg.maxConcurrentChildren);
        const release = await subagentRegistry.acquireChild();

        let handle: SubagentRunHandle;
        try {
          handle = await subagentRegistry.start(startOpts);
        } catch (e) {
          release();
          await runLifecycleHooks("SubagentStop", "", { subagent: provider, stopReason: "failed", error: String(e) }, ctx.workspace);
          return { ok: false, content: `Failed to start subagent: ${e instanceof Error ? e.message : String(e)}` };
        }

        let stopFired = false;
        try {
          // Drain the event stream so late notifications (and failures) surface
          // through result(); the provider's accumulated text is authoritative.
          for await (const _event of handle.events) {
            /* consumed for liveness */
          }
          const result = await handle.result();
          stopFired = true;
          const subStop = await runLifecycleHooks("SubagentStop", "", { subagent: provider, stopReason: result.stopReason }, ctx.workspace);
          const stopContext = subStop.additionalContext;
          if (result.stopReason === "completed") return { ok: true, content: stopContext ? `${result.text}\n\n${stopContext}` : result.text };
          return { ok: false, content: `[subagent ${result.stopReason}] ${result.text}`.trim() };
        } catch (e) {
          stopFired = true;
          await runLifecycleHooks("SubagentStop", "", { subagent: provider, stopReason: "failed", error: String(e) }, ctx.workspace);
          return { ok: false, content: `Subagent failed: ${e instanceof Error ? e.message : String(e)}` };
        } finally {
          if (!stopFired) {
            await runLifecycleHooks("SubagentStop", "", { subagent: provider, stopReason: "failed" }, ctx.workspace);
          }
          release();
        }
      },
    },
  ];
}
