/**
 * D5 verification runner — unit tests plus a real Playwright run against a
 * loopback static app.
 *
 * No network is used: the app is served on 127.0.0.1 from a temp directory, and
 * every non-loopback request is aborted by the runner's route handler.
 *
 * Covered:
 *  - a diff yields a plan whose assertions are anchored in the changed lines
 *  - the checklist is idempotent when appended twice
 *  - a real Chromium run records a video and a screenshot per passing flow
 *  - a failing flow is reported with a failure screenshot instead of a video
 *  - a root outside the workspace is refused
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import {
  VERIFICATION_MARKER,
  appendVerificationSection,
  artifactLink,
  fixtureFlows,
  isClaimedByDiff,
  planFromDiff,
  renderVerificationChecklist,
  runPrVerification,
  slug,
} from "../prVerification.js";

/** The diff a small pull request would carry. */
const DIFF = `diff --git a/app/index.html b/app/index.html
index 1111111..2222222 100644
--- a/app/index.html
+++ b/app/index.html
@@ -5,6 +5,9 @@ body {
     <h1 id="greeting">Hello</h1>
+    <button id="ping">Ping</button>
+    <input id="name" placeholder="Your name">
+    <form id="contact" action="/contact" method="post">
       <p>Footer</p>
     </div>
 `;

/** A minimal static app: one passing surface and one deliberately broken one. */
function writeApp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html>
<html><head><title>Loam Demo</title></head>
<body>
  <h1 id="greeting">Hello Loam</h1>
  <input id="name" placeholder="Your name">
  <button id="ping">Ping</button>
  <div id="status">ready</div>
</body></html>
`,
    "utf8",
  );
  // The broken page has no #greeting, so the text expectation must fail.
  fs.writeFileSync(path.join(dir, "broken.html"), `<!doctype html>\n<html><body><p>nothing here</p></body></html>\n`, "utf8");
}

function ctxFor(workspace: string): never {
  return {
    workspace,
    policy: { networkEnabled: true, allowOutsideWorkspaceRead: true, denyCommandPatterns: [], allowCommandPatterns: [], maxCommandSeconds: 180, sandboxMode: "workspace-write" },
    browser: { channel: "chromium", headless: true, viewport: { width: 1280, height: 800 } },
  } as never;
}

describe("D5 plan derivation", () => {
  it("derives a smoke flow per changed page", () => {
    const plan = planFromDiff(DIFF);
    assert.ok(plan.files.includes("app/index.html"));
    assert.ok(plan.flows.length >= 1);
    assert.match(plan.flows[0]!.name, /Page renders/);
  });

  it("anchors interaction flows in selectors the diff introduces", () => {
    const plan = planFromDiff(DIFF);
    const button = plan.flows.find((flow) => flow.name === "Submit flow");
    const input = plan.flows.find((flow) => flow.name === "Fill input flow");
    assert.ok(button, "expected a submit flow from the added button/form");
    assert.equal(button!.steps[0]!.selector, "#ping");
    assert.ok(input, "expected a fill flow from the added input");
    assert.equal(input!.steps[0]!.selector, "#name");
  });

  it("never claims a flow the diff does not support", () => {
    assert.equal(isClaimedByDiff("button submit form", "+ <button>Ping</button>"), true);
    assert.equal(isClaimedByDiff("button submit form", "+ const x = 1;"), false);
    assert.equal(isClaimedByDiff("input placeholder form", "+ <input placeholder=\"name\">"), true);
  });

  it("reads a declarative fixture plan", () => {
    const flows = fixtureFlows({
      entry: "index.html",
      scenarios: [
        { name: "Home", steps: [{ action: "expect-text", selector: "#greeting", value: "Hello" }] },
        { name: "Skip", steps: [] },
      ],
    });
    assert.equal(flows.length, 2);
    assert.equal(flows[0]!.name, "Home");
  });
});

describe("D5 checklist rendering", () => {
  const result = {
    run: "run-1",
    entry: "index.html",
    pass: false,
    artifactsDir: "/tmp/artifacts/run-1",
    flows: [
      { name: "Page renders: index", status: "passed", video: "/tmp/artifacts/run-1/page-renders-index.webm", screenshot: "/tmp/artifacts/run-1/page-renders-index.png", steps: [] },
      { name: "Fill input flow", status: "failed", failureScreenshot: "/tmp/artifacts/run-1/fill-input-flow-failed.png", error: "selector not found", steps: [] },
    ],
    videos: ["/tmp/artifacts/run-1/page-renders-index.webm"],
    screenshots: ["/tmp/artifacts/run-1/page-renders-index.png"],
  };

  it("renders a markdown checklist with artifact links", () => {
    const section = renderVerificationChecklist(result as never);
    assert.ok(section.includes(VERIFICATION_MARKER));
    assert.ok(section.includes("## Verification"));
    assert.match(section, /1\/2 flows passed/);
    assert.match(section, /\[page-renders-index\.webm\]/);
    assert.match(section, /fill-input-flow-failed\.png/);
    assert.match(section, /Failures:/);
  });

  it("replaces an existing section instead of appending a second one", () => {
    const first = appendVerificationSection("## Notes\n\noriginal body", renderVerificationChecklist(result as never));
    assert.equal(first.split("## Verification").length - 1, 1);
    const second = appendVerificationSection(first, renderVerificationChecklist({ ...result, pass: true } as never));
    assert.equal(second.split("## Verification").length - 1, 1, "the marker makes the update idempotent");
    assert.ok(second.includes("## Notes"));
    assert.ok(second.includes("original body"));
  });

  it("links a captured artifact, or says it is missing", () => {
    assert.equal(artifactLink("video", undefined), "video: not captured");
    assert.equal(artifactLink("video", "/a/b/c.webm"), "video: [c.webm](/a/b/c.webm)");
  });

  it("slugifies flow names for artifact files", () => {
    assert.equal(slug("Page renders: index"), "Page-renders-index");
    assert.equal(slug("!!!"), "flow");
  });
});

describe("D5 Playwright runner", () => {
  let tmp = "";
  let appRoot = "";
  let workspace = "";

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-d5-"));
    workspace = path.join(tmp, "ws");
    appRoot = path.join(workspace, "app");
    fs.mkdirSync(workspace, { recursive: true });
    writeApp(appRoot);
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("records a video and a screenshot for every passing flow", async () => {
    const result = await runPrVerification(ctxFor(workspace), workspace, {
      root: "app",
      entry: "index.html",
      run: "run-pass",
      artifacts: ".verification/pr",
      channel: "chromium",
      timeoutMs: 15_000,
      flows: [{ name: "Page renders: index", file: "index.html", steps: [{ action: "expect-url", value: "index.html" }] }, { name: "Greeting text", file: "index.html", steps: [{ action: "expect-text", selector: "#greeting", value: "Hello Loam" }] }],
    });
    assert.equal(result.pass, true);
    assert.equal(result.flows.length, 2);
    assert.equal(result.flows.filter((flow) => flow.status === "passed").length, 2);
    assert.equal(result.videos.length, 2, "one video per flow");
    assert.equal(result.screenshots.length, 2);
    for (const video of result.videos) {
      assert.ok(fs.existsSync(video), `expected ${video} on disk`);
      assert.ok(fs.statSync(video).size > 0, "the recorded video is not empty");
    }
  });

  it("reports a failing flow with a failure screenshot", async () => {
    const result = await runPrVerification(ctxFor(workspace), workspace, {
      root: "app",
      entry: "broken.html",
      run: "run-fail",
      artifacts: ".verification/pr",
      channel: "chromium",
      timeoutMs: 2000,
      flows: [{ name: "Broken page greeting", file: "broken.html", steps: [{ action: "expect-text", selector: "#greeting", value: "Hello Loam" }] }],
    });
    assert.equal(result.pass, false);
    assert.equal(result.flows[0]!.status, "failed");
    assert.ok(result.flows[0]!.failureScreenshot);
    assert.ok(fs.existsSync(result.flows[0]!.failureScreenshot!), "the failure screenshot is captured");
    assert.match(result.flows[0]!.error ?? "", /greeting/);
  });

  it("refuses an app root outside the workspace", async () => {
    await assert.rejects(
      () => runPrVerification(ctxFor(workspace), workspace, { root: "../..", entry: "index.html", run: "run-escape", flows: [{ name: "x", steps: [{ action: "wait", value: "1" }] }] }),
      /outside the workspace/,
    );
  });

  it("refuses an empty plan instead of running nothing", async () => {
    await assert.rejects(
      () => runPrVerification(ctxFor(workspace), workspace, { root: "app", entry: "index.html", run: "run-empty", flows: [] }),
      /no runnable flows/,
    );
  });
});
