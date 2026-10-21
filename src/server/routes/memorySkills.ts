import fs from "node:fs";
import path from "node:path";
import http from "node:http";

/**
 * Settings › Skills (UNIMPLEMENTED_OPTIONS #4) — HTTP surface over the
 * memory-skills MCP backend.
 *
 * The MCP server exposes procedural-memory tools (skill_search / skill_get /
 * skill_record / dashboard) but no HTTP entry point. This route module proxies
 * them so the Settings › Skills pane can list, create, edit, view and delete
 * the persistent skills the agent records. It is dispatched from
 * src/server/http.ts and receives the MCP caller as an option.
 *
 *  - GET    /api/memory-skills          → { skills: [...] }            (dashboard)
 *  - GET    /api/memory-skills/:slug    → SkillDetail                   (skill_get)
 *  - POST   /api/memory-skills          → { ok, slug, version, action } (skill_record)
 *  - PUT    /api/memory-skills/:slug    → { ok, slug, version, action } (skill_record)
 *  - DELETE /api/memory-skills/:slug    → { ok }                       (skill dir removed)
 */

export interface MemorySkillsCall {
  (tool: string, args: Record<string, unknown>): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

export interface MemorySkillsRouteOptions {
  call: MemorySkillsCall;
}

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  version: number;
  uses: number;
  successes: number;
  failures: number;
  partials: number;
  successRate: number;
  lastUsed: string | null;
  updatedAt: string;
  tags: string[];
}

export interface SkillDetail extends SkillSummary {
  path: string;
  source: string;
  body: string;
}

export interface SkillRecordResult {
  ok: boolean;
  slug: string;
  version: number;
  action: "created" | "updated";
  message: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Parse the machine-readable `dashboard` payload; tolerate a non-JSON reply. */
function parseDashboard(text: string): SkillSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  const skills = (parsed as { skills?: unknown })?.skills;
  if (!Array.isArray(skills)) return [];
  return skills
    .map((raw): SkillSummary | null => {
      if (!raw || typeof raw !== "object") return null;
      const r = raw as Record<string, unknown>;
      const slug = typeof r["slug"] === "string" ? r["slug"] : "";
      if (!slug) return null;
      const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
      return {
        slug,
        name: typeof r["name"] === "string" ? r["name"] : slug,
        description: typeof r["description"] === "string" ? r["description"] : "",
        version: num(r["version"], 1),
        uses: num(r["uses"]),
        successes: num(r["successes"]),
        failures: num(r["failures"]),
        partials: num(r["partials"]),
        successRate: num(r["successRate"]),
        lastUsed: typeof r["lastUsed"] === "string" ? r["lastUsed"] : null,
        updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
        tags: Array.isArray(r["tags"]) ? r["tags"].filter((t): t is string => typeof t === "string") : [],
      };
    })
    .filter((s): s is SkillSummary => s !== null);
}

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(raw: string): Frontmatter {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const out: Frontmatter = {};
  if (!m) return out;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const mm = /^(name|description)\s*:\s*(.+)$/.exec(line);
    if (!mm) continue;
    const val = mm[2]!.trim();
    if (mm[1] === "name") out.name = val;
    else out.description = val;
  }
  return out;
}

function splitFrontmatter(raw: string): string {
  return raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim();
}

/**
 * Parse the `skill_get` text reply:
 *   "# name (slug) vN\npath: …\nuses=… success=… failure=… partial=… (P%)\n
 *    last used: … · updated: … · source: …\n\n---\n<SKILL.md>"
 */
function parseSkillGet(text: string): SkillDetail | null {
  const sep = text.indexOf("\n\n---\n");
  const header = sep >= 0 ? text.slice(0, sep) : text;
  const content = sep >= 0 ? text.slice(sep + "\n\n---\n".length) : "";

  const title = /^#\s+(.*?)\s+\(([^)]*)\)\s+v(\d+)\s*$/m.exec(header);
  const slug = title?.[2]?.trim() ?? "";
  if (!slug) return null;

  const path = /^path:\s*(.+)$/m.exec(header)?.[1]?.trim() ?? "";
  const stats = /^uses=(\d+) success=(\d+) failure=(\d+) partial=(\d+) \((\d+)%\)$/m.exec(header);
  const lastUsed = /^last used:\s*(.+?)\s+·\s+updated:/m.exec(header)?.[1]?.trim() ?? null;
  const updated = /updated:\s*([^·]+?)\s+·\s+source:/m.exec(header)?.[1]?.trim() ?? "";
  const source = /source:\s*(\S+)\s*$/m.exec(header)?.[1]?.trim() ?? "";

  const fm = parseFrontmatter(content);
  const name = fm.name?.trim() || title?.[1]?.trim() || slug;
  return {
    slug,
    name,
    description: fm.description?.trim() ?? "",
    version: Number(title?.[3] ?? 1) || 1,
    uses: Number(stats?.[1] ?? 0),
    successes: Number(stats?.[2] ?? 0),
    failures: Number(stats?.[3] ?? 0),
    partials: Number(stats?.[4] ?? 0),
    successRate: stats ? Number(stats[5]) / 100 : 0,
    lastUsed: lastUsed && lastUsed !== "never" ? lastUsed : null,
    updatedAt: updated,
    tags: [],
    path,
    source,
    body: splitFrontmatter(content),
  };
}

function parseRecord(text: string): { slug: string; version: number; action: "created" | "updated" } {
  // "created skill \"slug\" v1 → path" / "updated skill \"slug\" v2 → path …"
  const slug = /skill\s+"([^"]+)"/.exec(text)?.[1] ?? "";
  const version = Number(/v(\d+)/.exec(text)?.[1] ?? 1) || 1;
  const action: "created" | "updated" = /^\s*updated\b/i.test(text) ? "updated" : "created";
  return { slug, version, action };
}

function skillName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function skillBody(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function skillTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
  return tags.length > 0 ? tags : undefined;
}

export async function handleMemorySkillsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  opts: MemorySkillsRouteOptions,
): Promise<boolean> {
  if (!p.startsWith("/api/memory-skills")) return false;
  const call = opts.call;

  try {
    // ---- list ----
    if (p === "/api/memory-skills" && req.method === "GET") {
      const result = await call("dashboard", { skills: 100, episodes: 1, facts: 1 });
      if (!result.ok) {
        sendJson(res, result.error.includes("not running") ? 503 : 502, { error: result.error });
        return true;
      }
      sendJson(res, 200, { skills: parseDashboard(result.text) });
      return true;
    }

    // ---- create ----
    if (p === "/api/memory-skills" && req.method === "POST") {
      const body = (await readJson(req)) as { name?: unknown; description?: unknown; body?: unknown; tags?: unknown };
      const name = skillName(body.name);
      const description = skillName(body.description);
      const content = skillBody(body.body);
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return true;
      }
      if (!description) {
        sendJson(res, 400, { error: "description is required" });
        return true;
      }
      if (!content.trim()) {
        sendJson(res, 400, { error: "body is required" });
        return true;
      }
      const result = await call("skill_record", { name, description, body: content, tags: skillTags(body.tags) });
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      const parsed = parseRecord(result.text);
      sendJson(res, 200, { ok: true, slug: parsed.slug || name, version: parsed.version, action: parsed.action, message: result.text });
      return true;
    }

    // ---- per-skill ----
    if (p.startsWith("/api/memory-skills/")) {
      const slug = decodeURIComponent(p.slice("/api/memory-skills/".length));
      if (!slug || slug.includes("/")) return false;

      if (req.method === "GET") {
        const result = await call("skill_get", { name: slug });
        if (!result.ok) {
          sendJson(res, result.error.includes("not found") ? 404 : 502, { error: result.error });
          return true;
        }
        const detail = parseSkillGet(result.text);
        if (!detail) {
          sendJson(res, 502, { error: "memory-skills returned an unreadable skill" });
          return true;
        }
        sendJson(res, 200, detail);
        return true;
      }

      if (req.method === "PUT") {
        const body = (await readJson(req)) as { name?: unknown; description?: unknown; body?: unknown; tags?: unknown };
        const name = skillName(body.name) || slug;
        const description = skillName(body.description);
        const content = skillBody(body.body);
        if (!description) {
          sendJson(res, 400, { error: "description is required" });
          return true;
        }
        if (!content.trim()) {
          sendJson(res, 400, { error: "body is required" });
          return true;
        }
        const result = await call("skill_record", { name, description, body: content, tags: skillTags(body.tags) });
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return true;
        }
        const parsed = parseRecord(result.text);
        sendJson(res, 200, { ok: true, slug: parsed.slug || name, version: parsed.version, action: parsed.action, message: result.text });
        return true;
      }

      if (req.method === "DELETE") {
        // The MCP has no delete tool; skills are files under the skills dir, so
        // resolve the path via skill_get and remove the skill directory. The
        // backend's next sync drops it from its index.
        const result = await call("skill_get", { name: slug });
        if (!result.ok) {
          sendJson(res, result.error.includes("not found") ? 404 : 502, { error: result.error });
          return true;
        }
        const detail = parseSkillGet(result.text);
        const filePath = detail?.path ?? "";
        if (!filePath || path.basename(filePath) !== "SKILL.md") {
          sendJson(res, 400, { error: "could not resolve the skill file" });
          return true;
        }
        const dir = path.dirname(filePath);
        if (path.basename(dir) !== slug) {
          sendJson(res, 400, { error: "skill path does not match the requested skill" });
          return true;
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          return true;
        }
        sendJson(res, 200, { ok: true, slug });
        return true;
      }

      return false;
    }

    return false;
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
