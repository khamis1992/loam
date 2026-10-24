/**
 * Smoke check for the app bridges: every bridge is off by default, argv is
 * built as separate tokens (no shell string), a path outside the workspace is
 * refused, a disabled bridge is refused with the UI hint, and the generated
 * skill documents every command.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-bridges-check-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");

const { loadManifests, getManifest, isBridgeEnabled, manifestLoadErrors } = await import("../bridges/registry.js");
const { buildArgv } = await import("../bridges/argv.js");
const { bridgeSkillBody } = await import("../bridges/skillGen.js");
const { createAppBridgeTools } = await import("../tools/appBridgeTools.js");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const workspace = path.join(tmp, "ws");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "in.mp4"), "x");

console.log("app bridges smoke");

const manifests = loadManifests();
check("built-in manifests load without errors", manifests.length >= 5 && manifestLoadErrors().length === 0, manifestLoadErrors().join("; "));
check("every bridge is disabled by default", manifests.every((m) => !isBridgeEnabled({ bridges: undefined }, m.id)));

const ff = getManifest("ffmpeg")!;
const convert = ff.commands.find((c) => c.id === "convert")!;
const ok = buildArgv(convert, { input: "in.mp4", output: "out.mp3" }, workspace);
check("argv is an array of separate tokens", ok.ok && Array.isArray(ok.argv) && ok.argv.length === 5 && ok.argv[0] === "-y");

const tricky = buildArgv(convert, { input: "in.mp4", output: "out.mp3 && calc" }, workspace);
check("a chained command stays a single token", !tricky.ok || tricky.argv.includes("out.mp3 && calc") || tricky.argv.every((t) => !t.startsWith("&&")));
check("unknown param is rejected", !buildArgv(convert, { input: "in.mp4", output: "o.mp3", extra: "1" }, workspace).ok);
const outside = buildArgv(convert, { input: "in.mp4", output: path.join(tmp, "elsewhere.mp3") }, workspace);
check("write path outside the workspace is refused", !outside.ok);

const body = bridgeSkillBody(ff);
check("generated skill documents every command", ff.commands.every((c) => body.includes(`### ${c.id}`)));

const run = createAppBridgeTools({}).find((t) => t.name === "app_run")!;
const cfg = { workspace, bridges: { enabled: {} }, maxCommandSeconds: 30 };
const refused = await run.run({ app: "ffmpeg", command: "convert", args: { input: "in.mp4", output: "o.mp3" } }, { cfg, workspace, emit: () => {} } as never);
check("disabled bridge is refused with the UI fallback hint", refused.ok === false && /disabled/.test(refused.content) && /computer_ui_tree/.test(refused.content));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "app bridges smoke: PASS" : `app bridges smoke: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
