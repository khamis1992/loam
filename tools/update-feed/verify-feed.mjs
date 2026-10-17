// End-to-end verification of the private update feed kit:
// build a dummy installer -> write latest.yml -> serve it -> fetch both ->
// verify electron-updater could accept the payload (sha512 + size match).
//
//   node tools/verify-feed.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { writeLatestYml, parseLatestYml, createFeedServer, sha512Base64 } from "./feed-lib.mjs";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}` + (detail ? `  -> ${detail}` : ""));
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "manus-feed-"));
const feedDir = path.join(work, "feed");
fs.mkdirSync(feedDir, { recursive: true });

// A stand-in installer (real bytes so sha512/size are meaningful).
const setupName = "Manus-Studio-Setup-9.9.9.exe";
const setupPath = path.join(feedDir, setupName);
fs.writeFileSync(setupPath, crypto.randomBytes(2 * 1024 * 1024));

const version = "9.9.9";
writeLatestYml({ installerPath: setupPath, version, outDir: feedDir, releaseDate: "2026-10-15T00:00:00.000Z" });
check("latest.yml is written", fs.existsSync(path.join(feedDir, "latest.yml")));

const { url, close } = await createFeedServer({ dir: feedDir, log: () => {} });

try {
  const ymlRes = await fetch(`${url}/latest.yml`);
  const ymlText = await ymlRes.text();
  const yml = parseLatestYml(ymlText);
  check("feed serves latest.yml", ymlRes.ok && ymlText.includes("version:"));
  check("latest.yml carries the version", yml.version === version, yml.version);
  check("latest.yml names the installer", yml.path === setupName, yml.path);
  check("latest.yml lists one file with sha512+size", yml.files.length === 1 && Boolean(yml.files[0].sha512) && Number(yml.files[0].size) === 2 * 1024 * 1024);

  const binRes = await fetch(`${url}/${yml.path}`);
  const buf = Buffer.from(await binRes.arrayBuffer());
  const remote = crypto.createHash("sha512").update(buf).digest("base64");
  check("installer downloads with matching size", buf.length === Number(yml.files[0].size), `${buf.length} bytes`);
  check("installer sha512 matches latest.yml", remote === yml.files[0].sha512 && remote === sha512Base64(setupPath));

  const missing = await fetch(`${url}/nope.exe`);
  check("unknown file returns 404", missing.status === 404, String(missing.status));
} finally {
  await close();
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
