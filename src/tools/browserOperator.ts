/**
 * browser_operator: a bounded observe -> plan -> act -> verify loop on top of
 * the existing browser tools.
 *
 * The operator never owns a second browser: every observation and action is
 * delegated to the tool instances built in ./browser.ts, so it runs in the
 * same isolated Playwright session/profile as the agent's other browser_*
 * calls. The loop itself is a pure function over a small surface interface so
 * it can be unit-tested with a fake page.
 *
 * Behavioural shape follows the OSWorld-style act/observe loop (public
 * benchmark design, no code copied). Clean-room TypeScript implementation.
 */
import fs from "node:fs";
import { browserTools } from "./browser.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

export interface OperatorElement {
  index: number;
  role: string;
  name: string;
  value: string;
  /** Capabilities reported by the browser_table observation (e.g. CLICK, TYPE_TEXT, SELECT). */
  ops?: string[];
}

export interface OperatorObservation {
  url: string;
  title: string;
  scrollY: number;
  canScrollDown: boolean;
  elements: OperatorElement[];
  bodyText: string;
  snapshotId: number | null;
}

export type OperatorAction =
  | { kind: "click"; index: number; label: string }
  | { kind: "type"; index: number; text: string; submit: boolean; label: string }
  | { kind: "select"; index: number; label: string }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "navigate"; url: string }
  | { kind: "wait"; ms: number }
  | { kind: "done"; reason: string }
  | { kind: "blocked"; reason: string };

export type OperatorIntent =
  | { kind: "navigate"; url: string }
  | { kind: "search"; query: string }
  | { kind: "type"; text: string; submit: boolean }
  | { kind: "click"; target: string }
  | { kind: "select"; option: string; field?: string }
  | { kind: "generic" };

export interface OperatorSurface {
  /** Reuse an existing page id, or open a new page (optionally at a URL). */
  open(url?: string): Promise<{ pageId: string }>;
  observe(pageId: string): Promise<OperatorObservation>;
  act(pageId: string, action: OperatorAction): Promise<{ ok: boolean; message: string }>;
  screenshot?(pageId: string): Promise<string | undefined>;
}

export type OperatorStatus = "goal-reached" | "step-cap" | "blocked" | "no-progress" | "cancelled" | "error";

export interface OperatorStep {
  index: number;
  action: OperatorAction;
  observation: OperatorObservation;
  result: { ok: boolean; message: string };
  changed?: boolean;
  after?: OperatorObservation;
}

export interface OperatorLoopResult {
  status: OperatorStatus;
  ok: boolean;
  message: string;
  pageId: string;
  steps: OperatorStep[];
  final?: OperatorObservation;
  screenshot?: string;
}

export type OperatorDecide = (
  observation: OperatorObservation,
  history: ReadonlySet<string>,
  goal: string,
) => OperatorAction;

const STOPWORDS = new Set([
  "a", "an", "the", "to", "on", "in", "into", "of", "for", "and", "or", "with", "then", "please",
  "click", "type", "press", "enter", "search", "look", "up", "open", "go", "navigate", "visit",
  "find", "me", "my", "this", "that", "page", "website", "site", "browser", "using", "from", "at",
  "by", "it", "is", "are", "be", "button", "link", "tab", "option", "field", "box", "input",
  "select", "choose", "tap", "submit", "after", "before", "should", "want", "need", "please",
]);

const URL_RE = /(https?:\/\/[^\s"'<>]+|(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+(?::\d{1,5})?(?:\/[^\s"'<>]*)?|localhost(?::\d{1,5})?(?:\/[^\s"'<>]*)?)/i;

/** Loopback / private-network hosts are almost always plain-http dev servers. */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost"
    || host === "127.0.0.1"
    || host === "[::1]"
    || host.endsWith(".local")
    || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
  );
}

function stripQuotes(raw: string): string {
  return raw.trim().replace(/^["'`]+/, "").replace(/["'`]+$/, "").trim();
}

function cleanClickTarget(raw: string): string {
  return stripQuotes(raw)
    .replace(/^the\s+/i, "")
    .replace(/\s+(?:button|link|tab|option|menu\s*item|field|box|input)$/i, "")
    .trim();
}

export function tokens(input: string): string[] {
  const words = input
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .split(/[^a-z0-9\u0600-\u06ff]+/i)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.replace(/[),.;]+$/, "").trim();
  if (!trimmed) return null;
  const explicitScheme = /^https?:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(explicitScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.toLowerCase();
  // Accept FQDN hosts, IP literals, IPv6 literals and localhost; reject bare words.
  const validHost = hostname === "localhost" || hostname.includes(".") || /^\[[0-9a-f:]+\]$/i.test(hostname);
  if (!validHost) return null;
  // No scheme was given: keep the https default for public hosts but fall back to
  // http for loopback/private hosts, which nearly always serve plain HTTP.
  if (!explicitScheme && url.protocol === "https:" && isLocalHostname(hostname)) {
    try {
      url = new URL(`http://${trimmed}`);
    } catch {
      return null;
    }
  }
  return url.toString();
}

interface IntentCandidate {
  kind: "navigate" | "search" | "type" | "click" | "select";
  at: number;
  raw: string;
  field?: string;
}

/**
 * Reject a candidate payload that carries no signal: an empty string (which
 * would otherwise match every element/page) or a bare stopword such as "the"
 * left over by an under-specified goal like `search for`.
 */
function hasMeaningfulPayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (!trimmed) return false;
  if (tokens(trimmed).length > 0) return true;
  // Keep short or symbolic payloads that are not stopwords (e.g. "C++", "R", "42").
  return !STOPWORDS.has(trimmed.toLowerCase());
}

export function parseIntent(goal: string): OperatorIntent {
  const text = goal.trim();
  if (!text) return { kind: "generic" };

  const candidates: IntentCandidate[] = [];

  const navigation = /\b(?:go(?:\s+to)?|open|navigate(?:\s+to)?|visit|browse(?:\s+to)?)\s+(.+)$/i.exec(text);
  const navigationTail = navigation?.[1] ?? (/^https?:\/\//i.test(text) ? text : "");
  if (navigationTail) {
    const match = URL_RE.exec(navigationTail);
    const url = match ? normalizeUrl(match[1] ?? match[0]) : null;
    if (url) candidates.push({ kind: "navigate", at: navigation?.index ?? 0, raw: url });
  }

  const search = /\b(?:search(?:\s+for)?|look\s+up|google|find)\s+(.+)$/i.exec(text);
  if (search?.[1]) {
    const query = stripQuotes(search[1]).replace(/^(?:me|us)\s+/i, "").trim();
    if (hasMeaningfulPayload(query)) candidates.push({ kind: "search", at: search.index, raw: query });
  }

  const type = /\b(?:type|enter|fill(?:\s+in)?|write|input)\s+(.+)$/i.exec(text);
  if (type?.[1]) {
    let payload = stripQuotes(type[1]);
    payload = payload.replace(/\s+(?:in|into|on)\s+(?:the\s+)?[^,]+$/i, "").trim();
    if (!payload) payload = stripQuotes(type[1]);
    if (hasMeaningfulPayload(payload)) candidates.push({ kind: "type", at: type.index, raw: payload });
  }

  const select = /\b(?:select|choose|pick)\s+(.+?)(?:\s+(?:in|from|on)\s+(?:the\s+)?(.+?))?\s*[.!?]?$/i.exec(text);
  if (select?.[1]) {
    const option = stripQuotes(select[1]);
    if (hasMeaningfulPayload(option)) {
      candidates.push({
        kind: "select",
        at: select.index,
        raw: option,
        field: select[2] ? cleanClickTarget(select[2]) : undefined,
      });
    }
  }

  const click = /\b(?:click|press|tap|choose|select)\s+(?:the\s+)?(.+)$/i.exec(text);
  if (click?.[1]) {
    const target = cleanClickTarget(click[1]);
    if (hasMeaningfulPayload(target)) candidates.push({ kind: "click", at: click.index, raw: target });
  }

  const first = candidates.sort((a, b) => a.at - b.at)[0];
  if (!first) return { kind: "generic" };

  switch (first.kind) {
    case "navigate":
      return { kind: "navigate", url: first.raw };
    case "search":
      return { kind: "search", query: first.raw };
    case "type": {
      const submit = /\b(?:press(?:ing)?\s+(?:the\s+)?enter|hit\s+enter|submit)\b|\b(?:and|then)\s+search\b/i.test(text);
      return { kind: "type", text: first.raw, submit };
    }
    case "select":
      return { kind: "select", option: first.raw, field: first.field };
    case "click":
      return { kind: "click", target: first.raw };
  }
}

export function urlMatches(current: string, target: string): boolean {
  try {
    const a = new URL(current);
    const b = new URL(target);
    const hostA = a.hostname.replace(/^www\./i, "").toLowerCase();
    const hostB = b.hostname.replace(/^www\./i, "").toLowerCase();
    if (hostA !== hostB) return false;
    const pathA = a.pathname.replace(/\/+$/, "");
    const pathB = b.pathname.replace(/\/+$/, "");
    if (!pathB) return true;
    return pathA === pathB || pathA.startsWith(`${pathB}/`);
  } catch {
    return false;
  }
}

function pageText(observation: OperatorObservation): string {
  return `${observation.title}\n${observation.url}\n${observation.bodyText}`.toLowerCase();
}

export function goalSatisfied(
  goal: string,
  observation: OperatorObservation,
  intent: OperatorIntent = parseIntent(goal),
  opts: { requireAction?: boolean; before?: OperatorObservation } = {},
): boolean {
  const text = pageText(observation);
  const requireAction = opts.requireAction === true;
  const quoted = /"([^"]{2,})"/.exec(goal)?.[1];
  // A quoted literal is only a page-level assertion for navigate/search/generic
  // goals. For click/type/select the quoted text is the operand, so its mere
  // presence on the page must never satisfy the goal.
  const quotedIsAssertion = intent.kind === "navigate" || intent.kind === "search" || intent.kind === "generic";
  if (
    quoted
    && quotedIsAssertion
    && text.includes(quoted.toLowerCase())
    && (requireAction || intent.kind === "navigate" || intent.kind === "search")
  ) {
    return true;
  }

  switch (intent.kind) {
    case "navigate":
      return urlMatches(observation.url, intent.url);
    case "search": {
      const query = intent.query.toLowerCase().trim();
      // An empty query would match every page; never treat it as satisfied.
      if (!query || !text.includes(query)) return false;
      return /(?:[?&](?:q|query|search)=)|search|result/i.test(`${observation.url}\n${observation.title}\n${observation.bodyText}`);
    }
    case "type": {
      const wanted = intent.text.toLowerCase().trim();
      if (!wanted) return false;
      return observation.elements.some((element) => element.value.toLowerCase().includes(wanted));
    }
    case "select": {
      // Only the element VALUE proves a native selection was made; matching the
      // element name would let a button that shares the option label pre-satisfy.
      const wanted = tokens(intent.option);
      if (wanted.length > 0 && observation.elements.some((element) => wanted.every((token) => element.value.toLowerCase().includes(token)))) {
        return true;
      }
      if (!requireAction) return false;
      // A select resolved through the click fallback may land on a new page
      // whose copy does not repeat the option label.
      return opts.before !== undefined && opts.before.url !== observation.url;
    }
    case "click": {
      if (!requireAction) return false;
      const wanted = tokens(intent.target);
      if (wanted.length > 0 && wanted.every((token) => text.includes(token))) return true;
      // A click that changed the page URL reached a new destination even when
      // the destination copy does not repeat the clicked label.
      return opts.before !== undefined && opts.before.url !== observation.url;
    }
    default: {
      if (!requireAction) return false;
      const wanted = tokens(goal);
      return wanted.length > 0 && wanted.every((token) => text.includes(token));
    }
  }
}

function elementHaystack(element: OperatorElement): string {
  return `${element.name} ${element.role} ${element.value}`.toLowerCase();
}

/** ARIA/DOM roles that accept typed text. Classification is role-first so a
 *  link or button merely *labelled* "Search" is never treated as an input. */
const TEXT_INPUT_ROLES = new Set(["input", "textarea", "textbox", "searchbox", "combobox", "spinbutton"]);

function isTextInput(element: OperatorElement): boolean {
  const role = element.role.trim().toLowerCase();
  if (TEXT_INPUT_ROLES.has(role)) return true;
  return /textbox|searchbox|textarea|combobox/.test(role);
}

function isSelectElement(element: OperatorElement): boolean {
  return /select|combobox|listbox/i.test(element.role);
}

/** Whether the observation reported this capability; unknown (no ops) stays permissive. */
function supports(element: OperatorElement, op: string): boolean {
  const ops = element.ops;
  if (!ops || ops.length === 0) return true;
  return ops.includes(op);
}

function rankElements(elements: OperatorElement[], wanted: string[], mode: "click" | "type"): OperatorElement[] {
  if (wanted.length === 0) return [];
  const joined = wanted.join(" ");
  const scored: Array<{ element: OperatorElement; score: number }> = [];
  for (const element of elements) {
    const haystack = elementHaystack(element);
    let score = 0;
    for (const token of wanted) {
      if (haystack.includes(token)) score += 2;
      if (element.name.toLowerCase() === token) score += 3;
    }
    if (joined && haystack.includes(joined)) score += 5;
    if (mode === "type" && isTextInput(element)) score += 3;
    if (score > 0) scored.push({ element, score });
  }
  scored.sort((a, b) => b.score - a.score || a.element.index - b.element.index);
  return scored.map((entry) => entry.element);
}

export function actionKey(action: OperatorAction, observation: OperatorObservation): string {
  switch (action.kind) {
    case "click": {
      const state = observation.elements.map((element) => `${element.index}:${element.name}`).join("|").slice(0, 240);
      return `click:${action.index}:${observation.url}:${state}`;
    }
    case "type":
      return `type:${action.index}:${action.text}`;
    case "select":
      return `select:${action.index}:${action.label}`;
    case "navigate":
      return `navigate:${action.url}`;
    case "scroll":
      return `scroll:${observation.url}:${observation.scrollY}:${action.direction}`;
    case "wait":
      return `wait:${observation.url}:${observation.scrollY}`;
    default:
      return action.kind;
  }
}

export function planOperatorAction(
  goal: string,
  observation: OperatorObservation,
  opts: { history?: ReadonlySet<string>; scrolls?: number; maxScrolls?: number } = {},
): OperatorAction {
  const intent = parseIntent(goal);
  const history = opts.history ?? new Set<string>();
  const scrolls = opts.scrolls ?? 0;
  const maxScrolls = opts.maxScrolls ?? 4;
  const key = (action: OperatorAction): string => actionKey(action, observation);

  if (goalSatisfied(goal, observation, intent)) return { kind: "done", reason: "goal already satisfied" };

  if (intent.kind === "navigate") {
    const navigate: OperatorAction = { kind: "navigate", url: intent.url };
    if (!history.has(key(navigate))) return navigate;
    return { kind: "blocked", reason: `already navigated to ${intent.url}` };
  }

  if (intent.kind === "search" || intent.kind === "type") {
    const payload = intent.kind === "search" ? intent.query : intent.text;
    const wantsInput = rankElements(observation.elements, tokens(payload), "type").filter(isTextInput).filter((element) => supports(element, "TYPE_TEXT"));
    const input = wantsInput[0] ?? observation.elements.find((element) => isTextInput(element) && supports(element, "TYPE_TEXT"));
    if (input && !input.value.toLowerCase().includes(payload.toLowerCase())) {
      const action: OperatorAction = {
        kind: "type",
        index: input.index,
        text: payload,
        submit: intent.kind === "search" || intent.submit,
        label: input.name,
      };
      if (!history.has(key(action))) return action;
    }
    const resultTargets = rankElements(observation.elements, tokens(payload), "click").filter((element) => element.index !== input?.index);
    for (const element of resultTargets) {
      const action: OperatorAction = { kind: "click", index: element.index, label: element.name };
      if (!history.has(key(action))) return action;
    }
  }

  if (intent.kind === "select") {
    const selectables = observation.elements.filter((element) => supports(element, "SELECT") && isSelectElement(element));
    const ranked = selectables.length > 0
      ? (intent.field
        ? rankElements(selectables, tokens(intent.field), "click")
        : selectables)
      : [];
    for (const element of ranked) {
      const action: OperatorAction = { kind: "select", index: element.index, label: intent.option };
      if (!history.has(key(action))) return action;
    }
    // Without a native <select> in view, fall through to the click path below:
    // option pickers that open on click are handled there.
  }

  const target = intent.kind === "click" ? tokens(intent.target) : tokens(goal);
  for (const element of rankElements(observation.elements, target, "click")) {
    const action: OperatorAction = { kind: "click", index: element.index, label: element.name };
    if (!history.has(key(action))) return action;
  }

  // A page with no interactive elements at all may still be loading after a
  // navigation or action. Wait once before declaring the page blocked.
  if (observation.elements.length === 0 && observation.bodyText === "") {
    const waitAction: OperatorAction = { kind: "wait", ms: 800 };
    if (!history.has(key(waitAction))) return waitAction;
  }

  if (observation.canScrollDown && scrolls < maxScrolls) {
    const action: OperatorAction = { kind: "scroll", direction: "down" };
    if (!history.has(key(action))) return action;
  }

  return {
    kind: "blocked",
    reason: observation.elements.length > 0
      ? "no interactive element matches the goal"
      : "no interactive elements are visible on the page",
  };
}

function observationSignature(observation: OperatorObservation): string {
  const elements = observation.elements
    .map((element) => `${element.index}:${element.role}:${element.name}:${element.value}`)
    .join("|");
  return `${observation.url}|${observation.title}|${observation.scrollY}|${elements}|${observation.bodyText.slice(0, 300)}`;
}

export interface OperatorLoopInput {
  goal: string;
  surface: OperatorSurface;
  pageId?: string;
  initialUrl?: string;
  maxSteps?: number;
  maxScrolls?: number;
  /** Pause after each state-changing action so a fresh observation captures settled DOM. */
  settleMs?: number;
  /** Literal text (or URL fragment) that must appear once the goal itself is satisfied. */
  expectText?: string;
  decide?: OperatorDecide;
  signal?: AbortSignal;
}

export async function runBrowserOperatorLoop(input: OperatorLoopInput): Promise<OperatorLoopResult> {
  const maxSteps = Math.min(Math.max(Math.trunc(input.maxSteps ?? 8), 1), 20);
  const maxScrolls = Math.min(Math.max(Math.trunc(input.maxScrolls ?? 4), 0), 20);
  const settleMs = Math.min(Math.max(Math.trunc(input.settleMs ?? 0), 0), 2000);
  const expectText = input.expectText?.trim().toLowerCase() ?? "";
  const steps: OperatorStep[] = [];
  const history = new Set<string>();
  let scrolls = 0;
  let noChange = 0;
  let failures = 0;
  let pageId = input.pageId?.trim() ?? "";

  const expectOk = (observation: OperatorObservation): boolean =>
    !expectText || pageText(observation).includes(expectText);

  const finish = async (
    status: OperatorStatus,
    message: string,
    final?: OperatorObservation,
  ): Promise<OperatorLoopResult> => {
    let screenshot: string | undefined;
    if (pageId && input.surface.screenshot && !input.signal?.aborted) {
      try {
        screenshot = await input.surface.screenshot(pageId);
      } catch {
        screenshot = undefined;
      }
    }
    return {
      status,
      ok: status === "goal-reached",
      message,
      pageId,
      steps,
      ...(final ? { final } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
  };

  try {
    if (!pageId) {
      const opened = await input.surface.open(input.initialUrl);
      pageId = opened.pageId;
    }

    const decide: OperatorDecide = input.decide
      ?? ((observation, seen, goal) => planOperatorAction(goal, observation, { history: seen, scrolls, maxScrolls }));

    for (let index = 0; index < maxSteps; index += 1) {
      if (input.signal?.aborted) return finish("cancelled", "run cancelled before the next step");

      let observation: OperatorObservation;
      try {
        observation = await input.surface.observe(pageId);
      } catch (err) {
        return finish("error", `observation failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const intent = parseIntent(input.goal);
      if (intent.kind === "navigate" && steps.length === 0 && goalSatisfied(input.goal, observation, intent) && expectOk(observation)) {
        return finish("goal-reached", `already at ${observation.title || observation.url}`, observation);
      }

      const action = decide(observation, history, input.goal);
      if (action.kind === "done") {
        if (goalSatisfied(input.goal, observation, intent, { requireAction: true }) && expectOk(observation)) {
          return finish("goal-reached", action.reason, observation);
        }
        return finish("blocked", `planner declared done but the goal was not verified: ${action.reason}`, observation);
      }
      if (action.kind === "blocked") return finish("blocked", action.reason, observation);

      history.add(actionKey(action, observation));
      if (action.kind === "scroll") scrolls += 1;

      // Cancellation may have arrived while the planner ran; never dispatch an
      // action after the run was aborted.
      if (input.signal?.aborted) return finish("cancelled", "run cancelled before acting", observation);

      let result: { ok: boolean; message: string };
      try {
        result = await input.surface.act(pageId, action);
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }

      const step: OperatorStep = { index: index + 1, action, observation, result };
      steps.push(step);

      if (!result.ok) {
        // A rejected action never touched the page, so let the next fresh
        // observation retry it instead of treating it as an attempted click.
        history.delete(actionKey(action, observation));
        failures += 1;
        step.changed = false;
        if (failures >= 2) return finish("no-progress", `two actions were rejected: ${result.message}`, observation);
        continue;
      }
      failures = 0;

      // Let DOM/network effects of the action settle so verification reads the
      // post-action page instead of a mid-navigation frame.
      if (settleMs > 0 && (action.kind === "click" || action.kind === "type" || action.kind === "select")) {
        try {
          await input.surface.act(pageId, { kind: "wait", ms: settleMs });
        } catch {
          // Best-effort; the verification observation still happens below.
        }
      }

      let next: OperatorObservation;
      try {
        if (input.signal?.aborted) return finish("cancelled", "run cancelled before verification", observation);
        next = await input.surface.observe(pageId);
      } catch (err) {
        return finish("error", `verification failed: ${err instanceof Error ? err.message : String(err)}`, observation);
      }
      step.after = next;
      step.changed = observationSignature(next) !== observationSignature(observation);

      if (!step.changed) {
        noChange += 1;
        if (noChange >= 2) return finish("no-progress", "page state did not change after two actions", next);
      } else {
        noChange = 0;
      }

      if (step.changed && goalSatisfied(input.goal, next, intent, { requireAction: true, before: observation }) && expectOk(next)) {
        return finish("goal-reached", `goal verified after step ${index + 1}`, next);
      }
    }

    return finish("step-cap", `stopped after ${maxSteps} steps without verified completion`);
  } catch (err) {
    return finish("error", err instanceof Error ? err.message : String(err));
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseObservationTable(
  text: string,
  extras: { bodyText?: string; scrollY?: number; canScrollDown?: boolean } = {},
): OperatorObservation {
  const title = /^snapshot #\d+\s+(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  const url = /^url:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  const scrollMatch = /scrollY=(\d+)/.exec(text);
  const snapshotMatch = /snapshot #(\d+)/.exec(text);
  const elements: OperatorElement[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[(\d+)\]\s+(\S+)\s+"([^"]*)"(?:\s+\S+\s+"([^"]*)")?\s+ops:([A-Z_,]*)/.exec(line);
    if (!match) continue;
    const parsedIndex = Number(match[1]);
    if (!Number.isFinite(parsedIndex)) continue;
    elements.push({
      index: parsedIndex,
      role: match[2] ?? "",
      name: decodeEntities(match[3] ?? ""),
      value: decodeEntities(match[4] ?? ""),
      ops: (match[5] ?? "").split(",").filter(Boolean),
    });
  }
  return {
    url,
    title,
    scrollY: extras.scrollY ?? Number(scrollMatch?.[1] ?? 0),
    canScrollDown: extras.canScrollDown ?? /more below/i.test(text),
    elements,
    bodyText: extras.bodyText ?? "",
    snapshotId: snapshotMatch?.[1] ? Number(snapshotMatch[1]) : null,
  };
}

function browserTool(name: string): Tool {
  const tool = browserTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`browser tool "${name}" is unavailable`);
  return tool;
}

/**
 * Dispatch one inner browser_* call. The operator is an always-on tool, but it
 * may never widen the calling run's policy: when the run scope is known
 * (`ctx.allowedTools`) every inner tool must be part of it. This mirrors the
 * `resolveChildAllowlist` guarantee used by the fan-out research tools, so a
 * read-only mode that gets browser_operator cannot drive a browser through it.
 */
async function runBrowserTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const allowed = ctx.allowedTools;
  if (allowed && !allowed.includes(name)) {
    return { ok: false, content: `browser_operator cannot use "${name}": it is not allowed in this run` };
  }
  return browserTool(name).run(args, ctx);
}

/** The inner tools the operator drives; a run must allow at least one to be useful. */
const OPERATOR_SURFACE_TOOLS: readonly string[] = [
  "browser_open",
  "browser_goto",
  "browser_table",
  "browser_eval",
  "browser_act",
  "browser_press",
  "browser_screenshot",
];

/** True when the current run scope permits the operator to drive a browser at all. */
export function operatorSurfaceAllowed(allowedTools: readonly string[] | undefined): boolean {
  if (!allowedTools) return true;
  return OPERATOR_SURFACE_TOOLS.some((name) => allowedTools.includes(name));
}

const BODY_JS = `(() => {
  const body = document.body;
  const text = body ? String(body.innerText || "") : "";
  const scrollY = Math.round(window.scrollY || 0);
  return {
    text: text.replace(/\\s+/g, " ").trim().slice(0, 3000),
    scrollY,
    canScrollDown: body ? scrollY + window.innerHeight < body.scrollHeight - 4 : false,
  };
})()`;

class BrowserToolSurface implements OperatorSurface {
  private readonly snapshots = new Map<string, number>();

  constructor(private readonly ctx: ToolContext) {}

  async open(url?: string): Promise<{ pageId: string }> {
    const args: Record<string, unknown> = {};
    if (url) args.url = url;
    const result = await runBrowserTool("browser_open", args, this.ctx);
    if (!result.ok) throw new Error(result.content);
    const pageId = /^pageId=(\S+)/m.exec(result.content)?.[1];
    if (!pageId) throw new Error(`browser_open returned no page id: ${result.content.slice(0, 160)}`);
    return { pageId };
  }

  async observe(pageId: string): Promise<OperatorObservation> {
    const table = await runBrowserTool("browser_table", { pageId }, this.ctx);
    if (!table.ok) throw new Error(table.content);

    let bodyText = "";
    let scrollY: number | undefined;
    let canScrollDown: boolean | undefined;
    try {
      const evaluated = await runBrowserTool("browser_eval", { pageId, expression: BODY_JS }, this.ctx);
      if (evaluated.ok) {
        const parsed = JSON.parse(evaluated.content) as { text?: unknown; scrollY?: unknown; canScrollDown?: unknown };
        if (typeof parsed.text === "string") bodyText = parsed.text;
        if (typeof parsed.scrollY === "number") scrollY = parsed.scrollY;
        if (typeof parsed.canScrollDown === "boolean") canScrollDown = parsed.canScrollDown;
      }
    } catch {
      // DOM table observation is still usable without body text.
    }

    const observation = parseObservationTable(table.content, { bodyText, scrollY, canScrollDown });
    if (observation.snapshotId !== null) this.snapshots.set(pageId, observation.snapshotId);
    return observation;
  }

  async act(pageId: string, action: OperatorAction): Promise<{ ok: boolean; message: string }> {
    switch (action.kind) {
      case "click": {
        const snapshotId = this.snapshots.get(pageId);
        const args: Record<string, unknown> = { pageId, op: "CLICK", index: action.index };
        if (snapshotId !== undefined) args.snapshotId = snapshotId;
        const result = await runBrowserTool("browser_act", args, this.ctx);
        return { ok: result.ok, message: result.content };
      }
      case "type": {
        const snapshotId = this.snapshots.get(pageId);
        const args: Record<string, unknown> = { pageId, op: "TYPE_TEXT", index: action.index, text: action.text };
        if (snapshotId !== undefined) args.snapshotId = snapshotId;
        const typed = await runBrowserTool("browser_act", args, this.ctx);
        if (!typed.ok || !action.submit) return { ok: typed.ok, message: typed.content };
        const pressed = await runBrowserTool("browser_press", { pageId, key: "Enter" }, this.ctx);
        return { ok: pressed.ok, message: `${typed.content}\n${pressed.content}` };
      }
      case "select": {
        const snapshotId = this.snapshots.get(pageId);
        const args: Record<string, unknown> = { pageId, op: "SELECT", index: action.index, text: action.label };
        if (snapshotId !== undefined) args.snapshotId = snapshotId;
        const result = await runBrowserTool("browser_act", args, this.ctx);
        return { ok: result.ok, message: result.content };
      }
      case "scroll": {
        const result = await runBrowserTool("browser_act", {
          pageId,
          op: action.direction === "up" ? "SCROLL_UP" : "SCROLL_DOWN",
        }, this.ctx);
        return { ok: result.ok, message: result.content };
      }
      case "navigate": {
        const result = await runBrowserTool("browser_goto", { pageId, url: action.url }, this.ctx);
        return { ok: result.ok, message: result.content };
      }
      case "wait": {
        const result = await runBrowserTool("browser_act", { pageId, op: "WAIT", waitMs: action.ms }, this.ctx);
        return { ok: result.ok, message: result.content };
      }
      case "done":
      case "blocked":
        return { ok: true, message: action.kind };
    }
  }

  async screenshot(pageId: string): Promise<string | undefined> {
    try {
      const result = await runBrowserTool("browser_screenshot", {
        pageId,
        name: `browser_operator_${Date.now()}`,
      }, this.ctx);
      if (!result.ok) return undefined;
      // browser_screenshot prints `saved <path> (<bytes> bytes)`; the path may
      // contain spaces, so anchor on the trailing byte count.
      const saved = /^saved\s+(.+?)\s+\(\d+\s+bytes\)\s*$/m.exec(result.content)?.[1]?.trim();
      if (!saved) return undefined;
      return fs.readFileSync(saved).toString("base64");
    } catch {
      return undefined;
    }
  }
}

function describeAction(action: OperatorAction): string {
  switch (action.kind) {
    case "click":
      return `click [${action.index}] "${action.label}"`;
    case "type":
      return `type [${action.index}] "${action.label}" = "${action.text}"${action.submit ? " + Enter" : ""}`;
    case "select":
      return `select [${action.index}] "${action.label}"`;
    case "scroll":
      return `scroll ${action.direction}`;
    case "navigate":
      return `navigate ${action.url}`;
    case "wait":
      return `wait ${action.ms}ms`;
    case "done":
      return `done (${action.reason})`;
    case "blocked":
      return `blocked (${action.reason})`;
  }
}

export const browserOperatorTools: Tool[] = [
  {
    name: "browser_operator",
    description:
      "Drive the local browser toward a high-level goal with a bounded observe → plan → act → verify loop. "
      + "Each step reads the indexed DOM (browser_table) plus page text, chooses ONE safe action (click / type / select / scroll / navigate), "
      + "then re-observes to verify progress. Stops on verified completion, a step cap, a blocked page, or repeated no-progress. "
      + "Pass pageId to reuse an existing browser page; otherwise a new page opens in the same isolated browser session.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What to accomplish, e.g. 'search for hiking boots' or 'open example.com'." },
        pageId: { type: "string", description: "Optional existing browser page id (from browser_open/browser_pages)." },
        url: { type: "string", description: "Optional initial http(s) URL when a new page must be opened." },
        maxSteps: { type: "number", description: "Action budget (default 8, max 20)." },
        maxScrolls: { type: "number", description: "Scroll budget while hunting for elements (default 4, max 20)." },
        settleMs: { type: "number", description: "Pause after each state-changing action before verification, ms (default 400, max 2000)." },
        expectText: { type: "string", description: "Optional literal text that must appear on the final page for success to be claimed." },
      },
      required: ["goal"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const goal = str(args, "goal").trim();
      if (!goal) return { ok: false, content: "browser_operator needs a goal" };
      if (!ctx.cfg.policy.networkEnabled) return { ok: false, content: "network access is disabled in config" };
      if (!operatorSurfaceAllowed(ctx.allowedTools)) {
        return { ok: false, content: "browser_operator is unavailable: this mode/run does not allow the browser tools it drives" };
      }

      const initialUrl = str(args, "url").trim();
      if (initialUrl && !/^https?:\/\//i.test(initialUrl)) {
        return { ok: false, content: "browser navigation requires an http(s) URL" };
      }

      const result = await runBrowserOperatorLoop({
        goal,
        surface: new BrowserToolSurface(ctx),
        pageId: str(args, "pageId").trim() || undefined,
        initialUrl: initialUrl || undefined,
        maxSteps: num(args, "maxSteps", 8),
        maxScrolls: num(args, "maxScrolls", 4),
        settleMs: num(args, "settleMs", 400),
        expectText: str(args, "expectText").trim() || undefined,
        signal: ctx.signal,
      });

      const lines: string[] = [
        `status: ${result.status}`,
        `goal: ${goal}`,
        `page: ${result.pageId}${result.final ? ` ${result.final.url}` : ""}`,
        `steps: ${result.steps.length}`,
        `message: ${result.message}`,
      ];
      if (result.final) {
        lines.push(`final: ${result.final.title || "(no title)"} — ${result.final.url}`);
      }
      for (const step of result.steps) {
        lines.push(
          `  ${step.index}. ${describeAction(step.action)} → ${step.result.ok ? "OK" : "REJECTED"}: ${step.result.message.split(/\r?\n/)[0]}`,
        );
      }
      if (result.status !== "goal-reached") {
        lines.push("(not verified as complete — inspect the steps above and adjust the goal or page)");
      }

      return {
        ok: result.ok,
        content: lines.join("\n"),
        ...(result.screenshot ? { images: [result.screenshot] } : {}),
      };
    },
  },
];

export function createBrowserOperatorTools(): Tool[] {
  return browserOperatorTools;
}
