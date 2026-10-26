/**
 * C5: attribute names. gen_ai.* follow the OpenTelemetry GenAI semantic
 * conventions (the same names MAF writes, observability.py:231-241);
 * loam.* are Loam's own.
 */
export const GENAI = {
  operation: "gen_ai.operation.name",
  system: "gen_ai.system",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  temperature: "gen_ai.request.temperature",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  finishReasons: "gen_ai.response.finish_reasons",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  agentName: "gen_ai.agent.name",
  conversationId: "gen_ai.conversation.id",
} as const;

export const LOAM = {
  taskId: "loam.task_id",
  stepId: "loam.step_id",
  round: "loam.round",
  contract: "loam.contract",
  contractAttempts: "loam.contract.attempts",
  stallCount: "loam.ledger.stall_count",
  ledgerDecision: "loam.ledger.decision",
  checkpointId: "loam.checkpoint_id",
  interruptId: "loam.interrupt_id",
  candidateCount: "loam.selection.candidates",
  selectedId: "loam.selection.selected",
  guardScore: "loam.guard.score",
  costCredits: "loam.cost.credits",
  inputChars: "loam.input.chars",
  inputHash: "loam.input.sha256_12",
  outputChars: "loam.output.chars",
  outputHash: "loam.output.sha256_12",
  swarmRunId: "loam.swarm.run_id",
  swarmWorkerId: "loam.swarm.worker_id",
  swarmWorkLabel: "loam.swarm.work_label",
  swarmTurn: "loam.swarm.turn",
} as const;

/** Span names. One name per operation kind keeps the trace view groupable. */
export const SPAN = {
  run: "loam.run",
  plan: "loam.plan",
  step: "loam.step",
  modelCall: "gen_ai.chat",
  toolCall: "gen_ai.execute_tool",
  ledger: "loam.ledger",
  replan: "loam.replan",
  verify: "loam.verify",
  interrupt: "loam.interrupt",
  delegate: "gen_ai.invoke_agent",
  select: "loam.select",
  workflowNode: "loam.workflow.node",
  swarmRun: "loam.swarm.run",
  swarmWorker: "loam.swarm.worker",
  swarmTurn: "loam.swarm.turn",
  swarmMerge: "loam.swarm.merge",
} as const;
