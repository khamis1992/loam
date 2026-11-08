import fs from "node:fs";
import path from "node:path";
import type { WorkflowDef } from "../orchestration/workflows/types.js";

interface CursorPoint {
  timeMs: number;
  cx: number;
  cy: number;
  visible: boolean;
  interactionType: "click" | "mouseup" | "move";
}

function sequential(id: string, title: string, nodes: WorkflowDef["nodes"]): WorkflowDef {
  if (nodes.length === 0) throw new Error("workflow needs at least one step");
  return {
    id,
    version: 1,
    title,
    inputs: { type: "object", properties: {} },
    start: nodes[0]!.id,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })),
  };
}

export function parseWorkflowText(text: string, id = `import-${Date.now().toString(36)}`): WorkflowDef {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("workflow text is required");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as WorkflowDef;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).slice(0, 64);
  return sequential(id, `Imported workflow ${id}`, lines.map((line, index) => ({
    id: `step_${index + 1}`,
    kind: "agent",
    outputKey: `result_${index + 1}`,
    title: line.slice(0, 120),
    agent: { prompt: line },
  })));
}

export function workflowFromCursorTrack(file: string, workspace: string, id = `teach-${Date.now().toString(36)}`): WorkflowDef {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("recording path escapes the workspace");
  if (!resolved.endsWith(".cursor.json")) throw new Error("a .cursor.json recording is required");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as { samples?: CursorPoint[] };
  const clicks = (raw.samples ?? []).filter((point) => point.visible && point.interactionType === "click" && Number.isFinite(point.cx) && Number.isFinite(point.cy)).slice(0, 50);
  if (clicks.length === 0) throw new Error("recording has no clicks to convert");
  const nodes: WorkflowDef["nodes"] = [];
  clicks.forEach((point, index) => {
    const step = index + 1;
    nodes.push({
      id: `click_${step}`,
      kind: "tool",
      outputKey: `click_result_${step}`,
      title: `Click ${step} at ${Math.round(point.cx)},${Math.round(point.cy)}`,
      tool: { name: "computer_click", args: { x: Math.round(point.cx), y: Math.round(point.cy) } },
    });
    nodes.push({
      id: `verify_${step}`,
      kind: "tool",
      outputKey: `screenshot_${step}`,
      title: `Verify click ${step}`,
      tool: { name: "computer_screenshot", args: {} },
    });
  });
  return sequential(id, `Teach recording ${id}`, nodes);
}
