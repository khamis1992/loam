/**
 * Playbook HTTP surface (D9) — mounted by src/server/http.ts.
 *
 *   GET    /api/playbooks                       list
 *   POST   /api/playbooks                       create
 *   GET    /api/playbooks/:idOrMacro            read (id or `!macro`)
 *   PATCH  /api/playbooks/:idOrMacro            edit (appends a version)
 *   DELETE /api/playbooks/:idOrMacro            delete (+ its versions)
 *   GET    /api/playbooks/:idOrMacro/versions   version history
 *   GET    /api/playbooks/:idOrMacro/versions/:n  one historical version
 *   POST   /api/playbooks/:idOrMacro/versions/:n/restore  restore as the new version
 */
import http from "node:http";
import {
  MACRO_PATTERN,
  NAME_MAX,
  SECTION_KEYS,
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  getPlaybookByMacro,
  getVersion,
  isValidMacro,
  listPlaybooks,
  listVersions,
  normalizeMacro,
  updatePlaybook,
  type Playbook,
  type UpdatePlaybookInput,
} from "../playbooks.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 128_000): Promise<Record<string, unknown>> {
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
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Section values from a request body; unknown keys are ignored. */
function readSections(body: Record<string, unknown>): Partial<Record<(typeof SECTION_KEYS)[number], string>> {
  const out: Partial<Record<(typeof SECTION_KEYS)[number], string>> = {};
  for (const key of SECTION_KEYS) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    out[key] = typeof raw === "string" ? raw : String(raw);
  }
  return out;
}

/** Resolve a path segment to a playbook: exact id first, then `!macro`. */
function lookup(idOrMacro: string): Playbook | undefined {
  return getPlaybook(idOrMacro) ?? getPlaybookByMacro(idOrMacro);
}

function errorStatus(message: string): number {
  return /already exists/.test(message) ? 409 : 400;
}

export async function handlePlaybookRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (p !== "/api/playbooks" && !p.startsWith("/api/playbooks/")) return false;

  const rest = p.slice("/api/playbooks".length).replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = rest.length > 0 ? rest.split("/").map((s) => decodeURIComponent(s)) : [];

  // ---- collection: /api/playbooks ----
  if (segments.length === 0) {
    if (req.method === "GET") {
      sendJson(res, 200, { playbooks: listPlaybooks() });
      return true;
    }
    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const macroRaw = typeof body.macro === "string" ? body.macro : "";
      const macro = normalizeMacro(macroRaw);
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return true;
      }
      if (name.length > NAME_MAX) {
        sendJson(res, 400, { error: `name must be at most ${NAME_MAX} characters` });
        return true;
      }
      if (!macro) {
        sendJson(res, 400, { error: "macro is required" });
        return true;
      }
      if (!MACRO_PATTERN.test(macro) || !isValidMacro(macro)) {
        sendJson(res, 400, { error: "macro must be lowercase letters, digits or underscores and start with a letter" });
        return true;
      }
      if (getPlaybookByMacro(macro)) {
        sendJson(res, 409, { error: `macro "${macro}" already exists` });
        return true;
      }
      try {
        const playbook = createPlaybook({ name, macro, ...readSections(body) });
        sendJson(res, 201, { playbook });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, errorStatus(message), { error: message });
      }
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const idOrMacro = segments[0]!;

  // ---- version history: /api/playbooks/:idOrMacro/versions[/:n[/restore]] ----
  if (segments[1] === "versions") {
    const playbook = lookup(idOrMacro);
    if (!playbook) {
      sendJson(res, 404, { error: "playbook not found" });
      return true;
    }
    if (segments.length === 2) {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      sendJson(res, 200, { versions: listVersions(playbook.id) });
      return true;
    }

    const versionNumber = Number(segments[2]);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      sendJson(res, 400, { error: "invalid version number" });
      return true;
    }
    const version = getVersion(playbook.id, versionNumber);
    if (!version) {
      sendJson(res, 404, { error: "version not found" });
      return true;
    }

    if (segments.length === 3) {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      sendJson(res, 200, { version });
      return true;
    }

    if (segments.length === 4 && segments[3] === "restore") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const restored = updatePlaybook(playbook.id, {
        overview: version.overview,
        procedure: version.procedure,
        specifications: version.specifications,
        advice: version.advice,
        forbiddenActions: version.forbiddenActions,
        neededFromUser: version.neededFromUser,
      });
      if (!restored) {
        sendJson(res, 404, { error: "playbook not found" });
        return true;
      }
      sendJson(res, 200, { playbook: restored });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  }

  if (segments.length > 1) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  // ---- single playbook: /api/playbooks/:idOrMacro ----
  const playbook = lookup(idOrMacro);
  if (!playbook) {
    sendJson(res, 404, { error: "playbook not found" });
    return true;
  }

  if (req.method === "GET") {
    sendJson(res, 200, { playbook });
    return true;
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    const input: UpdatePlaybookInput = { ...readSections(body) };
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        sendJson(res, 400, { error: "name cannot be empty" });
        return true;
      }
      input.name = name;
    }
    if (body.macro !== undefined) {
      const macro = normalizeMacro(typeof body.macro === "string" ? body.macro : "");
      if (!macro) {
        sendJson(res, 400, { error: "macro cannot be empty" });
        return true;
      }
      if (!MACRO_PATTERN.test(macro)) {
        sendJson(res, 400, { error: "macro must be lowercase letters, digits or underscores and start with a letter" });
        return true;
      }
      input.macro = macro;
    }

    try {
      const updated = updatePlaybook(playbook.id, input);
      if (!updated) {
        sendJson(res, 404, { error: "playbook not found" });
        return true;
      }
      sendJson(res, 200, { playbook: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, errorStatus(message), { error: message });
    }
    return true;
  }

  if (req.method === "DELETE") {
    sendJson(res, 200, { deleted: deletePlaybook(playbook.id) });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
