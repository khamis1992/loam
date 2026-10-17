import { applySkill, createSkillTools } from "../tools/skills.js";
import { listPending, removePending, writeGate } from "../server/pending.js";

/** Runtime smoke test for the self-improvement loop:
 *  direct skill tools + the write-approval gate (stage -> pending -> approve). */
async function main(): Promise<void> {
  const tools = new Map(createSkillTools().map((t) => [t.name, t]));
  const ctx = {} as never;
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool: ${name}`);
    return tool.run(args, ctx);
  };

  const checks: Array<[string, boolean]> = [];

  const before = await call("skill_list");
  console.log(`skill_list -> ${before.ok ? "ok" : "FAIL"}`);

  const created = await call("skill_create", {
    name: "selfimprove-smoke",
    description: "Temporary skill created by the self-improve smoke test.",
    content: "# Smoke\n\n## Procedure\n1. step one\n",
  });
  checks.push(["create", created.ok]);

  const view = await call("skill_view", { name: "selfimprove-smoke" });
  checks.push(["view body", view.content.includes("step one")]);

  const patched = await call("skill_patch", {
    name: "selfimprove-smoke",
    old_string: "step one",
    new_string: "step two",
  });
  checks.push(["patch", patched.ok]);

  const view2 = await call("skill_view", { name: "selfimprove-smoke" });
  checks.push(["patch applied", view2.content.includes("step two")]);

  const deleted = await call("skill_delete", { name: "selfimprove-smoke" });
  checks.push(["delete", deleted.ok]);
  const gone = await call("skill_view", { name: "selfimprove-smoke" });
  checks.push(["deleted is gone", !gone.ok]);

  // ---- write-approval gate: staged writes must NOT hit disk until approved ----
  const gated = new Map(createSkillTools({ gate: writeGate }).map((t) => [t.name, t]));
  const staged = await gated.get("skill_create")!.run(
    { name: "gate-smoke", description: "gated", content: "# Gated\n\nbody\n" },
    ctx,
  );
  checks.push(["staged create reports staging", staged.ok && staged.content.includes("staged")]);

  const pending = listPending().find((p) => p.summary.includes("gate-smoke"));
  checks.push(["pending item recorded", Boolean(pending)]);

  const notYet = await call("skill_view", { name: "gate-smoke" });
  checks.push(["not applied before approval", !notYet.ok]);

  const applied = pending ? applySkill("skill_create", pending.payload) : { ok: false, content: "no pending" };
  checks.push(["approve applies the write", applied.ok]);

  const nowThere = await call("skill_view", { name: "gate-smoke" });
  checks.push(["applied after approval", nowThere.ok]);

  await call("skill_delete", { name: "gate-smoke" });
  if (pending) removePending(pending.id);

  console.log("");
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const allOk = checks.every(([, ok]) => ok);
  console.log(`\nself-improve loop: ${allOk ? "PASS" : "FAIL"}`);
  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
