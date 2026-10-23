/**
 * verify_and_record tool (D5): proof-of-work attached to a pull request.
 *
 * Flow:
 *  1. Derive a test plan (a list of user flows) from the PR diff.
 *  2. Run those flows with Playwright against the local static app, recording a
 *     video and screenshots per flow under the task artifacts.
 *  3. Append a "Verification" section (checklist + artifact links) to the PR
 *     body through the D1 PrProvider.
 *
 * The PR body update is idempotent (a marker comment guards it), so re-running
 * the tool replaces the previous Verification section instead of duplicating it.
 * No network is used: Playwright only reaches the loopback static server.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";
import { resolvePrProvider } from "../agent/ciWatch.js";
import type { PrProvider } from "../tools/gitPrProvider.js";
import {
  appendVerificationSection,
  planFromDiff,
  renderVerificationChecklist,
  runPrVerification,
  type PrVerificationFlowInput,
} from "../agent/prVerification.js";

const execFileAsync = promisify(execFile);

/** Branches we will not diff against by default. */
const DEFAULT_BASE = "main";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: (e.stderr ?? e.message ?? "git failed").trim() };
  }
}

export interface VerifyAndRecordToolOptions {
  /** Defaults to the connector-backed GitHub provider (`LOAM_PR_PROVIDER=local`
   *  selects the scripted local provider, so no network is used). */
  provider?: PrProvider;
}

/** Read the PR diff the plan is derived from: `git diff <base>...HEAD`. */
export async function prDiff(workspace: string, base: string): Promise<string> {
  const cleaned = base.trim();
  if (!cleaned || cleaned.startsWith("-") || cleaned.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid diff base: "${base}"`);
  }
  const res = await git(workspace, ["diff", "--no-color", "--no-ext-diff", `${cleaned}...HEAD`]);
  if (res.code !== 0) {
    // A missing base ref is common on a freshly created branch; fall back to the
    // working tree so the plan can still be derived from what changed.
    const local = await git(workspace, ["diff", "--no-color", "--no-ext-diff", cleaned]);
    if (local.code === 0) return local.stdout;
    throw new Error(`cannot read the pull request diff: ${res.stderr || local.stderr}`);
  }
  return res.stdout;
}

/** Format the tool result: the checklist plus where the artifacts landed. */
export function formatVerifyAndRecord(args: {
  pass: boolean;
  section: string;
  videos: string[];
  screenshots: string[];
  run: string;
  appRoot: string;
}): string {
  const lines = [
    args.section,
    "",
    `Artifacts: ${args.appRoot}`,
    `Videos: ${args.videos.length}${args.videos.length ? ` (${args.videos.map((v) => path.basename(v)).join(", ")})` : ""}`,
    `Screenshots: ${args.screenshots.length}`,
    args.pass ? "Verification passed: every flow in the plan completed." : "Verification failed: at least one flow did not complete; see the checklist above.",
  ];
  return lines.join("\n");
}

export function createVerifyAndRecordTool(options: VerifyAndRecordToolOptions = {}): Tool {
  const provider = options.provider ?? resolvePrProvider();

  return {
    name: "verify_and_record",
    description:
      "Derive a test plan from a pull request's diff, run those user flows with Playwright against the local static app " +
      "(recording a video and screenshots per flow into the task artifacts), then append a Verification checklist with the " +
      "artifact links to the PR body. Re-running replaces the previous Verification section.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number", "root"],
      properties: {
        repo: { type: "string", description: "Repository as owner/repo." },
        number: { type: "number", description: "Pull request number to attach the verification to." },
        root: { type: "string", description: "Directory of the local static app to verify (relative to the workspace)." },
        entry: { type: "string", description: "Entry document to open (default index.html)." },
        base: { type: "string", description: `Branch the PR diff is taken against (default ${DEFAULT_BASE}).` },
        flows: {
          type: "array",
          description: "Optional explicit test plan; overrides the plan derived from the diff.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              file: { type: "string" },
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: { action: { type: "string", enum: ["fill", "click", "wait", "expect-text", "expect-url", "text"] }, selector: { type: "string" }, value: { type: "string" } },
                  required: ["action"],
                },
              },
            },
            required: ["name", "steps"],
          },
        },
        artifacts: { type: "string", description: "Artifact sub-directory under the workspace (default .verification/pr)." },
        channel: { type: "string", description: "Browser channel to launch (default: the configured channel)." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120_000, description: "Per-action timeout in milliseconds (default 15000)." },
        noPost: { type: "boolean", description: "Run the plan and report the checklist without touching the PR body." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const repo = str(args, "repo").trim() || "local/repo";
      const number = num(args, "number", 0);
      const root = str(args, "root").trim();
      if (!number) return { ok: false, content: "verify_and_record requires a pull request number" };
      if (!root) return { ok: false, content: "verify_and_record requires the local app root" };

      // Test plan: an explicit plan wins, otherwise derive it from the PR diff.
      let flows: PrVerificationFlowInput[];
      let derived: string[];
      try {
        const explicit = parseFlows(args);
        if (explicit) {
          flows = explicit;
          derived = flows.map((flow) => flow.file ?? "").filter(Boolean);
        } else {
          const base = str(args, "base").trim() || DEFAULT_BASE;
          const diff = await prDiff(ctx.workspace, base);
          const plan = planFromDiff(diff);
          flows = plan.flows;
          derived = plan.files;
        }
      } catch (err) {
        return { ok: false, content: `verify_and_record could not build a test plan: ${err instanceof Error ? err.message : String(err)}` };
      }

      let result;
      try {
        result = await runPrVerification(ctx.cfg, ctx.workspace, {
          root,
          entry: str(args, "entry").trim() || undefined,
          flows,
          artifacts: str(args, "artifacts").trim() || undefined,
          run: randomUUID(),
          channel: str(args, "channel").trim() || undefined,
          timeoutMs: num(args, "timeoutMs", 0) || undefined,
        }, ctx.signal);
      } catch (err) {
        return { ok: false, content: `verify_and_record failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const section = renderVerificationChecklist(result);
      if (bool(args, "noPost", false)) {
        return { ok: true, content: formatVerifyAndRecord({ pass: result.pass, section, videos: result.videos, screenshots: result.screenshots, run: result.run, appRoot: result.artifactsDir }) };
      }

      try {
        const pr = await provider.viewPr(repo, number);
        const body = appendVerificationSection(pr.body ?? "", section);
        await provider.setPrBody(repo, number, body);
      } catch (err) {
        return {
          ok: false,
          content: `${formatVerifyAndRecord({ pass: result.pass, section, videos: result.videos, screenshots: result.screenshots, run: result.run, appRoot: result.artifactsDir })}\n\nCould not update the pull request body: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return {
        ok: result.pass,
        content: [
          `Attached the Verification section to ${repo}#${number}.`,
          ...(derived.length ? [`Plan derived from the diff (${derived.length} changed file(s)).`] : []),
          "",
          formatVerifyAndRecord({ pass: result.pass, section, videos: result.videos, screenshots: result.screenshots, run: result.run, appRoot: result.artifactsDir }),
        ].join("\n"),
      };
    },
  };
}

/** Parse the optional explicit `flows` argument; null when absent or empty. */
function parseFlows(args: Record<string, unknown>): PrVerificationFlowInput[] | null {
  const raw = args["flows"];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: PrVerificationFlowInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const stepsRaw = Array.isArray(record.steps) ? record.steps : [];
    const steps = stepsRaw
      .map((step) => (step && typeof step === "object" ? (step as Record<string, unknown>) : null))
      .filter((step): step is Record<string, unknown> => step !== null)
      .map((step) => ({
        action: typeof step.action === "string" ? step.action : "",
        ...(typeof step.selector === "string" ? { selector: step.selector } : {}),
        ...(typeof step.value === "string" ? { value: step.value } : {}),
      }))
      .filter((step) => step.action);
    if (!name || steps.length === 0) continue;
    out.push({ name, ...(typeof record.file === "string" && record.file.trim() ? { file: record.file.trim() } : {}), steps });
  }
  return out.length > 0 ? out : null;
}
