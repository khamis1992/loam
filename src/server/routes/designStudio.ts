/**
 * Design Studio HTTP surface (D1). Mounted as a standalone route module; the
 * supervisor adds one import + one dispatch line in http.ts next to the other
 * /api/ handlers. Routes:
 *   GET    /api/design/templates                 → { templates }
 *   GET    /api/design/brand-kits                → { kits }
 *   POST   /api/design/brand-kits                → { kit }        (create; body = kit fields)
 *   PUT    /api/design/brand-kits/:id            → { kit }        (update)
 *   DELETE /api/design/brand-kits/:id            → { deleted }
 *   POST   /api/design/generate                  → { design, spec }
 *   GET    /api/design/outputs                   → { designs }    (?limit=)
 *   GET    /api/design/outputs/:id               → { design }
 *   GET    /api/design/outputs/:id/image         → image bytes (png preferred, else svg)
 */
import http from "node:http";
import fs from "node:fs";
import {
  DESIGN_TEMPLATES,
  deleteBrandKit,
  generateDesign,
  getBrandKit,
  getDesign,
  listBrandKits,
  listDesigns,
  saveBrandKit,
} from "../designStudio.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<Record<string, unknown>> {
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
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Design Studio routes. Dispatch before generic handlers; scoped to /api/design. */
export async function handleDesignStudioRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/design/")) return false;

  if (req.method === "GET" && p === "/api/design/templates") {
    sendJson(res, 200, { templates: DESIGN_TEMPLATES });
    return true;
  }

  if (req.method === "GET" && p === "/api/design/brand-kits") {
    sendJson(res, 200, { kits: listBrandKits() });
    return true;
  }

  if (req.method === "POST" && p === "/api/design/brand-kits") {
    try {
      const body = await readJson(req);
      sendJson(res, 200, { kit: saveBrandKit(body) });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const kitMatch = /^\/api\/design\/brand-kits\/([^\/]+)$/.exec(p);
  if (kitMatch) {
    const id = decodeURIComponent(kitMatch[1]!);
    if (req.method === "GET") {
      const kit = getBrandKit(id);
      sendJson(res, kit ? 200 : 404, kit ? { kit } : { error: "brand kit not found" });
      return true;
    }
    if (req.method === "PUT") {
      try {
        const body = await readJson(req);
        sendJson(res, 200, { kit: saveBrandKit(body, id) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, message === "brand kit not found" ? 404 : 400, { error: message });
      }
      return true;
    }
    if (req.method === "DELETE") {
      sendJson(res, 200, { deleted: deleteBrandKit(id) });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  if (req.method === "POST" && p === "/api/design/generate") {
    try {
      const body = await readJson(req);
      const brief = typeof body.brief === "string" ? body.brief : "";
      if (!brief.trim()) {
        sendJson(res, 400, { error: "brief is required" });
        return true;
      }
      const { record, spec } = await generateDesign({
        brief,
        ...(typeof body.templateId === "string" ? { templateId: body.templateId } : {}),
        ...(typeof body.brandKitId === "string" && body.brandKitId ? { brandKitId: body.brandKitId } : {}),
      });
      sendJson(res, 200, { design: record, spec });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/design/outputs") {
    const limit = Number(new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).searchParams.get("limit") ?? 20);
    sendJson(res, 200, { designs: listDesigns(Number.isFinite(limit) ? limit : 20) });
    return true;
  }

  const outMatch = /^\/api\/design\/outputs\/([^\/]+)(\/image)?$/.exec(p);
  if (outMatch && req.method === "GET") {
    const id = decodeURIComponent(outMatch[1]!);
    const design = getDesign(id);
    if (!design) {
      sendJson(res, 404, { error: "design not found" });
      return true;
    }
    if (outMatch[2]) {
      const png = design.imageFile && fs.existsSync(design.imageFile) ? design.imageFile : undefined;
      const svg = fs.existsSync(design.svgFile) ? design.svgFile : undefined;
      const file = png ?? svg;
      if (!file) {
        sendJson(res, 404, { error: "design files are missing" });
        return true;
      }
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": file.endsWith(".png") ? "image/png" : "image/svg+xml",
        "content-length": String(data.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(data);
      return true;
    }
    sendJson(res, 200, { design });
    return true;
  }

  sendJson(res, 404, { error: "unknown design route" });
  return true;
}
