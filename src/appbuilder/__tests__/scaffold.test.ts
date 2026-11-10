import test from "node:test";
import assert from "node:assert/strict";
import { scaffoldFiles } from "../engine.js";

test("web scaffold includes the guide, placeholder and every required verification command", () => {
  const files = scaffoldFiles({ templateId: "web-app", features: [] });
  const paths = new Set(files.map((file) => file.path));
  for (const required of ["LOAM_AGENT_GUIDE.md", "src/pages/Index.tsx", "scripts/link-deps.mjs", "package.json"]) {
    assert.ok(paths.has(required), `${required} is scaffolded`);
  }
  const manifest = JSON.parse(files.find((file) => file.path === "package.json")!.content) as { scripts: Record<string, string> };
  for (const command of ["check", "lint", "typecheck", "build"]) assert.ok(manifest.scripts[command]);
  assert.ok(files.find((file) => file.path === "LOAM_AGENT_GUIDE.md")!.content.includes("file_write_batch"));
  const entry = files.find((file) => file.path === "src/main.tsx")!.content;
  assert.ok(entry.includes(`from "./pages/Index"`));
  assert.ok(!entry.includes(`from "./App"`));
});
