import fs from "node:fs";
import path from "node:path";

const source = process.env.LAW_FILE;
if (!source) throw new Error("LAW_FILE is required");
const root = path.resolve("integration/kit");
const markdown = fs.readFileSync(source, "utf8");
const pattern = /^#### `([^`]+)`[^\n]*\n\n```[^\n]*\n([\s\S]*?)\n```/gm;
let count = 0;
for (const match of markdown.matchAll(pattern)) {
  const heading = match[1];
  const body = match[2];
  let relative;
  if (/^src\/legal\//.test(heading) || [
    "src/tools/legalTools.ts",
    "src/tools/__tests__/legalTools.test.ts",
    "src/server/routes/legal.ts",
    "src/server/routes/__tests__/legal.test.ts",
    "src/scripts/legal-mock-server.ts",
    "electron/legal-key.cjs",
  ].includes(heading) || /^skills\/qatar-/.test(heading)) {
    relative = heading;
  } else if (/^packages\/web\/src\/(?:services\/legalApi\.ts|components\/legal\/)/.test(heading)) {
    relative = path.join("web", heading.slice("packages/web/".length));
  } else if (heading.startsWith("web/src/i18n/legal.i18n.json")) {
    relative = "web/src/i18n/legal.i18n.json";
  }
  if (!relative) continue;
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${body}\n`, "utf8");
  count++;
}
console.log(`Extracted ${count} reference files to ${root}`);
