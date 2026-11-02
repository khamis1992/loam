import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getLoamMode } from "../../modes/catalog.js";
import { ALWAYS_ON_TOOLS, mergeAlwaysOnTools } from "../runTools.js";

const GENERATORS = ["web_scaffold", "video_studio", "design_create", "loam_design", "deploy_app", "export_build", "scaffold_backend", "video_edit"];

describe("always-on generators", () => {
  it("keeps site and media generators off every non-owning mode", () => {
    for (const name of GENERATORS) assert.equal(ALWAYS_ON_TOOLS.includes(name), false, name);
    for (const id of ["write", "data", "media", "research", "legal", "security"]) {
      const allow = mergeAlwaysOnTools({
        resolvedAllow: getLoamMode(id).tools,
        registeredTools: [...getLoamMode(id).tools, ...ALWAYS_ON_TOOLS, "web_scaffold"],
      });
      if (id !== "media") assert.equal(allow.includes("web_scaffold"), false, id);
    }
    assert.equal(getLoamMode("build").tools.includes("web_scaffold"), true);
    assert.equal(getLoamMode("media").tools.includes("video_studio"), true);
  });
});
