import fs from "node:fs";
import { taskPath } from "../server/taskWorkspace.js";
import http from "node:http";
import path from "node:path";
import { log } from "../log.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export interface PreviewInstance {
  port: number;
  root: string;
  url: string;
  startedAt: string;
  requests: number;
  server: http.Server;
}

/** Tiny static file server so generated sites/apps can be previewed inside the app (like Manus' preview panel). */
export class PreviewService {
  private current: PreviewInstance | null = null;

  get status(): { running: boolean; url: string | null; root: string | null; requests: number; startedAt: string | null } {
    if (!this.current) return { running: false, url: null, root: null, requests: 0, startedAt: null };
    return {
      running: true,
      url: this.current.url,
      root: this.current.root,
      requests: this.current.requests,
      startedAt: this.current.startedAt,
    };
  }

  private static serve(root: string, port: number, onRequest: () => void, req: http.IncomingMessage, res: http.ServerResponse): void {
    let rel: string;
    let target: string;
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, "").replace(/\/+$/, "");
      target = taskPath(root, rel);
    } catch { res.writeHead(403).end("forbidden"); return; }

    const send = (file: string): void => {
      try { taskPath(root, file); } catch { res.writeHead(403).end("forbidden"); return; }
      onRequest();
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    };

    const listDir = (dir: string): void => {
      onRequest();
      const items = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(it => !it.isSymbolicLink())
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((it) => {
          const rel2 = path.relative(root, path.join(dir, it.name)).split(path.sep).join("/");
          const label = (it.isDirectory() ? `${it.name}/` : it.name).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
          return `<li><a href="/${rel2.split("/").map(encodeURIComponent).join("/")}${it.isDirectory() ? "/" : ""}">${label}</a></li>`;
        })
        .join("");
      const title = (path.relative(root, dir) || "Loam").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>${title}</title>` +
          `<style>body{font-family:"Segoe UI",Tahoma,sans-serif;background:#0f1115;color:#e8eaf0;padding:24px}` +
          `a{color:#6ea8fe;text-decoration:none}li{margin:6px 0;list-style:none}ul{padding:0}` +
          `h1{font-size:16px;color:#8b93a7;font-weight:600}</style></head><body><h1>/${title}/</h1>` +
          `<ul>${items || "<li>(فارغ)</li>"}</ul></body></html>`,
      );
    };

    if (fs.existsSync(target)) {
      const st = fs.statSync(target);
      if (st.isFile()) return send(target);
      if (st.isDirectory()) {
        const idx = path.join(target, "index.html");
        if (fs.existsSync(idx)) return send(idx);
        return listDir(target);
      }
    }

    // SPA-ish fallback to the root index, otherwise 404
    const rootIndex = path.join(root, "index.html");
    if (fs.existsSync(rootIndex)) return send(rootIndex);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`not found: /${rel}`);
  }

  async start(rootDir: string, port?: number): Promise<PreviewInstance> {
    const root = path.resolve(rootDir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`preview root is not a directory: ${root}`);
    if (this.current) this.stop();
    const listenOn = port && port > 0 ? port : 4300 + Math.floor(Math.random() * 500);
    const instance: PreviewInstance = {
      port: listenOn,
      root,
      url: `http://127.0.0.1:${listenOn}/`,
      startedAt: new Date().toISOString(),
      requests: 0,
      server: http.createServer(),
    };
    instance.server = http.createServer((req, res) => {
      PreviewService.serve(root, listenOn, () => {
        instance.requests += 1;
      }, req, res);
    });
    await new Promise<void>((resolve, reject) => {
      instance.server.once("error", reject);
      instance.server.listen(listenOn, "127.0.0.1", () => resolve());
    });
    this.current = instance;
    log.info(`preview: serving ${root} at ${instance.url}`);
    return instance;
  }

  stop(): boolean {
    if (!this.current) return false;
    try {
      this.current.server.close();
    } catch {
      /* ignore */
    }
    log.info("preview: stopped");
    this.current = null;
    return true;
  }
}
