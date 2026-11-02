import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { instructedToolCall, toolCallFromProse } from "../toolCallFromProse.js";

describe("toolCallFromProse", () => {
  it("reads one described office_craft call", () => {
    const call = toolCallFromProse(
      "Call `office_craft` with `action: \"open\"`, `app: \"slides\"`.",
      ["office_craft", "loam_studio"],
    );
    assert.deepEqual(call, { function: { name: "office_craft", arguments: { action: "open", app: "slides" } } });
  });

  it("reads a step instruction that uses single quotes", () => {
    const call = toolCallFromProse(
      "Step 1 instruction: Call `office_craft` with action 'open' and app 'slides' to create a new presentation.",
      ["office_craft"],
    );
    assert.deepEqual(call, { function: { name: "office_craft", arguments: { action: "open", app: "slides" } } });
  });

  it("reads a plan step that does not backtick the tool name", () => {
    const call = toolCallFromProse(
      "Call office_craft with action 'open' and app 'slides' to create a new presentation.",
      ["office_craft"],
    );
    assert.deepEqual(call, { function: { name: "office_craft", arguments: { action: "open", app: "slides" } } });
  });

  it("reads a past-tense call with double quotes", () => {
    const call = toolCallFromProse(
      'I called `office_craft` with action "open" and app "slides" to open Loam Slides.',
      ["office_craft"],
    );
    assert.deepEqual(call, { function: { name: "office_craft", arguments: { action: "open", app: "slides" } } });
  });

  it("keeps a JSON content value for the studio", () => {
    const call = toolCallFromProse(
      `Call loam_studio with action 'replace' and kind 'document' and expectedRevision '0' and content '{"blocks":[{"type":"heading","text":"Q4 Plans Memo"}]}'.`,
      ["loam_studio"],
    );
    const studioArgs = (call?.function.arguments ?? {}) as { kind?: string; expectedRevision?: string; content?: string };
    assert.equal(studioArgs.kind, "document");
    assert.equal(studioArgs.expectedRevision, "0");
    assert.equal(studioArgs.content, '{"blocks":[{"type":"heading","text":"Q4 Plans Memo"}]}');
  });

  it("keeps quotes that belong to the argument value", () => {
    const call = toolCallFromProse(
      `Call file_write with path 'index.html' and content '<meta name="viewport"><h1>X</h1>'.`,
      ["file_write"],
    );
    const writeArgs = (call?.function.arguments ?? {}) as { content?: string };
    assert.equal(writeArgs.content, '<meta name="viewport"><h1>X</h1>');
  });

  it("keeps the mediaPath argument in camel case", () => {
    const call = toolCallFromProse(
      "Call creative_subtitles with mediaPath 'attachments/clip.mp4' and format 'both'.",
      ["creative_subtitles"],
    );
    assert.deepEqual(call, {
      function: { name: "creative_subtitles", arguments: { mediaPath: "attachments/clip.mp4", format: "both" } },
    });
  });

  it("keeps a period inside the slide body", () => {
    const call = toolCallFromProse(
      "Call office_craft with action 'edit' and app 'slides' and title 'متحف الفن الإسلامي' and body 'صممه I. M. Pei عام 2008.'",
      ["office_craft"],
    );
    assert.deepEqual(call, {
      function: {
        name: "office_craft",
        arguments: { action: "edit", app: "slides", title: "متحف الفن الإسلامي", body: "صممه I. M. Pei عام 2008." },
      },
    });
  });

  it("uses the current step when an earlier step also names a call", () => {
    const call = instructedToolCall(
      [
        "COMPLETED STEPS:",
        "- Open: Call office_craft with action 'open' and app 'slides'.",
        "INSTRUCTION:",
        "Call office_craft with action 'export' and app 'slides'.",
        "SUCCESS CRITERIA:",
        "A pptx file exists.",
      ].join("\n"),
      ["office_craft"],
    );
    assert.deepEqual(call?.function.arguments, { action: "export", app: "slides" });
  });

  it("ignores a tool that was not offered", () => {
    assert.equal(toolCallFromProse("Call `web_scaffold` with `action: \"build\"`.", ["office_craft"]), null);
  });
});
