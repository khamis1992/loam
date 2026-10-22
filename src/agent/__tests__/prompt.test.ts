/**
 * D17: the environment-issue rule must be part of the agent system prompt when
 * the `report_environment_issue` tool is available, and must stay out when it is
 * not (ask mode, for example).
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

  it("omits the rule when the tool is not available", () => {
    const prompt = buildSystemPrompt(cfg, [], ["file_read"]);
    assert.ok(!prompt.includes("report_environment_issue"));
    assert.ok(!/rely on CI/i.test(prompt));
  });
});
