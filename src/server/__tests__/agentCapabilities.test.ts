import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agent-capabilities-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;
process.env.MANUS_LOCAL_SKILLS_DIR = path.join(dir, "skills");
process.env.LOAM_CONFIG = path.join(dir, "config.json");

const agents = await import("../agents.js");
const gateway = await import("../companionGateway.js");
const connectors = await import("../connectors/index.js");
const sqlite = await import("../sqliteStore.js");
const db = await import("../db.js");
const skills = await import("../../tools/skills.js");
const { loadConfig } = await import("../../config.js");

before(() => {
  fs.writeFileSync(path.join(dir, "connectors.json"), JSON.stringify({ github: { connected: true } }));
  fs.writeFileSync(process.env.LOAM_CONFIG!, JSON.stringify({ workspace: dir, memory: { enabled: false } }));
});

after(() => {
  sqlite.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent capability contracts", () => {
  it("persists skills, connector grants and independent memory policy", () => {
    const agent = agents.createAgent({
      name: "Capability Agent",
      enabledSkills: ["release-check", "release-check"],
      connectorGrants: [{ connectorId: "github", accountId: "work", permissions: ["read", "read"] }],
      memoryEnabled: false,
    });
    assert.deepEqual(agent.enabledSkills, ["release-check"]);
    assert.deepEqual(agent.connectorGrants, [{ connectorId: "github", accountId: "work", permissions: ["read"] }]);
    assert.equal(agent.memoryEnabled, false);

    const updated = agents.updateAgent(agent.id, {
      enabledSkills: ["docs"],
      connectorGrants: [],
      memoryEnabled: true,
    });
    assert.deepEqual(updated?.enabledSkills, ["docs"]);
    assert.deepEqual(updated?.connectorGrants, []);
    assert.equal(updated?.memoryEnabled, true);
  });

  it("revokes companion-memory without changing the work mode", () => {
    const capabilities = gateway.resolveCompanionCapabilities({
      mode: "build",
      workMode: "loam",
      memoryEnabled: false,
      registeredTools: [...gateway.COMPANION_DYNAMIC_TOOL_NAMES],
    });
    assert.equal(capabilities.workMode, "loam");
    assert.equal(capabilities.allow.some((name) => name.startsWith("companion_memory_")), false);
    assert.equal(capabilities.services.find((service) => service.id === "companion-memory")?.status, "blocked_workmode");
  });

  it("enforces connector and operation grants instead of sharing every connected tool", () => {
    assert.deepEqual(connectors.connectedConnectorToolNames(undefined, []), []);
    assert.deepEqual(
      connectors.connectedConnectorToolNames(undefined, [{ connectorId: "github", permissions: ["read"] }]).sort(),
      ["github_list_issues", "github_list_repos"].sort(),
    );
    assert.equal(connectors.connectedConnectorToolNames(undefined).includes("github_create_issue"), true);
  });

  it("limits installed skills visible in tool calls to the agent selection", async () => {
    skills.applySkill("skill_create", { name: "allowed-skill", description: "allowed", content: "steps" });
    skills.applySkill("skill_create", { name: "blocked-skill", description: "blocked", content: "steps" });
    const agent = agents.createAgent({ name: "Skill Scoped Agent", enabledSkills: ["allowed-skill"] });
    const task = db.createTask("use skills", "use skills", null, agent.id);
    const tools = skills.createSkillTools();
    const ctx = { cfg: loadConfig(), workspace: dir, emit: () => {}, taskId: task.id };

    const listed = await tools.find((tool) => tool.name === "skill_list")!.run({}, ctx);
    assert.equal(listed.ok, true);
    assert.match(listed.content, /allowed-skill/);
    assert.doesNotMatch(listed.content, /blocked-skill/);
    const blocked = await tools.find((tool) => tool.name === "skill_view")!.run({ name: "blocked-skill" }, ctx);
    assert.equal(blocked.ok, false);
  });
});
