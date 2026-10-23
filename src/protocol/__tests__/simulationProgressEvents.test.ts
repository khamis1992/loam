/**
 * Protocol mapping for the MiroFish M3 `simulation_progress` event.
 *
 * Guarantees under test:
 *  - the M3 payload is forwarded as-is (round, arm, metrics, comparison)
 *  - the row is transient (never persisted, never rendered as a chat bubble)
 *  - mapping it does not disturb tool/status mapper state
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { createEventMapperState, mapAgentEvent } from "../events.js";
import type { AgentEvent } from "../../agent/events.js";
import type { ChatEvent, SimulationProgressEvent } from "../types.js";

function asProgressEvent(event: ChatEvent): SimulationProgressEvent {
  assert.equal(event.type, "simulation_progress");
  return event as SimulationProgressEvent;
}

describe("simulation_progress protocol mapping", () => {
  const state = createEventMapperState();

  it("forwards a round milestone payload unchanged", () => {
    const payload = {
      type: "simulation_round",
      sessionId: "sess_1",
      arm: "baseline" as const,
      round: 2,
      totalRounds: 3,
      metrics: { round: 2, arm: "baseline", agentsActed: 12, agentsSkipped: 0, meanIntent: 0.42 },
    };
    const event: AgentEvent = { type: "simulation_progress", sessionId: "sess_1", payload };

    const [chatEvent] = mapAgentEvent(event, state, "sess_1");
    assert.ok(chatEvent, "expected one mapped event");
    const progress = asProgressEvent(chatEvent);
    assert.equal(progress.sessionId, "sess_1");
    assert.deepEqual(progress.payload, payload);
  });

  it("forwards the final milestone with its baseline/scenario comparison", () => {
    const payload = {
      type: "simulation_done",
      sessionId: "sess_1",
      agents: 12,
      rounds: 3,
      modelCalls: 36,
      failures: 0,
      comparison: { intentDelta: 0.18, positiveShareDelta: 0.22, buyRateDelta: 0.1 },
    };
    const event: AgentEvent = { type: "simulation_progress", sessionId: "sess_1", payload };

    const [chatEvent] = mapAgentEvent(event, state, "sess_1");
    assert.ok(chatEvent, "expected one mapped event");
    const progress = asProgressEvent(chatEvent);
    assert.equal(progress.payload.type, "simulation_done");
    assert.deepEqual(progress.payload.comparison, payload.comparison);
  });

  it("marks progress as transient so it is never persisted", () => {
    const event: AgentEvent = {
      type: "simulation_progress",
      sessionId: "sess_1",
      payload: { type: "simulation_start", sessionId: "sess_1", agents: 12, rounds: 3, arms: ["baseline", "scenario"] },
    };
    const [chatEvent] = mapAgentEvent(event, state, "sess_1");
    const progress = asProgressEvent(chatEvent!);
    assert.equal(progress.noPersistent, true);
    assert.equal(progress.id, progress.id);
    assert.equal(typeof progress.timestamp, "number");
  });

  it("does not create a tool or assistant bubble", () => {
    const event: AgentEvent = {
      type: "simulation_progress",
      sessionId: "sess_1",
      payload: { type: "simulation_agent", sessionId: "sess_1", arm: "scenario", round: 1, agentId: "p3", agentName: "Persona 3", ok: false, error: "model unavailable" },
    };
    mapAgentEvent(event, state, "sess_1");
    assert.equal(state.assistantBubbleTarget, undefined);
    assert.equal(state.runningTool.size, 0);
    assert.equal(state.lastPlanStepId, undefined);
  });
});
