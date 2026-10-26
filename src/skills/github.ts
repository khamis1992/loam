// src/skills/github.ts — (MISSING §6.6 reference implementation, tested on the box)
import type { RemoteSkillFile } from "./install.js";

/** Parse "owner/repo[/sub/path][@ref]" or a github.com tree URL into parts. */
export function parseGithubSkillRef(input: string): { owner: string; repo: string; path: string; ref: string } | null {
  const s = input.trim();
  const url = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([\w.\/-]+?)\/(.+)$/.exec(s);
  if (url) return { owner: url[1]!, repo: url[2]!, ref: url[3]!, path: url[4]!.replace(/\/$/, "") };
  const short = /^([\w.-]+)\/([\w.-]+)((?:\/[^@\s]+)?)(?:@([\w.\/-]+))?$/.exec(s);
  if (!short) return null;
  return { owner: short[1]!, repo: short[2]!, path: (short[3] ?? "").replace(/^\//, "").replace(/\/$/, ""), ref: short[4] ?? "HEAD" };
}

/** List the files of one skill folder at a fixed commit (one git-trees call). Caps: 200 files, 5 MiB declared size. */
export async function listGithubSkillFiles(owner: string, repo: string, commit: string, dir: string, headers: Record<string, string>): Promise<RemoteSkillFile[]> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub tree request failed (${res.status})`);
  const tree = (await res.json()) as { truncated?: boolean; tree?: Array<{ path?: string; type?: string; size?: number }> };
  if (tree.truncated) throw new Error("repository tree is too large to list; install from a smaller repo");
  const prefix = dir ? `${dir}/` : "";
  const blobs = (tree.tree ?? []).filter((e) => e.type === "blob" && typeof e.path === "string" && e.path.startsWith(prefix));
  if (!blobs.some((b) => b.path === `${prefix}SKILL.md`)) throw new Error(`no SKILL.md at ${dir || "repo root"}`);
  if (blobs.length > 200) throw new Error("skill has more than 200 files");
  if (blobs.reduce((n, b) => n + (b.size ?? 0), 0) > 5 * 1024 * 1024) throw new Error("skill is larger than 5 MiB");
  return blobs.map((b) => ({ rel: b.path!.slice(prefix.length), url: `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${b.path!.split("/").map(encodeURIComponent).join("/")}` }));
}
