import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSwarmTools, serviceBase, setServiceBaseUrl } from "../serviceBridgeTools.js";

describe("service bridge port", () => {
  it("uses the injected server URL and does not guess 3939", async () => {
    setServiceBaseUrl("");
    const previous = process.env.MANUS_LOCAL_PORT;
    const previousLoam = process.env.LOAM_PORT;
    delete process.env.MANUS_LOCAL_PORT;
    delete process.env.LOAM_PORT;
    try {
      assert.equal(serviceBase(), "");
      const tool = createSwarmTools().find((item) => item.name === "swarm_status")!;
      const result = await tool.run({}, { workspace: "", cfg: {} as never, emit: () => undefined });
      assert.equal(result.ok, false);
      assert.match(result.content, /not configured/);
      assert.equal(result.content.includes("3939"), false);
      setServiceBaseUrl("http://127.0.0.1:8787");
      assert.equal(serviceBase(), "http://127.0.0.1:8787");
      const original = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const href = String(url);
        if (href.endsWith("/api/swarm/runs")) {
          return { ok: true, json: async () => ({ runs: [{ id: "swarm_11111111-1111-1111-1111-111111111111" }] }) } as Response;
        }
        return { ok: true, json: async () => ({ run: { status: "running", stage: "plan", nodes: [] } }) } as Response;
      };
      try {
        const newest = await tool.run({ runId: "" }, { workspace: "", cfg: {} as never, emit: () => undefined });
        assert.equal(newest.ok, true, newest.content);
        assert.match(newest.content, /running/);
      } finally {
        globalThis.fetch = original;
        setServiceBaseUrl("");
      }
    } finally {
      if (previous === undefined) delete process.env.MANUS_LOCAL_PORT;
      else process.env.MANUS_LOCAL_PORT = previous;
      if (previousLoam === undefined) delete process.env.LOAM_PORT;
      else process.env.LOAM_PORT = previousLoam;
    }
  });
});
