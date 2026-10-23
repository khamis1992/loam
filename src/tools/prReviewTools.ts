/**
 * pr_review tool (D15): review a pull request's diff through the D1 PR provider.
 *
 * Each changed file is reviewed on its own against the repo conventions
 * (AGENTS.md / CONTRIBUTING.md when present) and the deduplicated findings are
 * returned as `{severity, file, line, explanation, suggested_fix}`. With
 * `postComments` the findings are also filed as line review comments through the
 * same provider.
 *
 * The model client and the provider are both injectable, so tests review a
 * scripted diff with a fake model and never touch the network.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";
import type { PrProvider } from "./gitPrProvider.js";
import { resolvePrProvider } from "../agent/ciWatch.js";
import {
  formatReviewResult,
  loadRepoConventions,
  reviewPullRequest,
  type PrReviewModelClient,
} from "../agent/prReview.js";

export interface PrReviewToolOptions {
  /** Defaults to the connector-backed provider (`LOAM_PR_PROVIDER=local` for the
   *  scripted provider). */
  provider?: PrProvider;
  /** Model id; "" uses the run's main model. */
  model?: string;
  /** Injectable model client (tests); defaults to the run's Ollama client. */
  modelClient?: PrReviewModelClient;
  /** Conventions override; defaults to the workspace's AGENTS.md / CONTRIBUTING.md. */
  conventions?: string;
}

/** The comment body one finding is filed as. */
export function renderReviewComment(finding: { severity: string; explanation: string; suggested_fix: string }): string {
  const head = `**[${finding.severity}] loam pr_review**\n${finding.explanation}`;
  const fix = finding.suggested_fix.trim();
  return fix ? `${head}\n\nSuggested fix:\n${fix}` : head;
}

export function createPrReviewTool(options: PrReviewToolOptions = {}): Tool {
  const provider: PrProvider = options.provider ?? resolvePrProvider();

  return {
    name: "pr_review",
    description:
      "Review a pull request's changed files for real defects and convention violations. " +
      "Fetches the diff through the active PR provider, sends each changed file's unified diff to the model together with the repo conventions (AGENTS.md / CONTRIBUTING.md when present), " +
      "validates and deduplicates the findings, and returns them as a list of {severity: bug|flag|nit, file, line, explanation, suggested_fix}. " +
      "Use it before asking for a review on a branch you did not write, before merging someone else's PR, or any time you want a second pass over a diff the user is about to ship. " +
      "Set postComments=true to file the findings as line review comments through the same provider (skip it when you only need the list). " +
      "When NOT to use: on a diff you cannot fetch, on lockfiles or generated output (they are skipped automatically), or as a substitute for running the project's own tests and typecheck before you report success.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "number"],
      properties: {
        repo: { type: "string", description: "Repository as owner/repo (GitHub provider)." },
        number: { type: "number", description: "Pull request number to review." },
        postComments: { type: "boolean", default: false, description: "File each finding as a line review comment through the provider (default false)." },
        maxFiles: { type: "integer", minimum: 1, maximum: 100, description: "Cap on files reviewed (default: every changed file)." },
        conventions: { type: "string", description: "Override the conventions block; defaults to AGENTS.md / CONTRIBUTING.md in the workspace." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const repo = str(args, "repo").trim() || "local/repo";
      const number = num(args, "number", 0);
      if (!number) return { ok: false, content: "pr_review requires a pull request number" };

      // Precedence: an explicit per-call `conventions` argument, then the tool
      // option, then the workspace's AGENTS.md / CONTRIBUTING.md.
      const explicit = str(args, "conventions").trim();
      const conventions = explicit || options.conventions || loadRepoConventions(ctx.workspace).text;

      try {
        const result = await reviewPullRequest(provider, repo, number, {
          conventions,
          model: options.model ?? ctx.cfg.model,
          ...(options.modelClient ? { modelClient: options.modelClient } : {}),
          ...(typeof args.maxFiles === "number" ? { maxFiles: num(args, "maxFiles", 0) } : {}),
          signal: ctx.signal,
        });

        let posted = 0;
        if (bool(args, "postComments", false)) {
          for (const finding of result.findings) {
            try {
              await provider.addComment(repo, number, renderReviewComment(finding), {
                path: finding.file,
                line: finding.line,
              });
              posted += 1;
            } catch (error) {
              result.warnings.push(`could not post ${finding.file}:${finding.line}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        return { ok: true, content: formatReviewResult(result, { repo, number, posted }) };
      } catch (error) {
        return { ok: false, content: `pr_review failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
