import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createSitePackTools } from "../build/tools.js";
import { decideApproval, listApprovals } from "../../server/approvals.js";
import { readPackProject } from "../present.js";
import type { Tool, ToolContext } from "../../tools/registry.js";
import type { AgentEvent } from "../../agent/events.js";

function context(workspace: string, events: AgentEvent[]): ToolContext {
  return { cfg: { model: "test" } as never, workspace, taskId: "task_restaurant", packId: "loam-build", emit: (event) => events.push(event) };
}

describe("loam-build service pack", () => {
  it("verifies a restaurant site and never deploys before a human decision", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-build-a4-"));
    try {
      const events: AgentEvent[] = [];
      let deployCalls = 0;
      const tools = new Map(createSitePackTools({
        approvalTimeoutMs: 2_000,
        deploy: async () => {
          deployCalls += 1;
          return { ok: true, content: JSON.stringify({ url: "http://127.0.0.1:4000", target: "local" }) };
        },
      }).map((tool) => [tool.name, tool]));
      assert.equal(tools.has("web_scaffold"), false, "pack wraps rather than duplicates the legacy tool");
      const ctx = context(workspace, events);
      const initialized = await tools.get("site_init")!.run({ title: "مطعم الديوانية", scaffold: false }, ctx);
      assert.equal(initialized.ok, true, initialized.content);
      fs.writeFileSync(path.join(workspace, "index.html"), "<html dir=\"rtl\"><head><title>مطعم الديوانية</title></head><body><main><h1>مطعم الديوانية</h1><p>مأكولات كويتية وحجز الطاولات</p></main></body></html>");
      const checkpoint = await tools.get("site_checkpoint")!.run({}, ctx);
      assert.equal(checkpoint.ok, true, checkpoint.content);
      assert.match(checkpoint.content, /gitCommitCreated":false/);
      assert.equal(readPackProject(workspace, "loam-build")?.items[0]?.state, "final");

      const secretRequest = await tools.get("site_secrets_request")!.run({ names: ["API_KEY"] }, ctx);
      assert.match(secretRequest.content, /app-builder-settings/);
      assert.doesNotMatch(secretRequest.content, /DO_NOT_LOG|sk-live/);

      const deniedPromise = tools.get("site_publish_request")!.run({ target: "local" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(deployCalls, 0);
      const deniedApproval = listApprovals(true).find((approval) => approval.tool === "site_publish_request");
      assert.ok(deniedApproval);
      decideApproval(deniedApproval.id, "deny");
      const denied = await deniedPromise;
      assert.equal(denied.ok, false);
      assert.equal(deployCalls, 0);

      const approvedPromise = tools.get("site_publish_request")!.run({ target: "local" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(deployCalls, 0);
      const approval = listApprovals(true).find((candidate) => candidate.tool === "site_publish_request");
      assert.ok(approval);
      decideApproval(approval.id, "approve");
      const approved = await approvedPromise;
      assert.equal(approved.ok, true, approved.content);
      assert.equal(deployCalls, 1);
      assert.equal(events.filter((event) => event.type === "artifact_published").length, 1);
      assert.equal(events.some((event) => event.type === "done"), false);

      const attached = await tools.get("site_attach")!.run({}, ctx);
      assert.equal(attached.ok, true);
      assert.equal(readPackProject(workspace, "loam-build")?.items.length, 1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
