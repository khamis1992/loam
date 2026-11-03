import http from "node:http";
import type { AppProject } from "../../appbuilder/types.js";
import { listCompanyRuns } from "../../appbuilder/company/store.js";
import type { CompanyRuntimeDeps } from "../../appbuilder/company/runtime.js";
import { createCompanyRuntime, type CompanyRuntime } from "../../appbuilder/company/runtime.js";

const runtimes = new WeakMap<CompanyRuntimeDeps["runTask"], CompanyRuntime>();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

export async function handleCompanyRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: AppProject,
  sub: string[],
  readBody: (maxBytes?: number) => Promise<unknown>,
  deps?: CompanyRuntimeDeps,
): Promise<boolean> {
  const area = sub[0];
  if (area !== "company" && area !== "dev-server") return false;
  if (!deps) return sendJson(res, 503, { error: "engine_unavailable" }), true;
  let runtime = runtimes.get(deps.runTask);
  if (!runtime) {
    runtime = createCompanyRuntime(deps);
    runtimes.set(deps.runTask, runtime);
  }
  try {
    if (area === "dev-server") {
      if (req.method === "GET") return sendJson(res, 200, { devServer: runtime.devServer.status(project.id) }), true;
      if (req.method === "POST") return sendJson(res, 200, { url: await runtime.devServer.ensure(project) }), true;
      if (req.method === "DELETE") { runtime.devServer.stop(project.id); return sendJson(res, 200, { ok: true }), true; }
      return sendJson(res, 405, { error: "method_not_allowed" }), true;
    }

    const action = sub[1] ?? "runs";
    if (action !== "runs") return sendJson(res, 404, { error: "not_found" }), true;
    if (sub.length === 1 || (sub.length === 2 && action === "runs")) {
      if (req.method === "GET") return sendJson(res, 200, { runs: listCompanyRuns(project.id) }), true;
      if (req.method === "POST") {
        const body = await readBody() as { idea?: unknown; autoStart?: unknown };
        if (typeof body.idea !== "string") return sendJson(res, 400, { error: "idea_required" }), true;
        const run = await runtime.engine.start(project, body.idea, body.autoStart !== false);
        return sendJson(res, 201, { run }), true;
      }
      return sendJson(res, 405, { error: "method_not_allowed" }), true;
    }

    const id = sub[2]!;
    const run = runtime.engine.get(id);
    if (run.projectId !== project.id) return sendJson(res, 404, { error: "not_found" }), true;
    if (sub.length === 3 && req.method === "GET") return sendJson(res, 200, { run }), true;
    const operation = sub[3];
    if (operation === "approve" && req.method === "POST") return sendJson(res, 202, { run: await runtime.engine.approve(project, id) }), true;
    if (operation === "retry" && req.method === "POST") return sendJson(res, 202, { run: await runtime.engine.retry(project, id) }), true;
    if (operation === "cancel" && req.method === "POST") return sendJson(res, 200, { run: await runtime.engine.cancel(project, id) }), true;
    if (operation === "export" && req.method === "GET") {
      const data = runtime.engine.export(id);
      res.writeHead(200, { "content-type": "application/zip", "content-length": data.length, "content-disposition": `attachment; filename="${project.id}-v${run.versionNumber}.zip"` });
      res.end(data);
      return true;
    }
    return sendJson(res, 404, { error: "not_found" }), true;
  } catch (error) {
    return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }), true;
  }
}
