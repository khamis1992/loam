import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createSecurityTools, setServiceBaseUrl } from "../serviceBridgeTools.js";
import type { ToolContext } from "../registry.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setServiceBaseUrl("");
});

describe("security_assess", () => {
  it("starts an authorized header assessment on the task workspace", async () => {
    setServiceBaseUrl("http://127.0.0.1:3971");
    let seenUrl = "";
    let seenBody = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ run: { id: "run_1" } }), { status: 202 });
    }) as typeof fetch;
    const tool = createSecurityTools().find((item) => item.name === "security_assess")!;
    const result = await tool.run(
      { target: "http://127.0.0.1:3000" },
      { workspace: "C:/tmp", taskId: "task_1", emit() {} } as unknown as ToolContext,
    );
    assert.equal(result.ok, true, result.content);
    assert.match(seenUrl, /\/api\/security\/assessments\?taskId=task_1$/);
    const body = JSON.parse(seenBody) as { target: string; authorized: boolean; checks: string[] };
    assert.equal(body.target, "http://127.0.0.1:3000");
    assert.equal(body.authorized, true);
    assert.ok(body.checks.includes("security_headers"));
    assert.match(result.content, /run_1/);
  });
});
