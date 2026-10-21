#!/usr/bin/env node
// Local test feed for the Loam desktop updater (option #10, manual testing
// only — this never publishes anything).
//
// Serves a generic electron-updater feed (latest.yml + the NSIS installer it
// references) from a folder on 127.0.0.1:
//
//   node scripts/updater-test-feed.mjs [--dir release] [--port 8788]
//                                      [--installer <path>] [--version x.y.z]
//
// If the folder has no latest.yml, one is generated: from --installer when
// given, otherwise from the newest Loam-Setup-*.exe in the folder, otherwise a
// dummy installer so the client has something to "download".
//
// Then start the app against it (unpackaged dev builds need the dev flag):
//
//   LOAM_UPDATE_FEED_URL=http://127.0.0.1:8788/
//   MANUS_LOCAL_DEV_UPDATE=1 npm run desktop

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(arg("dir", path.join(root, "release")));
const port = Number(arg("port", process.env.LOAM_UPDATE_FEED_PORT || 8788));
fs.mkdirSync(dir, { recursive: true });

function bumpPatch(version) {
  const parts = String(version).split(".");
  const patch = Number(parts[2] ?? 0) + 1;
  return [parts[0] ?? "0", parts[1] ?? "0", String(Number.isFinite(patch) ? patch : 0)].join(".");
}

function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function writeLatestYml(installerPath, version) {
  const file = path.basename(installerPath);
  const yml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${file}`,
    `    sha512: ${sha512Base64(installerPath)}`,
    `    size: ${fs.statSync(installerPath).size}`,
    `path: ${file}`,
    `sha512: ${sha512Base64(installerPath)}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "latest.yml"), yml, "utf8");
  return yml;
}

// Reuse an up-to-date feed; (re)generate when missing or when a newer installer appeared.
let installers = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => /^Loam-Setup-.*\.(exe|zip)$/i.test(f))
  : [];
const ymlPath = path.join(dir, "latest.yml");
if (!fs.existsSync(ymlPath) || installers.length > 0) {
  const version = arg("version", bumpPatch(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version));
  const explicit = arg("installer", "");
  let installer = explicit ? path.resolve(explicit) : installers.sort().at(-1) ? path.join(dir, installers.sort().at(-1)) : "";
  if (!installer || !fs.existsSync(installer)) {
    // Dummy payload: enough for the client to validate sha512 and download.
    installer = path.join(dir, `Loam-Setup-${version}.exe`);
    fs.writeFileSync(installer, Buffer.from(`Loam test update ${version}\n`.repeat(400)));
    console.log(`[test-feed] wrote dummy installer ${path.basename(installer)}`);
  }
  writeLatestYml(installer, version);
  console.log(`[test-feed] wrote latest.yml (version ${version})`);
}

const TYPES = { ".yml": "text/yaml; charset=utf-8", ".exe": "application/octet-stream", ".blockmap": "application/octet-stream", ".zip": "application/zip" };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  if (!name || name.includes("..")) { res.writeHead(400).end("bad request"); return; }
  const abs = path.join(dir, name);
  if (!abs.startsWith(dir) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    console.log(`[test-feed] MISS /${name}`);
    res.writeHead(404).end("not found");
    return;
  }
  const stat = fs.statSync(abs);
  res.writeHead(200, { "content-type": TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream", "content-length": stat.size });
  fs.createReadStream(abs).pipe(res);
  console.log(`[test-feed] GET /${name} (${stat.size} bytes)`);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[test-feed] serving ${dir}`);
  console.log(`[test-feed] feed url: http://127.0.0.1:${port}/`);
  console.log(`[test-feed] run the app with: LOAM_UPDATE_FEED_URL=http://127.0.0.1:${port}/ MANUS_LOCAL_DEV_UPDATE=1`);
});
