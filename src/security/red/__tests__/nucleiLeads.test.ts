/** Recon-lead to nuclei template selection wiring tests (§6.6). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createAuthorizationRecord } from "../gate.js";
import { redTransport } from "../transport.js";
import { RedAuditLog } from "../audit.js";
import { templatesCapability, selectTemplateIds } from "../templates.js";
import type { RedCapabilityContext, RedHypothesis } from "../orchestrator/redOrchestrator.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-nuclei-leads-"));

describe("nuclei template ids from recon leads", () => {
  it("forwards exact template ids to the bridge (-id, not -tags)", async () => {
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [3000], allowUrlPrefixes: [], denyAlways: [] },
    });
    let seen: Record<string, unknown> = {};
    const ctx: RedCapabilityContext = {
      authz,
      transport: redTransport(authz),
      bridge: async (_id, _cmd, args) => {
        seen = args;
        return { ok: true, exitCode: 0, timedOut: false, text: "" };
      },
      audit: new RedAuditLog(tempRoot()),
    };
    const cap = templatesCapability();
    const hyp: RedHypothesis = { id: "HYP-CVE", capability: "red.templates", target: "http://127.0.0.1:3000/", claim: "Known CVE", params: { ids: "cve-2024-4577" } };
    await cap.validate(hyp, ctx);
    assert.equal(seen.ids, "cve-2024-4577");
    assert.deepEqual(
      selectTemplateIds([{ cveId: "CVE-2024-4577", source: "kev", reason: "known exploited" }]),
      ["cve-2024-4577"],
    );
  });

  it("reads severity and name from nuclei's nested info object", async () => {
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [3000], allowUrlPrefixes: [], denyAlways: [] },
    });
    const ctx: RedCapabilityContext = {
      authz,
      transport: redTransport(authz),
      bridge: async () => ({
        ok: true,
        exitCode: 0,
        timedOut: false,
        text: JSON.stringify({ "template-id": "loam-lab", "matched-at": "http://127.0.0.1:3000/nuclei-test", info: { name: "Planted", severity: "high" } }) + "\n",
      }),
      audit: new RedAuditLog(tempRoot()),
    };
    const cap = templatesCapability({ severity: "high" });
    const hyp: RedHypothesis = { id: "HYP-INFO", capability: "red.templates", target: "http://127.0.0.1:3000/", claim: "Nested info" };
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "confirmed");
    assert.equal(validation.finding!.severity, "high");
    assert.equal(validation.finding!.title, "Planted");
  });
});
