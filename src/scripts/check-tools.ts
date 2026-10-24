import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, SKILLS_DIR } from "../config.js";
import { createSkillTools } from "../tools/skills.js";
import { createFrontierBridgeTools, getFrontierBridgeStatus } from "../tools/frontierBridge.js";

/** Offline check of the self-improvement tools (skill_create/list/view/patch + traversal safety). */
async function main(): Promise<void> {
  const applied: string[] = [];
  const tools = createSkillTools({ onApply: (label) => applied.push(label) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.run(args, { cfg: {} as never, workspace: ROOT, emit: () => {} });
  };

  const results: Record<string, unknown> = {};
  const created = await call("skill_create", {
    name: "test-skill",
    description: "Used for the offline self-improvement check.",
    content: "# test-skill\n\n## When to Use\n- never (test)\n\n## Procedure\n1. step one\n\n## Verification\n- check output",
  });
  results.create = created.ok;
  results.notified = [...applied];

  const listed = await call("skill_list", {});
  results.list_has_test = listed.content.includes("test-skill");

  const viewed = await call("skill_view", { name: "test-skill" });
  results.view_has_body = viewed.content.includes("step one");

  const patched = await call("skill_patch", { name: "test-skill", old_string: "step one", new_string: "step one (patched)" });
  results.patch = patched.ok;

  const reViewed = await call("skill_view", { name: "test-skill" });
  results.patch_applied = reViewed.content.includes("step one (patched)");

  const dup = await call("skill_create", { name: "test-skill", description: "x", content: "x" });
  results.duplicate_rejected = dup.ok === false;

  const evil = await call("skill_create", { name: "../evil", description: "x", content: "x" });
  results.traversal_neutralized =
    evil.ok === true &&
    fs.existsSync(path.join(SKILLS_DIR, "evil")) &&
    !fs.existsSync(path.join(path.dirname(SKILLS_DIR), "evil"));

  // Frontier Runtime Bridge verification (manus.im/manus-local/core <-> Desktop/manus-local)
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "manus-frontier-bridge-"));
  try {
    const fStatus = await getFrontierBridgeStatus(tmpWs);
    results.frontier_bridge_available = fStatus.available;
    results.frontier_modes_count = fStatus.modesCount;
    const fTools = createFrontierBridgeTools();
    const officeTool = fTools.find((t) => t.name === "office_craft");
    // cr-05: office_craft is the Craft-apps driver, so its schema must expose the
    // app and action surface (while still carrying the untouched war_room engine).
    const officeProps =
      (officeTool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const appEnum = (officeProps["app"] as { enum?: string[] } | undefined)?.enum ?? [];
    const actionEnum = (officeProps["action"] as { enum?: string[] } | undefined)?.enum ?? [];
    results.frontier_office_apps = ["docs", "sheets", "slides", "photo", "design"].every(
      (app) => appEnum.includes(app),
    );
    results.frontier_office_actions = [
      "open",
      "state",
      "commands",
      "execute",
      "batch",
      "export",
      "undo",
      "redo",
    ].every((action) => actionEnum.includes(action));
    const warRes = officeTool
      ? await officeTool.run(
          { engine: "war_room", title: "خطة التحول إلى Frontier", outDir: "war-out" },
          { cfg: {} as never, workspace: tmpWs, emit: () => {} },
        )
      : { ok: false, content: "" };
    results.frontier_war_room = warRes.ok && warRes.content.includes("UNANIMOUS_APPROVAL");
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  const pass =
    results.create === true &&
    results.list_has_test === true &&
    results.view_has_body === true &&
    results.patch === true &&
    results.patch_applied === true &&
    results.duplicate_rejected === true &&
    results.traversal_neutralized === true &&
    results.frontier_bridge_available === true &&
    results.frontier_office_apps === true &&
    results.frontier_office_actions === true &&
    results.frontier_war_room === true;
  results.PASS = pass;
  fs.rmSync(path.join(SKILLS_DIR, "test-skill"), { recursive: true, force: true });
  fs.rmSync(path.join(SKILLS_DIR, "evil"), { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 1));
  if (!pass) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(`tools check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
