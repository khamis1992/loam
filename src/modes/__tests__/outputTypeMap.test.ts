/**
 * Neo N10 unit tests: an output type must select its pipeline mode.
 *
 * `OUTPUT_TYPE_MODE` existed before these tests but nothing read it, so an
 * explicit composer output type never changed the run's mode: "Slides mode hits
 * the slides pipeline" only held when the prompt happened to contain a keyword
 * the detector recognized. These tests pin both halves of the fix — the table
 * itself and the precedence inside `resolveLoamMode` — and then check the
 * consequence that matters: the resolved mode's tool scope really contains the
 * pipeline tools that deliver that output type.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { getLoamMode } from "../catalog.js";
import { resolveLoamMode } from "../detect.js";
import { OUTPUT_TYPE_MODE, OUTPUT_TYPES, isOutputType } from "../outputTypeMap.js";
import type { UserMessage } from "../../protocol/types.js";

function um(opts: { loamMode?: string; outputType?: string; mode?: UserMessage["taskMode"] } = {}): UserMessage {
  return {
    id: "msg-1",
    timestamp: Date.now(),
    type: "user_message",
    sessionId: "sess-1",
    messageStatus: "pending",
    messageType: "text",
    taskMode: opts.mode ?? "standard",
    content: "",
    contents: [],
    attachments: [],
    extData: {
      capabilities: { enabledAddons: [], connectorAccounts: [], enabledConnectors: [] },
      ...(opts.loamMode !== undefined ? { loamMode: opts.loamMode } : {}),
      ...(opts.outputType !== undefined ? { outputType: opts.outputType } : {}),
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    },
  };
}

describe("Neo N10 output type -> pipeline mode", () => {
  it("declares the six composer output types", () => {
    assert.deepEqual([...OUTPUT_TYPES], ["auto", "text", "image", "video", "slides", "website"]);
  });

  it("accepts only the declared spellings", () => {
    assert.equal(isOutputType("slides"), true);
    assert.equal(isOutputType("Slides"), false, "mixed case is rejected so config typos fail loudly");
    assert.equal(isOutputType("pdf"), false);
    assert.equal(isOutputType(undefined), false);
  });

  it("maps each deliverable to the mode that can produce it", () => {
    // `auto` defers to the detector, so it maps to no mode of its own.
    assert.equal(OUTPUT_TYPE_MODE.auto, "");
    assert.equal(OUTPUT_TYPE_MODE.text, "write");
    assert.equal(OUTPUT_TYPE_MODE.slides, "write");
    assert.equal(OUTPUT_TYPE_MODE.image, "media");
    assert.equal(OUTPUT_TYPE_MODE.video, "media");
    assert.equal(OUTPUT_TYPE_MODE.website, "build");
    // Every mapped mode is a real mode: a typo here would throw at run start.
    for (const type of OUTPUT_TYPES) {
      const mode = OUTPUT_TYPE_MODE[type];
      if (mode) assert.doesNotThrow(() => getLoamMode(mode), `${type} must map to a real mode`);
    }
  });

  it("lets an explicit output type override keyword detection", () => {
    // The regression: without the fix these prompts resolved to `build`, so a
    // Slides run could not reach loam_studio/office_export.
    assert.equal(resolveLoamMode(um({ outputType: "slides" }), "Explain our architecture"), "write");
    assert.equal(resolveLoamMode(um({ outputType: "text" }), "Summarise this PDF"), "write");
    assert.equal(resolveLoamMode(um({ outputType: "image" }), "Generate a logo"), "media");
    assert.equal(resolveLoamMode(um({ outputType: "video" }), "Cut a trailer"), "media");
    assert.equal(resolveLoamMode(um({ outputType: "website" }), "Make a website for my bakery"), "build");
  });

  it("gives the resolved mode the tools that produce the deliverable", () => {
    const slides = getLoamMode(resolveLoamMode(um({ outputType: "slides" }), "Explain our architecture"));
    assert.ok(slides.tools.includes("loam_studio"), "the slides mode must expose loam_studio");
    assert.ok(slides.tools.includes("office_export"), "the slides mode must expose office_export");
    const website = getLoamMode(resolveLoamMode(um({ outputType: "website" }), "Make a website for my bakery"));
    assert.ok(website.tools.includes("preview_serve"), "the website mode must expose preview_serve");
    const image = getLoamMode(resolveLoamMode(um({ outputType: "image" }), "Generate a logo"));
    assert.ok(image.tools.includes("loam_creative"), "the image mode must expose loam_creative");
    assert.ok(image.tools.includes("loam_canvas"), "the image mode must expose loam_canvas");
  });

  it("keeps an explicit loamMode above the output type", () => {
    assert.equal(resolveLoamMode(um({ loamMode: "research", outputType: "slides" }), "build me an app"), "research");
    assert.equal(resolveLoamMode(um({ loamMode: "media", outputType: "text" }), "hello"), "media");
  });

  it("leaves auto and unset runs exactly as they were", () => {
    // Detection is untouched: these are the pre-N10 answers.
    assert.equal(resolveLoamMode(um({}), "create a presentation"), "write");
    assert.equal(resolveLoamMode(um({}), "hello"), "build");
    assert.equal(resolveLoamMode(um({ outputType: "auto" }), "create a logo"), "media");
    assert.equal(resolveLoamMode(um({ outputType: "auto" }), "hello"), "build");
  });

  it("ignores an unrecognized output type instead of inventing a mode", () => {
    assert.equal(resolveLoamMode(um({ outputType: "pdf" }), "create a logo"), "media");
    assert.equal(resolveLoamMode(um({ outputType: "Slides" }), "hello"), "build");
    // An invalid loamMode falls through to the output type, not to detection.
    assert.equal(resolveLoamMode(um({ loamMode: "unknownmode", outputType: "slides" }), "create a logo"), "write");
  });
});
