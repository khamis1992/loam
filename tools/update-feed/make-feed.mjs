// Generate a `latest.yml` next to an installer, ready to upload to a generic feed.
//
//   node tools/make-feed.mjs <installer.exe> <version> [outDir]
//
// Example:
//   node tools/make-feed.mjs dist/Manus-Studio-Setup-2.1.0.exe 2.1.0 feed

import fs from "node:fs";
import path from "node:path";
import { writeLatestYml, buildLatestYml } from "./feed-lib.mjs";

const [installer, version, outDir = "feed"] = process.argv.slice(2);
if (!installer || !version) {
  console.error("usage: node tools/make-feed.mjs <installer.exe> <version> [outDir]");
  process.exit(2);
}
if (!fs.existsSync(installer)) {
  console.error(`installer not found: ${installer}`);
  process.exit(2);
}
const { ymlPath, yml } = writeLatestYml({ installerPath: installer, version, outDir });
console.log(`wrote ${ymlPath}`);
console.log(yml);
