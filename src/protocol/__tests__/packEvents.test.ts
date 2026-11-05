import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventMapperState, mapAgentEvent } from "../events.js";
import type { AgentEvent } from "../../agent/events.js";
import type { ToolUsedEvent } from "../types.js";

describe("service pack artifact events", () => {
  it("maps the final artifact to a persistent workspace-open tool event", () => {
    const event: AgentEvent = { type: "artifact_published", path: "uploads/presentation-video.mp4", kind: "video", title: "Presentation video", mime: "video/mp4", sizeBytes: 12000, sha256: "abc" };
    const mapped = mapAgentEvent(event, createEventMapperState(), "session_1");
    assert.equal(mapped.length, 1);
    const tool = mapped[0] as ToolUsedEvent;
    assert.equal(tool.type, "toolUsed");
    assert.equal(tool.status, "success");
    assert.equal(tool.noPersistent, undefined);
    assert.equal(tool.description, "uploads/presentation-video.mp4");
  });
});
