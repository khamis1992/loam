import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "../agent/events.js";
import { resolveRead } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

export const ARTIFACT_KINDS = ["report", "page", "deck", "sheet", "image", "video", "file"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactEntry {
  path: string;
  kind: ArtifactKind;
  title: string;
  description?: string;
  mime: string;
  size: number;
  sha256: string;
  publishedAt: string;
}

/** `.loam/artifacts.json` manifest, keyed by workspace-relative path. */
export type ArtifactManifest = Record<string, ArtifactEntry>;

const MIME_BY_EXT: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

/** Mirror of the protocol's mimeFromExt (not exported there); keep in sync. */
function mimeFromExt(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function posixRel(workspace: string, abs: string): string {
  return path.relative(workspace, abs).split(path.sep).join("/");
}

function manifestPath(workspace: string): string {
  return path.join(workspace, ".loam", "artifacts.json");
}

function readManifest(file: string): ArtifactManifest {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ArtifactManifest) : {};
  } catch {
    return {};
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function publish(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rawPath = str(args, "path").trim();
  if (!rawPath) return { ok: false, content: "artifact_publish requires a non-empty path" };
  const title = str(args, "title").trim();
  if (!title) return { ok: false, content: "artifact_publish requires a non-empty title" };
  const kind = str(args, "kind") as ArtifactKind;
  if (!ARTIFACT_KINDS.includes(kind)) {
    return { ok: false, content: `artifact_publish kind must be one of: ${ARTIFACT_KINDS.join(", ")}` };
  }

  let abs: string;
  try {
    abs = resolveRead(ctx.workspace, rawPath, false);
  } catch (err) {
    return { ok: false, content: `artifact_publish denied: ${err instanceof Error ? err.message : String(err)}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, content: `artifact_publish: not found: ${rawPath}` };
  }
  if (stat.isDirectory()) {
    return { ok: false, content: `artifact_publish: path is a directory: ${rawPath}` };
  }
  if (stat.size === 0) {
    return { ok: false, content: `artifact_publish: file is empty: ${rawPath}` };
  }

  const rel = posixRel(ctx.workspace, abs);
  const description = str(args, "description").trim() || undefined;
  const mime = mimeFromExt(abs);
  let sha256: string;
  try {
    sha256 = await sha256File(abs);
  } catch (err) {
    return { ok: false, content: `artifact_publish failed to hash ${rawPath}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const entry: ArtifactEntry = {
    path: rel,
    kind,
    title,
    ...(description ? { description } : {}),
    mime,
    size: stat.size,
    sha256,
    publishedAt: new Date().toISOString(),
  };

  const file = manifestPath(ctx.workspace);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const manifest = readManifest(file);
    manifest[rel] = entry;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  } catch (err) {
    return { ok: false, content: `artifact_publish failed to write manifest: ${err instanceof Error ? err.message : String(err)}` };
  }

  const event: AgentEvent = { type: "artifact_published", path: rel, kind, title, mime, sizeBytes: stat.size, sha256 };
  ctx.emit(event);

  return {
    ok: true,
    content: JSON.stringify({ title: entry.title, kind, path: rel, size: stat.size, sha256, mime }),
  };
}

export function createArtifactTools(): Tool[] {
  return [
    {
      name: "artifact_publish",
      description:
        "Publish a workspace file (report, page, deck, sheet, image, video or generic file) so the user can find it in the task artifacts. Records it in the task manifest, emits an artifact event and returns its size/hash.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind", "title"],
        properties: {
          path: { type: "string", description: "Workspace-relative path of the file to publish." },
          kind: { type: "string", enum: [...ARTIFACT_KINDS], description: "Artifact category." },
          title: { type: "string", description: "Human-readable artifact title." },
          description: { type: "string", description: "Optional short description." },
        },
      },
      run: publish,
    },
  ];
}
