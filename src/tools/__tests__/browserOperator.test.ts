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

/**
 * Scripted surface for the deepened loop: state-changing actions advance the
 * observation script while plain waits do not (they do not touch the page),
 * unless advanceOnWait is set to model a page that finishes loading late.
 */
class ScriptedSurface implements OperatorSurface {
  readonly acts: OperatorAction[] = [];
  private step = 0;

  constructor(
    private readonly script: Partial<OperatorObservation>[],
    private readonly options: { advanceOnWait?: boolean } = {},
  ) {}

  async open(): Promise<{ pageId: string }> {
    return { pageId: "page_scripted" };
  }

  async observe(): Promise<OperatorObservation> {
    const entry = this.script[Math.min(this.step, this.script.length - 1)];
    if (!entry) throw new Error("scripted surface has no observation");
    return observation(entry);
  }

  async act(_pageId: string, action: OperatorAction): Promise<{ ok: boolean; message: string }> {
    this.acts.push(action);
    if (action.kind !== "wait" || this.options.advanceOnWait === true) this.step += 1;
    return { ok: true, message: "ok" };
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

  it("waits once on a blank page before reporting blocked when nothing matches", async () => {
    const surface = new FakeSurface([observation({ title: "Empty" })]);

    const result = await runBrowserOperatorLoop({ goal: "click Continue", surface });

    assert.equal(result.status, "blocked");
    assert.equal(result.steps.length, 1);
    assert.equal(surface.acts[0]?.kind, "wait");
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

describe("browser_operator deepen", () => {
  it("captures per-element ops from the observation table", () => {
    const parsed = parseObservationTable([
      "snapshot #3  Settings",
      "url: https://app.test/settings",
      "scrollY=0 (bottom)",
      "elements (3):",
      '  [1] combobox   "Region"   ops:CLICK,TYPE_TEXT,SELECT',
      '  [2] link       "Docs"   ops:CLICK',
      '  [3] button     "Save"   ops:CLICK',
    ].join("\n"));
    assert.deepEqual(parsed.elements[0]?.ops, ["CLICK", "TYPE_TEXT", "SELECT"]);
    assert.deepEqual(parsed.elements[1]?.ops, ["CLICK"]);
    assert.deepEqual(parsed.elements[2]?.ops, ["CLICK"]);
  });

  it("parses select goals with an optional field qualifier", () => {
    const withField = parseIntent("select Germany in the country dropdown");
    assert.equal(withField.kind, "select");
    if (withField.kind === "select") {
      assert.equal(withField.option, "Germany");
      assert.equal(withField.field, "country dropdown");
    }
    const bare = parseIntent("choose Red");
    assert.equal(bare.kind, "select");
    if (bare.kind === "select") {
      assert.equal(bare.option, "Red");
      assert.equal(bare.field, undefined);
    }
  });

  it("drives a native <select> to the requested option and verifies by value", async () => {
    const surface = new ScriptedSurface([
      {
        url: "https://shop.test/checkout",
        title: "Checkout",
        elements: [
          { index: 1, role: "combobox", name: "Country", value: "", ops: ["CLICK", "TYPE_TEXT", "SELECT"] },
          { index: 2, role: "button", name: "Pay", value: "", ops: ["CLICK"] },
        ],
      },
      {
        url: "https://shop.test/checkout",
        title: "Checkout",
        elements: [{ index: 1, role: "combobox", name: "Country", value: "Germany", ops: ["CLICK", "TYPE_TEXT", "SELECT"] }],
      },
    ]);

    const result = await runBrowserOperatorLoop({ goal: "select Germany in the country dropdown", surface });

    assert.equal(result.status, "goal-reached");
    assert.deepEqual(surface.acts, [{ kind: "select", index: 1, label: "Germany" }]);
  });

  it("skips select candidates that never reported the SELECT capability", () => {
    const current = observation({
      elements: [
        { index: 1, role: "combobox", name: "Country", value: "", ops: ["CLICK", "TYPE_TEXT"] },
        { index: 2, role: "button", name: "Pay", value: "", ops: ["CLICK"] },
      ],
    });
    const action = planOperatorAction("select Germany in the country dropdown", current);
    // No SELECT-capable element: the click fallback opens the dropdown itself.
    assert.equal(action.kind, "click");
    if (action?.kind === "click") assert.equal(action.index, 1);
  });

  it("does not claim select success from a matching element name without acting", () => {
    const current = observation({
      elements: [{ index: 1, role: "button", name: "Sign in", value: "", ops: ["CLICK"] }],
      bodyText: "Sign in",
    });
    // The button shares the option label but has no value; only a acted-on
    // value or a URL change can satisfy the select goal.
    assert.equal(goalSatisfied("choose Sign in", current), false);
  });

  it("falls back to click ranking when the page has no native select", async () => {
    const surface = new ScriptedSurface([
      { url: "https://app.test/", title: "App", bodyText: "App home", elements: [{ index: 1, role: "button", name: "Sign in", value: "", ops: ["CLICK"] }] },
      { url: "https://app.test/home", title: "Home", bodyText: "Signed in" },
    ]);

    const result = await runBrowserOperatorLoop({ goal: "choose Sign in", surface });

    assert.equal(result.status, "goal-reached");
    assert.deepEqual(surface.acts[0], { kind: "click", index: 1, label: "Sign in" });
  });

  it("does not type into elements that did not report TYPE_TEXT", () => {
    const weightCurrent = observation({
      elements: [
        { index: 1, role: "link", name: "hiking boots", value: "", ops: ["CLICK"] },
        { index: 2, role: "textbox", name: "Search", value: "", ops: ["CLICK", "TYPE_TEXT"] },
      ],
    });
    const action = planOperatorAction('search for "hiking boots"', weightCurrent);
    assert.equal(action.kind, "type");
    if (action?.kind === "type") assert.equal(action.index, 2);
  });

  it("settles after state-changing actions before verifying", async () => {
    const surface = new ScriptedSurface([
      { url: "https://app.test/list", title: "List", bodyText: "load next items", elements: [{ index: 1, role: "button", name: "Load next", value: "", ops: ["CLICK"] }] },
      { url: "https://app.test/list?page=2", title: "Page 2", bodyText: "page two contents" },
    ]);

    const result = await runBrowserOperatorLoop({ goal: "click Load next", surface, settleMs: 300 });

    assert.equal(result.status, "goal-reached");
    assert.equal(surface.acts.length, 2);
    assert.equal(surface.acts[0]?.kind, "click");
    assert.equal(surface.acts[1]?.kind, "wait");
    if (surface.acts[1]?.kind === "wait") assert.equal(surface.acts[1].ms, 300);
  });

  it("waits for a late-loading page then proceeds once content appears", async () => {
    const surface = new ScriptedSurface([
      { url: "https://app.test/", title: "" },
      { url: "https://app.test/", title: "Loaded", bodyText: "signed in area", elements: [{ index: 1, role: "button", name: "Continue", value: "", ops: ["CLICK"] }] },
      { url: "https://app.test/next", title: "Next", bodyText: "next page" },
    ], { advanceOnWait: true });

    const result = await runBrowserOperatorLoop({ goal: "click Continue", surface });

    assert.equal(result.status, "goal-reached");
    assert.equal(surface.acts.length, 2);
    assert.equal(surface.acts[0]?.kind, "wait");
    assert.equal(surface.acts[1]?.kind, "click");
  });

  it("stops scrolling once the scroll budget is exhausted", async () => {
    const surface = new ScriptedSurface([
      { url: "https://app.test/feed", title: "Feed", bodyText: "feed content", canScrollDown: true, scrollY: 0 },
      { url: "https://app.test/feed", title: "Feed", bodyText: "feed content", canScrollDown: true, scrollY: 600 },
    ], { advanceOnWait: true });

    const result = await runBrowserOperatorLoop({ goal: "search for the secret widget", surface, maxScrolls: 1 });

    assert.equal(result.status, "blocked");
    assert.deepEqual(surface.acts.map((action) => action.kind), ["scroll"]);
  });

  it("requires expectText to appear before claiming success", async () => {
    const missing = new ScriptedSurface([
      { url: "https://app.test/login", title: "Login", bodyText: "Sign in", elements: [{ index: 1, role: "button", name: "Sign in", value: "", ops: ["CLICK"] }] },
      { url: "https://app.test/home", title: "Home", bodyText: "dashboard" },
    ]);
    const guarded = await runBrowserOperatorLoop({ goal: "click Sign in", surface: missing, expectText: "welcome back" });
    assert.notEqual(guarded.status, "goal-reached");

    const present = new ScriptedSurface([
      { url: "https://app.test/login", title: "Login", bodyText: "Sign in", elements: [{ index: 1, role: "button", name: "Sign in", value: "", ops: ["CLICK"] }] },
      { url: "https://app.test/home", title: "Home", bodyText: "Welcome back" },
    ]);
    const verified = await runBrowserOperatorLoop({ goal: "click Sign in", surface: present, expectText: "welcome back" });
    assert.equal(verified.status, "goal-reached");
  });
});
