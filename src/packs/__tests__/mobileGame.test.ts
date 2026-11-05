import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createMobilePackTools } from "../mobile/tools.js";
import { createGamePackTools } from "../game/tools.js";
import { saveMobile } from "../../mobile/store.js";
import { getPackManifest } from "../registry.js";
import type { ToolContext } from "../../tools/registry.js";

function context(workspace: string, packId: "loam-mobile" | "loam-game"): ToolContext {
  return { cfg: { model: "test" } as never, workspace, taskId: `task_${packId}`, packId, emit: () => undefined };
}

describe("mobile and game service packs", () => {
  it("publishes a validated screen-based mobile project without claiming a native package", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mobile-pack-"));
    try {
      saveMobile(workspace, {
        version: 1, title: "Focus", accent: "#187665", direction: "ltr",
        screens: [
          { id: "home", title: "Home", kind: "primary", blocks: [{ id: "details-button", type: "button", text: "Open details", target: "details" }] },
          { id: "details", title: "Details", kind: "detail", parentId: "home", blocks: [{ id: "note", type: "input", text: "Note", help: "A short note", placeholder: "Write here" }] },
        ],
      }, 0);
      const tools = new Map(createMobilePackTools().map((tool) => [tool.name, tool]));
      const result = await tools.get("mobile_present")!.run({}, context(workspace, "loam-mobile"));
      assert.equal(result.ok, true, result.content);
      assert.match(result.content, /nativePackage":false/);
      assert.match(result.content, /loam-resource:\/\/loam-mobile\/app\//);
      assert.equal(getPackManifest("loam-mobile").hostTools.includes("mobile_present"), true);
      assert.equal(getPackManifest("loam-mobile").modelTools.includes("mobile_present"), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("publishes a playable canvas game and rejects missing input handling", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-game-pack-"));
    try {
      const tools = new Map(createGamePackTools().map((tool) => [tool.name, tool]));
      fs.writeFileSync(path.join(workspace, "index.html"), "<html><body><canvas id='game'></canvas><script>window.__errors=[];window.onerror=e=>window.__errors.push(String(e));function loop(){requestAnimationFrame(loop)};document.addEventListener('keydown',()=>{});loop();</script></body></html>");
      const result = await tools.get("game_present")!.run({}, context(workspace, "loam-game"));
      assert.equal(result.ok, true, result.content);
      assert.match(result.content, /loam-resource:\/\/loam-game\/page\//);
      assert.equal(getPackManifest("loam-game").hostTools.includes("game_present"), true);

      fs.writeFileSync(path.join(workspace, "index.html"), "<html><body><canvas></canvas><script>requestAnimationFrame(()=>{});window.__errors=[];</script></body></html>");
      const missingInput = await tools.get("game_present")!.run({}, context(workspace, "loam-game"));
      assert.equal(missingInput.ok, false);
      assert.match(missingInput.content, /game_input_missing/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
