/**
 * Git / PR workflow tools (D1): branch, commit, status/diff and pull-request
 * operations with a review-comment checklist.
 *
 * Hard rules enforced here:
 *  - there is NO force-push option anywhere; push is always a plain push.
 *  - push requires the explicit `approvePush` flag and, when a task context is
 *    present, goes through the existing approval gate (src/server/approvals.ts).
 *  - commits on protected branches (main, manus-parity) are refused.
 *
 * PR operations go through the PrProvider interface (gitPrProvider.ts): a
 * GitHub implementation backed by the existing connector, and a LocalProvider
 * that stores PRs as JSON under `.loam/prs` for tests and local remotes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createApproval, waitForDecision } from "../server/approvals.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str, strs } from "./registry.js";
import {
  GitHubPrProvider,
  PrChecklistStore,
  type ChecklistStatus,
  type PrProvider,
} from "./gitPrProvider.js";

const execFileAsync = promisify(execFile);

/** Branches that must never receive a direct commit. */
export const PROTECTED_BRANCHES = ["main", "manus-parity"];

export function isProtectedBranch(name: string): boolean {
  return PROTECTED_BRANCHES.includes(name.trim());
}

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
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: (e.stderr ?? e.message ?? "git failed").trim(),
    };
  }
}

function fail(name: string, err: unknown): ToolResult {
  return { ok: false, content: `${name} failed: ${err instanceof Error ? err.message : String(err)}` };
}

function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then((r) => r.stdout.trim());
}

/** Reject branch names that git would read as an option or a revision range. */
function validBranchName(name: string): boolean {
  return name.length > 0 && !name.includes("..") && !name.startsWith("-") && !/[~^:?*[\\\s]/.test(name);
}

/** Reject paths that escape the workspace or are passed as options. */
function validCommitPath(p: string): boolean {
  if (!p || p.startsWith("-")) return false;
  if (path.isAbsolute(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** Push only after the explicit flag AND the approval gate (when present). */
async function pushWithApproval(
  ctx: ToolContext,
  summary: string,
  action: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!ctx.taskId) {
    // No approval channel in this context: the explicit flag is the only gate.
    return action();
  }
  const approval = createApproval({ taskId: ctx.taskId, tool: "git_branch", summary, argsPreview: JSON.stringify({ push: true }) });
  ctx.emit({ type: "approval_required", approvalId: approval.id, tool: "git_branch", summary });
  const decision = await waitForDecision(approval.id, ctx.signal);
  if (decision !== "approved") {
    return { ok: false, content: `push was ${decision} by the user; nothing was pushed.` };
  }
  return action();
}

export interface GitWorkflowToolOptions {
  /** Defaults to the GitHub provider backed by the connected connector. */
  provider?: PrProvider;
}

export function createGitWorkflowTools(options: GitWorkflowToolOptions = {}): Tool[] {
  const provider: PrProvider = options.provider ?? new GitHubPrProvider();

  const checklistDir = (ctx: ToolContext): string => path.join(ctx.workspace, ".loam", "prs", "checklists");

  return [
    {
      name: "git_branch",
      description:
        "Create or switch a git branch. Creating a protected branch (main, manus-parity) is refused. Set push=true to push the branch to a remote; pushing always requires the explicit approvePush flag and user approval, and force-push is never available.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Branch name to create or switch to." },
          create: { type: "boolean", description: "Create the branch (default true). Set false to switch to an existing branch." },
          push: { type: "boolean", description: "Push the branch to a remote after creating/switching (default false)." },
          remote: { type: "string", description: "Remote name (default 'origin')." },
          approvePush: { type: "boolean", description: "Explicit approval required to push. Push is refused without it." },
        },
        required: ["name"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const name = str(args, "name").trim();
        if (!validBranchName(name)) return { ok: false, content: `invalid branch name: "${name}"` };
        const create = bool(args, "create", true);
        const push = bool(args, "push", false);
        const remote = str(args, "remote", "origin").trim() || "origin";
        const approvePush = bool(args, "approvePush", false);

        if (create && isProtectedBranch(name)) {
          return { ok: false, content: `refusing to create protected branch "${name}"` };
        }

        const checkout = create ? ["checkout", "-b", name] : ["checkout", name];
        const res = await git(ctx.workspace, checkout);
        if (res.code !== 0) return { ok: false, content: `git_branch failed: ${res.stderr || `cannot ${create ? "create" : "switch to"} ${name}`}` };

        if (!push) return { ok: true, content: `${create ? "created" : "switched to"} branch "${name}"` };
        if (!approvePush) {
          return { ok: false, content: "push requires the explicit approvePush=true flag; nothing was pushed." };
        }
        return pushWithApproval(ctx, `Push branch "${name}" to ${remote}`, async () => {
          const pushed = await git(ctx.workspace, ["push", "-u", remote, name]);
          if (pushed.code !== 0) return { ok: false, content: `push failed: ${pushed.stderr || "git push rejected"}` };
          return { ok: true, content: `pushed "${name}" to ${remote}` };
        });
      },
    },
    {
      name: "git_commit",
      description:
        "Stage the given paths and create a commit. Commits on protected branches (main, manus-parity) are refused.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Paths to stage (relative to the workspace)." },
          message: { type: "string", description: "Commit message." },
        },
        required: ["paths", "message"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const message = str(args, "message").trim();
        const paths = strs(args, "paths");
        if (!message) return { ok: false, content: "git_commit requires a message" };
        if (paths.length === 0) return { ok: false, content: "git_commit requires at least one path" };
        const invalid = paths.find((p) => !validCommitPath(p));
        if (invalid) return { ok: false, content: `refusing invalid or escaping path: "${invalid}"` };

        const branch = await currentBranch(ctx.workspace);
        if (isProtectedBranch(branch)) {
          return { ok: false, content: `refusing to commit on protected branch "${branch}"` };
        }

        const add = await git(ctx.workspace, ["add", "--", ...paths]);
        if (add.code !== 0) return { ok: false, content: `git add failed: ${add.stderr || "could not stage paths"}` };

        const commit = await git(ctx.workspace, [
          "-c",
          "user.name=Loam Agent",
          "-c",
          "user.email=agent@loam.local",
          "commit",
          "-m",
          message,
        ]);
        if (commit.code !== 0) return { ok: false, content: `git commit failed: ${commit.stderr || "commit rejected"}` };
        const short = commit.stdout.match(/^\[[^\]]+ ([0-9a-f]+)/m);
        return { ok: true, content: `committed on "${branch}"${short ? ` (${short[1]})` : ""}: ${message}` };
      },
    },
    {
      name: "git_status_diff",
      description: "Show working-tree status and the current diff (unstaged and staged) for the workspace.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "Optional paths to limit the diff to." },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        const paths = strs(args, "paths");
        const status = await git(ctx.workspace, ["status", "--porcelain", "--", ...paths]);
        const stat = await git(ctx.workspace, ["diff", "--stat", "--", ...paths]);
        const diff = await git(ctx.workspace, ["diff", "--", ...paths]);
        const parts: string[] = [];
        parts.push(status.stdout.trim() || "(clean tree)");
        if (stat.stdout.trim()) parts.push(`diff --stat:\n${stat.stdout.trim()}`);
        if (diff.stdout.trim()) parts.push(`diff:\n${diff.stdout.trim()}`);
        return { ok: true, content: parts.join("\n\n") };
      },
    },
    {
      name: "pr_create",
      description:
        "Create a pull request through the active PR provider (GitHub when connected, otherwise the local provider). `head` defaults to the current branch and `base` to main.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository as owner/repo (GitHub provider)." },
          title: { type: "string", description: "Pull request title." },
          body: { type: "string", description: "Pull request body (markdown)." },
          head: { type: "string", description: "Source branch (default: current branch)." },
          base: { type: "string", description: "Target branch (default: main)." },
        },
        required: ["title"],
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const repo = str(args, "repo").trim();
          const title = str(args, "title").trim();
          if (!title) return { ok: false, content: "pr_create requires a title" };
          const head = str(args, "head").trim() || (await currentBranch(ctx.workspace));
          const base = str(args, "base").trim() || "main";
          if (provider.id === "github" && !repo) return { ok: false, content: "pr_create requires repo as owner/repo for the GitHub provider" };
          const pr = await provider.createPr({
            repo: repo || "local/repo",
            title,
            head,
            base,
            ...(str(args, "body").trim() ? { body: str(args, "body") } : {}),
          });
          return { ok: true, content: `created pull request #${pr.number}: ${pr.title} (${pr.head} -> ${pr.base}) ${pr.url}` };
        } catch (err) {
          return fail("pr_create", err);
        }
      },
    },
    {
      name: "pr_view",
      description: "View a pull request's number, title, state and branches.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository as owner/repo (GitHub provider)." },
          number: { type: "number", description: "Pull request number." },
        },
        required: ["number"],
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const repo = str(args, "repo").trim() || "local/repo";
          const number = num(args, "number", 0);
          if (!number) return { ok: false, content: "pr_view requires a pull request number" };
          const pr = await provider.viewPr(repo, number);
          return { ok: true, content: `#${pr.number} [${pr.state}] ${pr.title}\n${pr.head} -> ${pr.base}\n${pr.url}` };
        } catch (err) {
          return fail("pr_view", err);
        }
      },
    },
    {
      name: "pr_comments",
      description:
        "List review comments on a pull request with their ids (use the ids with pr_comment_checklist). Provide `body` to add a comment and return the updated list.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository as owner/repo (GitHub provider)." },
          number: { type: "number", description: "Pull request number." },
          body: { type: "string", description: "Optional comment body; when present a comment is added." },
          path: { type: "string", description: "Optional file path for a line comment." },
          line: { type: "number", description: "Optional line number for a line comment." },
        },
        required: ["number"],
      },
      async run(args, _ctx): Promise<ToolResult> {
        try {
          const repo = str(args, "repo").trim() || "local/repo";
          const number = num(args, "number", 0);
          if (!number) return { ok: false, content: "pr_comments requires a pull request number" };
          const body = str(args, "body").trim();
          if (body) {
            const opts = {
              ...(str(args, "path").trim() ? { path: str(args, "path").trim() } : {}),
              ...(typeof args.line === "number" ? { line: args.line } : {}),
            };
            await provider.addComment(repo, number, body, opts);
          }
          const comments = await provider.listReviewComments(repo, number);
          if (comments.length === 0) return { ok: true, content: "(no review comments)" };
          return {
            ok: true,
            content: comments
              .map((c) => `- ${c.id} @${c.author}${c.path ? ` (${c.path}:${c.line ?? "?"})` : ""}: ${c.body}`)
              .join("\n"),
          };
        } catch (err) {
          return fail("pr_comments", err);
        }
      },
    },
    {
      name: "pr_comment_checklist",
      description:
        "Mark a pull request review comment done, outdated, or open. The checklist is persisted per pull request in session state (.loam/prs/checklists).",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository as owner/repo (GitHub provider)." },
          number: { type: "number", description: "Pull request number." },
          commentId: { type: "string", description: "Comment id from pr_comments." },
          status: { type: "string", enum: ["open", "done", "outdated"], description: "New checklist status." },
        },
        required: ["number", "commentId", "status"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const repo = str(args, "repo").trim() || "local/repo";
        const number = num(args, "number", 0);
        const commentId = str(args, "commentId").trim();
        const status = str(args, "status").trim() as ChecklistStatus;
        if (!number) return { ok: false, content: "pr_comment_checklist requires a pull request number" };
        if (!commentId) return { ok: false, content: "pr_comment_checklist requires commentId" };
        if (status !== "open" && status !== "done" && status !== "outdated") {
          return { ok: false, content: `invalid status "${status}" (expected open, done, or outdated)` };
        }
        const store = new PrChecklistStore(checklistDir(ctx));
        const checklist = store.set(repo, number, commentId, status);
        const summary = Object.entries(checklist)
          .map(([id, value]) => `- ${id}: ${value}`)
          .join("\n");
        return { ok: true, content: `marked ${commentId} as ${status}\nchecklist:\n${summary || "(empty)"}` };
      },
    },
  ];
}
