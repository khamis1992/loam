// Shared helpers for a generic electron-updater feed (provider: "generic").
// Produces the exact `latest.yml` shape electron-updater 6.x expects and can
// serve it over HTTP for self-hosting or local testing.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

// Electron-updater's `latest.yml` (schema used by provider: generic).
export function buildLatestYml({ installerPath, version, releaseDate }) {
  const file = path.basename(installerPath);
  const size = fs.statSync(installerPath).size;
  const sha512 = sha512Base64(installerPath);
  const iso = releaseDate || new Date().toISOString();
  return [
    `version: ${version}`,
    `files:`,
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${iso}'`,
    ``,
  ].join("\n");
}

export function writeLatestYml({ installerPath, version, outDir, releaseDate }) {
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, path.basename(installerPath));
  if (path.resolve(dest) !== path.resolve(installerPath)) fs.copyFileSync(installerPath, dest);
  const yml = buildLatestYml({ installerPath: dest, version, releaseDate });
  const ymlPath = path.join(outDir, "latest.yml");
  fs.writeFileSync(ymlPath, yml, "utf8");
  return { ymlPath, installer: dest, yml };
}

// Minimal parser for the keys we generate (enough to verify a feed).
export function parseLatestYml(text) {
  const out = { files: [] };
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("  - ")) {
      current = {};
      out.files.push(current);
      const [k, ...v] = line.slice(4).split(":");
      current[k.trim()] = v.join(":").trim();
      continue;
    }
    if (line.startsWith("    ") && current) {
      const idx = line.indexOf(":");
      const k = line.slice(0, idx).trim();
      current[k] = line.slice(idx + 1).trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      if (k === "files" && v === "") continue; // list header, items follow
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  }
  return out;
}

const TYPES = {
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".exe": "application/octet-stream",
  ".blockmap": "application/octet-stream",
  ".zip": "application/zip",
  ".dmg": "application/octet-stream",
};

export function createFeedServer({ dir, host = "127.0.0.1", port = 0, log = console.log }) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    if (!name || name.includes("..")) {
      res.writeHead(400).end("bad request");
      return;
    }
    const abs = path.join(root, name);
    if (!abs.startsWith(root) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const stat = fs.statSync(abs);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size,
      "accept-ranges": "bytes",
    });
    fs.createReadStream(abs).pipe(res);
    log(`GET /${name} (${stat.size} bytes)`);
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      const close = () =>
        new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        });
      resolve({ server, port: actual, url: `http://${host}:${actual}`, close });
    });
  });
}
