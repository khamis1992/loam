import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { parseWorkflowText, workflowFromCursorTrack } from "../workflowImport.js";
import { validateWorkflow } from "../../orchestration/workflows/validate.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-workflow-import-"));

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("workflow import and teach conversion", () => {
  it("imports JSON and turns plain-text steps into a valid sequential workflow", () => {
    const json = parseWorkflowText(JSON.stringify({ id: "json-flow", version: 1, title: "JSON", inputs: {}, start: "one", nodes: [{ id: "one", kind: "agent", outputKey: "result", agent: { prompt: "do it" } }], edges: [] }));
    assert.equal(json.id, "json-flow");

    const text = parseWorkflowText("Read the report\nVerify the totals", "text-flow");
    assert.equal(text.nodes.length, 2);
    assert.deepEqual(text.edges, [{ from: "step_1", to: "step_2" }]);
    assert.deepEqual(validateWorkflow(text, { maxNodes: 64, isCloudModel: () => true }), []);
  });

  it("turns recorded clicks into click and verification tool nodes", () => {
    const file = path.join(dir, "sample.cursor.json");
    fs.writeFileSync(file, JSON.stringify({ samples: [
      { timeMs: 0, cx: 100.4, cy: 200.2, visible: true, interactionType: "click" },
      { timeMs: 20, cx: 120, cy: 220, visible: true, interactionType: "click" },
    ] }));
    const workflow = workflowFromCursorTrack("sample.cursor.json", dir, "teach-flow");
    assert.equal(workflow.nodes.length, 4);
    assert.deepEqual(workflow.nodes[0]?.tool, { name: "computer_click", args: { x: 100, y: 200 } });
    assert.equal(workflow.nodes[1]?.tool?.name, "computer_screenshot");
    assert.equal(workflow.nodes[2]?.tool?.name, "computer_click");
    assert.deepEqual(validateWorkflow(workflow, { maxNodes: 64, isCloudModel: () => true }), []);
  });

  it("rejects recording paths outside the workspace and recordings without clicks", () => {
    assert.throws(() => workflowFromCursorTrack("../outside.cursor.json", dir), /escapes the workspace/);
    fs.writeFileSync(path.join(dir, "empty.cursor.json"), JSON.stringify({ samples: [] }));
    assert.throws(() => workflowFromCursorTrack("empty.cursor.json", dir), /no clicks/);
  });
});
