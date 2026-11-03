/**
 * C7: Loam's real ports behind the workflow engine. Each agent node is a
 * normal orchestrated sub-run (plans, critique, ledger, tracing and final
 * verification all apply); tools go through the same ToolRegistry and policy
 * gates as the agent loop; human nodes use the durable interrupt store.
 */
import type { WorkflowPorts, NodeContext } from "./engine.js";
import { runOrchestratedAgent, type OrchestratorOptions } from "../../agent/orchestrator.js";
import { createInterrupt } from "../durable/interrupts.js";
import { callStructured } from "../contracts/structured.js";
import { selectWithCore } from "../public.js";
import { loadWorkflow } from "./store.js";
import type { OrchestrationCore } from "../core.js";

export function loamWorkflowPorts(core: OrchestrationCore, base: OrchestratorOptions): WorkflowPorts {
  return {
    // Each agent node is a normal orchestrated sub-run in the node's mode, so plans,
    // critique, ledger, tracing and verification all apply to it. A failed sub-run
    // throws; the engine's node catch turns that into a failed node.
    runAgent: async (node, prompt, ctx: NodeContext) => {
      const res = await runOrchestratedAgent({
        ...base,
        prompt,
        taskId: `${ctx.taskId}:${node.id}`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(node.agent?.model ? { model: node.agent.model } : {}),
        ...(node.agent?.maxSteps !== undefined ? { maxSteps: node.agent.maxSteps } : {}),
      });
      // An outputSchema turns the sub-run's final text into the declared JSON on a
      // cloud model; without one (or without a cloud judge) the text is the output.
      if (node.agent?.outputSchema) {
        const model = core.modelFor("judge");
        if (model) {
          const structured = await callStructured<{ value: unknown }>(core.port, {
            model,
            contract: `workflow_node:${node.id}`,
            schema: node.agent.outputSchema,
            messages: [{ role: "user", content: `Convert this answer into the declared schema:\n\n${res.text.slice(0, 20_000)}` }],
            repairAttempts: core.cfg.contracts.repairAttempts,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (structured.ok) return { ok: true, text: res.text, output: structured.value };
        }
      }
      return { ok: true, text: res.text };
    },
    // Tools run through the same ToolRegistry and policy gates as the agent loop.
    runTool: async (name, args, ctx: NodeContext) => {
      const r = await base.tools.exec(name, args, {
        cfg: base.cfg,
        workspace: base.cfg.workspace ?? "",
        emit: base.emit,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      });
      return { ok: r.ok, content: r.content };
    },
    askHuman: (node, ctx: NodeContext) =>
      createInterrupt({
        taskId: ctx.taskId,
        kind: "workflow_human",
        payload: { nodeId: node.id, title: node.human?.title, question: node.human?.question, options: node.human?.options },
        responseSchema: node.human?.options?.length ? { enum: node.human.options } : { type: "string", maxLength: 4000 },
        ttlMs: node.human?.ttlMs ?? core.cfg.interrupts.defaultTtlMs,
        maxPendingPerTask: core.cfg.interrupts.maxPendingPerTask,
      }).interruptId,
    select: (goal, candidates) => selectWithCore(core, goal, candidates),
    loadWorkflow,
    emit: (ev) => base.emit(ev),
  };
}
