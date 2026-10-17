// Verify a real, already-built release folder against the electron-updater
// contract: serve it, fetch latest.yml, download the installer, and confirm
// the sha512 + size electron-updater would check.
//
//   node tools/verify-release.mjs <releaseDir>

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseLatestYml, createFeedServer } from "./feed-lib.mjs";

const dir = path.resolve(process.argv[2] || ".");
const ymlPath = path.join(dir, "latest.yml");
if (!fs.existsSync(ymlPath)) {
  console.error(`no latest.yml in ${dir}`);
  process.exit(2);
}
const yml = parseLatestYml(fs.readFileSync(ymlPath, "utf8"));
const file = path.join(dir, yml.path);

const { url, close } = await createFeedServer({ dir, log: () => {} });
const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}` + (detail ? `  -> ${detail}` : ""));
};

try {
  const servedYml = await (await fetch(`${url}/latest.yml`)).text();
  check("feed serves latest.yml", servedYml.includes("version:"));

  const res = await fetch(`${url}/${yml.path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
  check("installer is served whole", buf.length === Number(yml.files[0].size), `${buf.length} bytes`);
  check("sha512 matches latest.yml", sha512 === yml.files[0].sha512 && sha512 === yml.sha512);
  check("local file matches too", sha512 === crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64"));
  check("blockmap present (differential updates)", fs.existsSync(file + ".blockmap"));
  console.log(`\nversion=${yml.version}  file=${yml.path}  size=${yml.files[0].size}`);
} finally {
  await close();
}

console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exitCode = checks.every(Boolean) ? 0 : 1;
