/**
 * B1 unit tests for the browser_operator observe -> plan -> act -> verify loop.
 * A fake surface stands in for the Playwright page so the loop is exercised
 * without launching a browser.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  actionKey,
  goalSatisfied,
  parseIntent,
  parseObservationTable,
  planOperatorAction,
  runBrowserOperatorLoop,
  type OperatorAction,
  type OperatorObservation,
  type OperatorSurface,
} from "../browserOperator.js";

function observation(partial: Partial<OperatorObservation> = {}): OperatorObservation {
  return {
    url: "https://app.test/",
    title: "",
    scrollY: 0,
    canScrollDown: false,
    elements: [],
    bodyText: "",
    snapshotId: 1,
    ...partial,
  };
}

class FakeSurface implements OperatorSurface {
  readonly acts: OperatorAction[] = [];
  private index = 0;

  constructor(
    private readonly observations: OperatorObservation[],
    private readonly actResult: { ok: boolean; message: string } = { ok: true, message: "ok" },
  ) {}

  async open(): Promise<{ pageId: string }> {
    return { pageId: "page_fake" };
  }

  async observe(): Promise<OperatorObservation> {
    const position = Math.min(this.index, this.observations.length - 1);
    const value = this.observations[position];
    if (!value) throw new Error("fake surface has no observation");
    return value;
  }

  async act(_pageId: string, action: OperatorAction): Promise<{ ok: boolean; message: string }> {
    this.acts.push(action);
    this.index += 1;
    return this.actResult;
  }
}

describe("browser_operator planning", () => {
  it("parses the browser_table observation format including input values", () => {
    const parsed = parseObservationTable([
      "snapshot #7  Example Domain",
      "url: https://example.com/",
      "scrollY=0 (more below → SCROLL_DOWN)",
      "elements (2):",
      '  [1] link       "More information" A→ "https://example.com/more"   ops:CLICK',
      '  [2] textbox    "Search" A→ "boots"   ops:CLICK,TYPE_TEXT',
    ].join("\n"), { bodyText: "Example Domain body" });

    assert.equal(parsed.snapshotId, 7);
    assert.equal(parsed.title, "Example Domain");
    assert.equal(parsed.url, "https://example.com/");
    assert.equal(parsed.canScrollDown, true);
    assert.equal(parsed.bodyText, "Example Domain body");
    assert.deepEqual(parsed.elements.map((element) => element.index), [1, 2]);
    assert.equal(parsed.elements[0]?.name, "More information");
    assert.equal(parsed.elements[0]?.value, "https://example.com/more");
    assert.equal(parsed.elements[1]?.value, "boots");
  });

  it("classifies navigate, search, type and click goals", () => {
    assert.deepEqual(parseIntent("go to example.com"), { kind: "navigate", url: "https://example.com/" });
    assert.deepEqual(parseIntent('search for "hiking boots"'), { kind: "search", query: "hiking boots" });
    assert.deepEqual(parseIntent("type hello into the search box"), { kind: "type", text: "hello", submit: false });
    assert.deepEqual(parseIntent("click the Sign in button"), { kind: "click", target: "Sign in" });
  });

  it("skips a candidate that was already attempted in the same page state", () => {
    const current = observation({ elements: [{ index: 1, role: "button", name: "Next", value: "" }] });
    const first = planOperatorAction("click Next", current);
    assert.equal(first.kind, "click");
    const second = planOperatorAction("click Next", current, { history: new Set([actionKey(first, current)]) });
    assert.equal(second.kind, "blocked");
  });
});

describe("browser_operator loop", () => {
  it("clicks toward the goal and verifies the resulting page", async () => {
    const surface = new FakeSurface([
      observation({
        url: "https://app.test/login",
        title: "Login",
        elements: [{ index: 1, role: "button", name: "Sign in", value: "" }],
      }),
      observation({
        url: "https://app.test/home",
        title: "Home",
        bodyText: "Welcome, you are signed in",
      }),
    ]);

    const result = await runBrowserOperatorLoop({ goal: "click Sign in", surface });

    assert.equal(result.status, "goal-reached");
    assert.equal(result.ok, true);
    assert.equal(surface.acts.length, 1);
    assert.equal(surface.acts[0]?.kind, "click");
    assert.equal(result.steps[0]?.changed, true);
  });

  it("verifies a click that navigates even when the new page omits the label", async () => {
    const surface = new FakeSurface([
      observation({
        url: "https://site.test/",
        title: "Home",
        elements: [{ index: 1, role: "link", name: "More", value: "" }],
      }),
      observation({ url: "https://site.test/next", title: "Second page", bodyText: "Second page" }),
    ]);

    const result = await runBrowserOperatorLoop({ goal: "click More", surface });

    assert.equal(result.status, "goal-reached");
    assert.equal(surface.acts.length, 1);
  });

  it("types a search query and submits it", async () => {
    const surface = new FakeSurface([
      observation({
        url: "https://shop.test/",
        title: "Shop",
        elements: [{ index: 1, role: "searchbox", name: "Search", value: "" }],
      }),
      observation({
        url: "https://shop.test/search?q=hiking+boots",
        title: "Search results",
        bodyText: "Results for hiking boots",
        elements: [{ index: 1, role: "searchbox", name: "Search", value: "hiking boots" }],
      }),
    ]);

    const result = await runBrowserOperatorLoop({ goal: 'search for "hiking boots"', surface });

    assert.equal(result.status, "goal-reached");
    assert.equal(surface.acts.length, 1);
    const action = surface.acts[0];
    assert.equal(action?.kind, "type");
    if (action?.kind === "type") {
      assert.equal(action.text, "hiking boots");
      assert.equal(action.submit, true);
    }
  });

  it("navigates to an explicit URL", async () => {
    const surface = new FakeSurface([
      observation({ url: "about:blank" }),
      observation({ url: "https://example.com/", title: "Example Domain", bodyText: "Example Domain" }),
    ]);

    const result = await runBrowserOperatorLoop({ goal: "go to https://example.com", surface });

    assert.equal(result.status, "goal-reached");
    assert.deepEqual(surface.acts[0], { kind: "navigate", url: "https://example.com/" });
  });

  it("stops at the step cap when the page keeps changing without satisfying the goal", async () => {
    const observations = Array.from({ length: 6 }, (_, index) =>
      observation({ url: `https://app.test/list?page=${index}`, scrollY: index * 100, canScrollDown: true }),
    );
    const surface = new FakeSurface(observations);

    const result = await runBrowserOperatorLoop({ goal: "accomplish the mission", surface, maxSteps: 3 });

    assert.equal(result.status, "step-cap");
    assert.equal(result.ok, false);
    assert.equal(result.steps.length, 3);
  });

  it("safe-stops with no-progress when repeated actions leave the page unchanged", async () => {
    const unchanged = observation({
      title: "Pager",
      elements: [
        { index: 1, role: "button", name: "Next", value: "" },
        { index: 2, role: "button", name: "Next", value: "" },
      ],
    });
    const surface = new FakeSurface([unchanged]);

    const result = await runBrowserOperatorLoop({ goal: "click Next", surface, maxSteps: 8 });

    assert.equal(result.status, "no-progress");
    assert.ok(result.steps.length >= 2);
  });

  it("reports blocked when nothing matches and the page cannot scroll", async () => {
    const surface = new FakeSurface([observation({ title: "Empty" })]);

    const result = await runBrowserOperatorLoop({ goal: "click Continue", surface });

    assert.equal(result.status, "blocked");
    assert.equal(result.steps.length, 0);
    assert.match(result.message, /no interactive elements/i);
  });

  it("honours cancellation before the next step", async () => {
    const controller = new AbortController();
    controller.abort();
    const surface = new FakeSurface([observation()]);

    const result = await runBrowserOperatorLoop({
      goal: "click anything",
      surface,
      pageId: "page_fake",
      signal: controller.signal,
    });

    assert.equal(result.status, "cancelled");
    assert.equal(surface.acts.length, 0);
  });

  it("treats a rejected action as no progress after two attempts", async () => {
    const surface = new FakeSurface(
      [observation({ elements: [{ index: 1, role: "button", name: "Next", value: "" }] })],
      { ok: false, message: "element no longer present" },
    );

    const result = await runBrowserOperatorLoop({ goal: "click Next", surface, maxSteps: 6 });

    assert.equal(result.status, "no-progress");
    assert.match(result.message, /rejected/i);
  });
});

describe("browser_operator verification", () => {
  it("does not claim click success from the button label alone before acting", () => {
    const current = observation({
      title: "Login",
      elements: [{ index: 1, role: "button", name: "Sign in", value: "" }],
      bodyText: "Sign in",
    });
    assert.equal(goalSatisfied("click Sign in", current), false);
    assert.equal(goalSatisfied("click Sign in", current, parseIntent("click Sign in"), { requireAction: true }), true);
  });
});
