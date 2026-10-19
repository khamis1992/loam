import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcceptanceGuard, explicitUserContract } from "../agent/acceptanceGuard.js";
import { parseAppContract } from "../agent/appVerification.js";
import { runAgent } from "../agent/loop.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import { loadConfig } from "../config.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent } from "../agent/events.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
const baseline = JSON.stringify({ entry: "index.html", scenarios: [{ name: "counter", steps: [{ action: "textExact", selector: "#count", value: "1" }] }] });
const expanded = { ...JSON.parse(baseline), scenarios: Array.from({ length: 12 }, (_,i) => ({ ...JSON.parse(baseline).scenarios[0], name: `case ${i}` })) };
assert.equal(parseAppContract(JSON.stringify(expanded)).scenarios.length,12);
assert.throws(()=>parseAppContract(JSON.stringify({...expanded,scenarios:[...expanded.scenarios,expanded.scenarios[0]]})),/1–12/);
const commands = ["احفظ app-verification.json بهذا العقد بالضبط:", "احفظ عقد الاختبار التالي دون تغيير:", "Save app-verification.json with exactly this contract:"];
for (const command of commands) {
  assert.equal(explicitUserContract(`${command} ${baseline}.\nContinue`), baseline);
  assert.equal(explicitUserContract(`${command}\n\`\`\`json\n${baseline}\n\`\`\``), baseline);
  assert.throws(() => explicitUserContract(`${command} {"entry":`), /invalid|budget/);
  assert.throws(() => explicitUserContract(`${command} not JSON`), /JSON/);
}
assert.equal(explicitUserContract(`Here is an example: ${commands[2]} ${baseline}`), undefined);
for (const fence of ["```", "~~~~", "````"]) {
  assert.equal(explicitUserContract(`Review this example:\n${fence}text\n${commands[2]} ${baseline}\n${fence}`),undefined);
  assert.equal(explicitUserContract(`Example:\n${fence}\n${commands[2]} ${baseline}\n${fence}\n${commands[0]} ${baseline}`),baseline);
}
assert.equal(explicitUserContract(`> ${commands[2]} ${baseline}`),undefined);
assert.throws(() => explicitUserContract(`${commands[0]} ${baseline}\n${commands[1]} ${baseline}`), /Multiple/);
assert.equal(new AcceptanceGuard(baseline, "Continue").snapshot(), baseline);

for (const mode of ["direct", "trivial", "planned"] as const) {
  const cfg = loadConfig(); cfg.workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-user-contract-"));
  const file = path.join(cfg.workspace,"app-verification.json");
  const prompt = `${commands[0]} ${baseline}`;
  const guard = new AcceptanceGuard(undefined,prompt);
  assert.equal(guard.snapshot(), baseline, "user contract freezes before files exist");
  assert.throws(() => guard.check(cfg.workspace), /Frozen acceptance/);
  fs.writeFileSync(file,baseline); guard.check(cfg.workspace);
  fs.unlinkSync(file);
  const client = { chat: async (o: ChatOptions) => {
    const system = o.messages[0]?.content ?? "";
    let content: string;
    if (system.includes("planner role")) content = JSON.stringify({ goal: "counter", trivial: mode === "trivial", steps: [{ id:"s1",title:"counter",instruction:"create",successCriteria:"count one" }] });
    else if (system.includes("ONE executed plan step")) content = '{"verdict":"pass","reason":"fixture","fixes":[]}';
    else {
      assert.ok(!system.includes("COMPLETED task as a whole"),"first weakened artifact must fail before final model judgment");
      fs.writeFileSync(file,baseline.replace('"value":"1"','"value":"0"'));
      content = "Done";
    }
    return { model:"fixture",content,toolCalls:[],usage:{promptTokens:1,completionTokens:1,durationMs:1} };
  } } as unknown as OllamaClient;
  const events: AgentEvent[] = []; const checkpoints: ExecutionCheckpoint[] = [];
  const options = {cfg,ollama:client,tools:new ToolRegistry(),prompt,emit:(e:AgentEvent)=>events.push(e)};
  await assert.rejects(mode === "direct" ? runAgent(options) : runOrchestratedAgent({...options,saveCheckpoint:c=>checkpoints.push(c)}),/Frozen acceptance/);
  assert.ok(!events.some(e=>e.type === "done" || e.type === "assistant_message"));
  if (mode !== "direct") {
    assert.ok(checkpoints.length);
    assert.ok(checkpoints.every(c=>c.acceptanceContract===baseline));
    const resumed = new AcceptanceGuard(JSON.parse(JSON.stringify(checkpoints.at(-1))).acceptanceContract,"Continue");
    assert.throws(()=>resumed.check(cfg.workspace),/Frozen acceptance/);
  }
  console.log(`PASS ${mode}: user criteria cannot be weakened before first verification`);
}
