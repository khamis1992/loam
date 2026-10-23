/**
 * D17: the environment-issue rule must be part of the agent system prompt when
 * the `report_environment_issue` tool is available, and must stay out when it is
 * not (ask mode, for example).
 *
 * Note: the always-on master-prompt tool catalog (§6.1) names the tool
 * unconditionally by design — it lists every real registered tool and tells the
 * model a tool not in its available list is simply not enabled. So the tool
 * *name* may appear even when the tool is not callable; what must be gated by
 * tool availability is the guidance *rule* itself.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { buildSystemPrompt } from "../prompt.js";
import type { Config } from "../../config.js";

const cfg = {
  workspace: "/tmp/task",
  policy: { networkEnabled: false },
} as unknown as Config;

describe("environment-issue prompt rule", () => {
  it("names report_environment_issue when the tool is available", () => {
    const prompt = buildSystemPrompt(cfg, [], ["report_environment_issue"]);
    assert.match(prompt, /report_environment_issue/);
    assert.match(prompt, /local environment/i);
    assert.match(prompt, /rely on CI/i);
    assert.match(prompt, /Do not report the step as passed/i);
  });

  it("omits the guidance rule when the tool is not available", () => {
    const prompt = buildSystemPrompt(cfg, [], ["file_read"]);
    assert.ok(!/rely on CI/i.test(prompt));
    assert.ok(!/Do not report the step as passed/i.test(prompt));
    assert.ok(!/When a step cannot run because of the local environment/i.test(prompt));
  });
});
