// Self-contained offline build for the bundled design-eval fixture site.
// Copies the static assets into dist/ so the eval harness can verify a build
// artifact without network access or third-party dependencies.
import fs from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

for (const file of ["index.html", "globals.css", "app.js"]) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}

console.log("built dist/index.html");
