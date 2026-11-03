import fs from "node:fs";
import path from "node:path";

import { log } from "../log.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";
import { adExePath, resolveStateRoot, verifyAdBinary } from "./desktop/adBinary.js";
import { agentDesktopBackend } from "./desktop/agentDesktopBackend.js";
import type { ActResult, DesktopBackend } from "./desktop/backend.js";
import { pickBackend } from "./desktop/backend.js";
import { ForegroundGuard, deniedKey, guarded } from "./desktop/guard.js";
import { defaultLegacyDeps, parseJson, requireEnabled, targetArgs, type LegacyDeps } from "./desktop/legacyBackend.js";
import { legacyInputScript, legacyUiScript } from "./desktop/legacyBackend.js";
import { recordDesktopCall } from "./desktop/metrics.js";
import { renderError, renderSnapshot } from "./desktop/render.js";
import type { AdSnapshot } from "./desktop/adTypes.js";

/**
 * The computer-use facade (§2.4): the same `computer_*` names the model knows,
 * now backed by agent-desktop when the pinned binary verifies, with the legacy
 * PowerShell/nut-js path as fallback. Every physical/headed input passes the
 * foreground guard; every result is untrusted data; no titles in logs.
 */

interface FacadeDeps {
  legacy: LegacyDeps;
  /** Test seam: build a guard with a fake probe/focused resolver. */
  makeGuard: (focusedWindowId: () => Promise<string | null>) => ForegroundGuard;
  verifyBinary: (exe: string) => { ok: boolean; reason?: string };
  exePath: () => string;
  /** Test seam: build the agent-desktop backend (defaults to the real one). */
  makeBackend: typeof agentDesktopBackend;
}

const defaultDeps: FacadeDeps = {
  legacy: defaultLegacyDeps,
  makeGuard: (focused) => new ForegroundGuard(async () => null, focused),
  verifyBinary: verifyAdBinary,
  exePath: () => adExePath(),
  makeBackend: agentDesktopBackend,
};

function makeFacadeTools(deps: FacadeDeps): Tool[] {
  const legacy = deps.legacy;

  // ---- per-run state -----------------------------------------------------
  // One guard per facade: the target survives across tool calls in the same
  // task. Created eagerly so tests can set the target before any tool call.
  const guard: ForegroundGuard = deps.makeGuard(async () => null);
  let adBackend: DesktopBackend | null = null;
  let adUnavailableReason = "";

  interface RunCtx {
    backend: DesktopBackend | null;
    usingLegacy: boolean;
  }

  function resolveRunCtx(ctx: ToolContext): RunCtx {
    if (adBackend || adUnavailableReason) {
      return { backend: adUnavailableReason ? null : adBackend, usingLegacy: !!adUnavailableReason || !adBackend };
    }
    const picked = pickBackend(ctx, {
      verify: deps.verifyBinary,
      exePath: deps.exePath,
      stateRoot: resolveStateRoot(ctx.cfg.computerUse.agentDesktop?.stateRoot),
      make: (exe, stateRoot, session, signal) => deps.makeBackend(exe, stateRoot, session, signal),
    });
    if ("legacy" in picked) {
      adUnavailableReason = picked.reason;
      if (picked.reason) log.info(`desktop: legacy backend (${picked.reason.replace(/\s+/g, " ").slice(0, 120)})`);
      return { backend: null, usingLegacy: true };
    }
    adBackend = picked;
    return { backend: picked, usingLegacy: false };
  }

  const ok = (content: string): ToolResult => ({ ok: true, content, untrusted: true });
  const fail = (content: string): ToolResult => ({ ok: false, content, untrusted: true });

  function actToContent(r: ActResult, extra = ""): ToolResult {
    recordDesktopCall({
      tool: "desktop",
      backend: r.backend,
      command: r.message.slice(0, 40),
      ms: 0,
      delivery: r.delivery,
      retry: r.retry,
      code: r.code,
      foregroundChanged: r.foregroundChanged,
    });
    if (r.ok) return ok(`ok ${r.message} delivery=${r.delivery}${extra}${r.foregroundChanged ? "\nforegroundChanged=true" : ""}`);
    return fail(renderError({
      code: (r.code ?? "INTERNAL") as never,
      message: r.message,
      suggestion: r.suggestion,
      disposition: { delivery: r.delivery, retry: r.retry },
    }));
  }

  /** agent-desktop list-windows parsed into lines w-ID App.exe [flags]. */
  async function adListWindowsLines(b: DesktopBackend): Promise<{ lines: string; focusedId: string | null }> {
    const r = await b.listWindows();
    if (!r.ok || !r.raw) return { lines: renderError({
      code: (r.code ?? "INTERNAL") as never,
      message: r.message,
      suggestion: r.suggestion,
      disposition: { delivery: r.delivery, retry: r.retry },
    }), focusedId: null };
    const wins = (r.raw as { windows?: Array<{ id: string; app_name: string; minimized?: boolean; is_focused?: boolean }> }).windows ?? [];
    const lines = wins.map((w) => `${w.id} ${w.app_name}${w.minimized ? " [minimized]" : ""}${w.is_focused ? " [focused]" : ""}`);
    return { lines: lines.join("\n"), focusedId: wins.find((w) => w.is_focused)?.id ?? null };
  }

  async function setGuardTargetFromWindowId(b: DesktopBackend, windowId: string): Promise<void> {
    guard?.setTarget({ windowId });
  }

  // ---- tools -------------------------------------------------------------
  const toolListWindows: Tool = {
    name: "computer_list_windows",
    description: "List open windows as lines: window_id App.exe [minimized] [focused]. Use a window_id with the other computer_* tools.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend, usingLegacy } = resolveRunCtx(ctx);
      if (backend) {
        const { lines, focusedId } = await adListWindowsLines(backend);
        if (focusedId) await setGuardTargetFromWindowId(backend, focusedId);
        return ok(lines);
      }
      void usingLegacy;
      const res = await legacy.runPs(legacyUiScript(), ["-Action", "list_windows"]);
      return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
    },
  };

  const toolFocusWindow: Tool = {
    name: "computer_focus_window",
    description: "Focus a window by window_id (preferred) or a title substring. Makes it the guard target for physical input.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, window_id: { type: "string" } },
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend } = resolveRunCtx(ctx);
      const windowId = str(args, "window_id");
      const title = str(args, "title");
      if (!windowId && !title) return fail("provide window_id or title");
      if (backend) {
        let target = windowId;
        if (!target && title) {
          const r = await backend.listWindows();
          const wins = (r.raw as { windows?: Array<{ id: string; title: string }> } | undefined)?.windows ?? [];
          const hit = wins.find((w) => w.title.includes(title));
          if (!hit) return fail(`no window title contains the given text`);
          target = hit.id;
        }
        const r = await backend.focusWindow(target);
        if (r.ok) await setGuardTargetFromWindowId(backend, target);
        return actToContent(r);
      }
      if (!title) return fail("legacy backend focuses by title only; provide title");
      const res = await legacy.runPs(legacyUiScript(), ["-Action", "ui_focus_window", "-Title", title]);
      if (res.code === 0) guard?.setTarget({ app: undefined, windowId: undefined });
      return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
    },
  };

  const toolScreenshot: Tool = {
    name: "computer_screenshot",
    description: "Capture the screen (or the target window) to PNG and return the path. For reading text prefer computer_snapshot.",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      fs.mkdirSync(ctx.cfg.computerUse.screenshotDir, { recursive: true });
      const name = str(args, "name") || `screen_${Date.now()}`;
      const out = path.join(ctx.cfg.computerUse.screenshotDir, `${name}.png`);
      const { backend } = resolveRunCtx(ctx);
      if (backend) {
        const t = guard?.getTarget();
        const r = await backend.screenshot({ ...(t?.windowId ? { windowId: t.windowId } : {}), out });
        if (r.ok) return { ok: true, content: out, untrusted: true };
        // §2.5: screenshot falls back to legacy when not delivered safely
        if (r.delivery === "not_delivered" && r.retry === "safe") {
          const res = await legacy.runPs(legacyUiScript(), ["-Action", "screenshot", "-Out", out]);
          return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
        }
        return actToContent(r);
      }
      const res = await legacy.runPs(legacyUiScript(), ["-Action", "screenshot", "-Out", out]);
      return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
    },
  };

  // ---- NEW tools (agent-desktop only; legacy answers with guidance) -------
  const toolSnapshot: Tool = {
    name: "computer_snapshot",
    description: "Observe a window's accessibility tree as compact lines with refs (@sid:eN). skeleton=true first, then drill with root=@ref. Refs die on the next snapshot.",
    parameters: {
      type: "object",
      properties: {
        window_id: { type: "string" },
        skeleton: { type: "boolean" },
        root: { type: "string", description: "@sid:eN from the latest snapshot of this window" },
        max_depth: { type: "number" },
      },
      required: ["window_id"],
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend, usingLegacy } = resolveRunCtx(ctx);
      if (!backend) {
        return usingLegacy && adUnavailableReason
          ? fail(`computer_snapshot needs the agent-desktop backend (${adUnavailableReason}); use computer_ui_tree instead`)
          : fail("computer_snapshot needs the agent-desktop backend; use computer_ui_tree instead");
      }
      const windowId = str(args, "window_id");
      const r = await backend.snapshot({
        windowId,
        skeleton: args["skeleton"] === true,
        ...(str(args, "root") ? { root: str(args, "root") } : {}),
        ...(num(args, "max_depth", 0) ? { maxDepth: num(args, "max_depth", 10) } : {}),
        timeoutMs: ctx.cfg.computerUse.agentDesktop?.snapshotTimeoutMs ?? 3000,
      });
      if (!r.ok || !r.snapshot) return actToContent(r);
      await setGuardTargetFromWindowId(backend, windowId);
      return ok(renderSnapshot(r.snapshot, ctx.cfg.computerUse.agentDesktop?.maxRenderedLines ?? 400));
    },
  };

  const toolFind: Tool = {
    name: "computer_find",
    description: "Find elements in a window by role and/or name (substring, or exact=true). Returns rendered lines with refs from the current snapshot.",
    parameters: {
      type: "object",
      properties: {
        window_id: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        exact: { type: "boolean" },
        limit: { type: "number", description: "1..20" },
      },
      required: ["window_id"],
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend } = resolveRunCtx(ctx);
      if (!backend) return fail("computer_find needs the agent-desktop backend; use computer_ui_list instead");
      const r = await backend.find({
        windowId: str(args, "window_id"),
        ...(str(args, "role") ? { role: str(args, "role") } : {}),
        ...(str(args, "name") ? { name: str(args, "name") } : {}),
        exact: args["exact"] === true,
        limit: num(args, "limit", 20),
      });
      if (!r.ok || !r.raw) return actToContent(r);
      const rows = (r.raw as { results?: Array<{ role: string; name?: string; ref_id?: string; states?: string[] }> }).results ?? [];
      return ok(rows.map((e) => `${e.role}${e.name ? ` "${e.name.slice(0, 80)}"` : ""}${e.ref_id ? ` ${e.ref_id}` : ""}${e.states?.length ? ` [${e.states.join(",")}]` : ""}`).join("\n") || "no matches");
    },
  };

  const toolAct: Tool = {
    name: "computer_act",
    description: "One semantic action on a ref: click, set-value, clear, select, toggle, check, uncheck, expand, collapse, scroll, scroll-to. Returns disposition + change delta. Never repeat after delivered_*.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "@sid:eN from the latest snapshot" },
        action: { type: "string", enum: ["click", "set-value", "clear", "select", "toggle", "check", "uncheck", "expand", "collapse", "scroll", "scroll-to"] },
        value: { type: "string" },
      },
      required: ["ref", "action"],
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend } = resolveRunCtx(ctx);
      if (!backend) return fail("computer_act needs the agent-desktop backend; use computer_ui_click/computer_ui_set_text instead");
      const r = await backend.act(str(args, "ref"), str(args, "action") as never, str(args, "value") || undefined);
      return actToContent(r);
    },
  };

  const toolBatch: Tool = {
    name: "computer_batch",
    description: "Run up to 10 computer_act steps in one call (stop-on-error). Each step: {ref, action, value?}. Dispositions are per step; never repeat a delivered step.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: { ref: { type: "string" }, action: { type: "string" }, value: { type: "string" } },
            required: ["ref", "action"],
          },
        },
      },
      required: ["steps"],
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend } = resolveRunCtx(ctx);
      if (!backend) return fail("computer_batch needs the agent-desktop backend");
      const steps = Array.isArray(args["steps"]) ? (args["steps"] as Array<Record<string, unknown>>).slice(0, 10) : [];
      if (steps.length === 0) return fail("steps[] required (max 10)");
      const out: string[] = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        const r = await backend.act(String(s["ref"] ?? ""), String(s["action"] ?? "") as never, s["value"] !== undefined ? String(s["value"]) : undefined);
        out.push(`${i + 1}. ${r.ok ? "ok" : "FAIL"} ${String(s["action"])} delivery=${r.delivery}${r.code ? ` code=${r.code}` : ""}`);
        if (!r.ok) break;
      }
      return ok(out.join("\n"));
    },
  };

  // ---- legacy-name tools (agent-desktop mapping + guarded fallback) ------
  const toolUiTree: Tool = {
    name: "computer_ui_tree",
    description: "Legacy observe: the foreground/target window tree. Prefer computer_snapshot (refs + drill). Kept for compatibility.",
    parameters: { type: "object", properties: { depth: { type: "number" }, window_id: { type: "string" } } },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend } = resolveRunCtx(ctx);
      if (backend) {
        const windowId = str(args, "window_id") || guard?.getTarget()?.windowId || "";
        if (!windowId) return fail("provide window_id or focus/list windows first");
        const r = await backend.snapshot({ windowId, maxDepth: num(args, "depth", 10) });
        if (r.ok && r.snapshot) return ok(renderSnapshot(r.snapshot, ctx.cfg.computerUse.agentDesktop?.maxRenderedLines ?? 400));
        return actToContent(r);
      }
      const depth = Math.min(Math.max(num(args, "depth", 3), 1), 8);
      const res = await legacy.runPs(legacyUiScript(), ["-Action", "ui_tree", "-Depth", String(depth)]);
      return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
    },
  };

  const toolUiList: Tool = {
    name: "computer_ui_list",
    description: "Legacy search of the foreground window by name/role. Prefer computer_find. Kept for compatibility.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" }, max: { type: "number" } },
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend } = resolveRunCtx(ctx);
      if (backend) {
        const windowId = guard?.getTarget()?.windowId || "";
        if (!windowId) return fail("focus/list a window first, or use computer_find with window_id");
        const r = await backend.find({
          windowId,
          ...(str(args, "role") ? { role: str(args, "role") } : {}),
          ...(str(args, "name") ? { name: str(args, "name") } : {}),
          limit: num(args, "max", 20),
        });
        if (r.ok && r.raw) {
          const rows = (r.raw as { results?: Array<{ role: string; name?: string; ref_id?: string }> }).results ?? [];
          return ok(rows.map((e) => `${e.role}${e.name ? ` "${e.name.slice(0, 80)}"` : ""}${e.ref_id ? ` ${e.ref_id}` : ""}`).join("\n") || "no matches");
        }
        return actToContent(r);
      }
      const a = ["-Action", "ui_elements", "-Max", String(Math.min(Math.max(num(args, "max", 60), 1), 200))];
      if (str(args, "name")) a.push("-Name", str(args, "name"));
      if (str(args, "role")) a.push("-Role", str(args, "role"));
      const res = await legacy.runPs(legacyUiScript(), a);
      return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
    },
  };

  const toolUiClick: Tool = {
    name: "computer_ui_click",
    description: "Click an element by ref (preferred: from computer_snapshot/find) or legacy index/name/role. Physical on legacy; semantic (headless) via ref.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" }, index: { type: "number" }, name: { type: "string" }, role: { type: "string" } },
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const { backend } = resolveRunCtx(ctx);
      const ref = str(args, "ref");
      if (backend && ref) {
        const r = await backend.act(ref, "click");
        return actToContent(r);
      }
      if (args["index"] === undefined && !str(args, "name") && !str(args, "role")) {
        return fail("provide ref (preferred), or index/name/role");
      }
      if (backend && !ref) {
        const windowId = guard?.getTarget()?.windowId || "";
        const r = await backend.find({ windowId, ...(str(args, "role") ? { role: str(args, "role") } : {}), ...(str(args, "name") ? { name: str(args, "name") } : {}), limit: 1 });
        const hit = (r.raw as { results?: Array<{ ref_id?: string }> } | undefined)?.results?.[0];
        if (hit?.ref_id) return actToContent(await backend.act(hit.ref_id, "click"));
        return actToContent(r);
      }
      // legacy: resolve bounds then GUARDED physical click
      const res = await legacy.runPs(legacyUiScript(), ["-Action", "ui_bounds", ...targetArgs(args)]);
      const info = parseJson(res.out);
      if (!info) return { ok: false, content: res.out.trim() || res.err, untrusted: true };
      if (info["found"] !== true) return fail(JSON.stringify(info));
      const x = (Number(info["x"]) || 0) + Math.floor((Number(info["w"]) || 0) / 2);
      const y = (Number(info["y"]) || 0) + Math.floor((Number(info["h"]) || 0) / 2);
      const g = await guarded(guard, async () => null, () => legacy.clickPoint(x, y));
      if (g.blocked) return fail(g.blocked);
      return ok(`element clicked${g.mouseMoved === false ? "" : ""}${g.foregroundChanged ? "\nforegroundChanged=true" : ""}`);
    },
  };

  const toolUiSetText: Tool = {
    name: "computer_ui_set_text",
    description: "Set an edit field's text by ref (preferred; headless set-value) or legacy index/name/role. Keeps existing validation. Prefer over typing.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, ref: { type: "string" }, index: { type: "number" }, name: { type: "string" }, role: { type: "string" } },
      required: ["text"],
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const text = str(args, "text");
      const { backend } = resolveRunCtx(ctx);
      const ref = str(args, "ref");
      if (backend && ref) {
        const r = await backend.act(ref, "set-value", text);
        if (
          !r.ok &&
          (r.code === "ACTION_NOT_SUPPORTED" || r.code === "POLICY_DENIED") &&
          r.delivery === "not_delivered" &&
          r.retry === "safe" &&
          ctx.cfg.computerUse.allowHeaded !== false
        ) {
          const g = await guarded(guard, async () => null, () => backend.typeHeaded(ref, text));
          if (g.blocked) return fail(g.blocked);
          return actToContent(g.value as ActResult);
        }
        return actToContent(r);
      }
      const res = await legacy.runPs(legacyUiScript(), ["-Action", "ui_set_value", "-Text", text, ...targetArgs(args)]);
      const info = parseJson(res.out);
      if (!info) return { ok: false, content: res.out.trim() || res.err, untrusted: true };
      if (info["result"] === "set_value") return ok(`set value on '${String(info["name"] ?? "")}'`);
      if (info["result"] === "focus_then_type") {
        if (typeof info["x"] === "number" && typeof info["y"] === "number") {
          const g = await guarded(guard, async () => null, async () => {
            await legacy.clickPoint(info["x"] as number, info["y"] as number);
            return legacy.runPs(legacyInputScript(), ["-Action", "type", "-Text", text]);
          });
          if (g.blocked) return fail(g.blocked);
          const typed = g.value as { code: number | null; out: string; err: string };
          return { ok: typed.code === 0, content: `focused '${String(info["name"] ?? "")}' → ${typed.out.trim() || typed.err}`, untrusted: true };
        }
      }
      return fail(JSON.stringify(info));
    },
  };

  const toolClick: Tool = {
    name: "computer_click",
    description: "Physical mouse click at screen coordinates (fallback for targets with no accessible element). Guarded: the target window must be foreground.",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, right: { type: "boolean" } },
      required: ["x", "y"],
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      resolveRunCtx(ctx);
      const g = await guarded(guard, async () => null, () =>
        legacy.clickPoint(num(args, "x", 0), num(args, "y", 0), args["right"] === true ? "right" : "left"),
      );
      if (g.blocked) return fail(g.blocked);
      return ok(`${g.value}${g.foregroundChanged ? "\nforegroundChanged=true" : ""}`);
    },
  };

  const toolType: Tool = {
    name: "computer_type",
    description: "Type text into the focused control. Prefer computer_act set-value; this is the physical fallback (guarded, takes focus).",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, ref: { type: "string" } },
      required: ["text"],
    },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const text = str(args, "text");
      const { backend } = resolveRunCtx(ctx);
      const ref = str(args, "ref");
      if (backend && ref && ctx.cfg.computerUse.allowHeaded !== false) {
        const g = await guarded(guard, async () => null, () => backend.typeHeaded(ref, text));
        if (g.blocked) return fail(g.blocked);
        return actToContent(g.value as ActResult);
      }
      const g = await guarded(guard, async () => null, () => legacy.runPs(legacyInputScript(), ["-Action", "type", "-Text", text]));
      if (g.blocked) return fail(g.blocked);
      const res = g.value as { code: number | null; out: string; err: string };
      return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
    },
  };

  const toolKey: Tool = {
    name: "computer_key",
    description: "Send a key combo to the target app (e.g. ctrl+s, {ENTER}). alt+f4 / win+* / ctrl+alt+del / ctrl+shift+esc are always denied. Guarded.",
    parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
    async run(args, ctx) {
      const blocked = requireEnabled(ctx);
      if (blocked) return fail(blocked);
      const keys = str(args, "keys");
      const denied = deniedKey(keys);
      if (denied) return fail(`denied: ${denied}`);
      const { backend } = resolveRunCtx(ctx);
      const t = guard?.getTarget();
      if (backend && t?.app) {
        const r = await backend.press(keys, { app: t.app });
        // UWP targets: press --app fails APP_NOT_FOUND → guarded legacy SendKeys
        if (!r.ok && r.code === "APP_NOT_FOUND" && r.delivery === "not_delivered") {
          const g = await guarded(guard, async () => null, () => legacy.runPs(legacyInputScript(), ["-Action", "key", "-Keys", keys]));
          if (g.blocked) return fail(g.blocked);
          const res = g.value as { code: number | null; out: string; err: string };
          return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
        }
        return actToContent(r);
      }
      const g = await guarded(guard, async () => null, () => legacy.runPs(legacyInputScript(), ["-Action", "key", "-Keys", keys]));
      if (g.blocked) return fail(g.blocked);
      const res = g.value as { code: number | null; out: string; err: string };
      return { ok: res.code === 0, content: res.out.trim() || res.err, untrusted: true };
    },
  };

  return [
    toolListWindows,
    toolFocusWindow,
    toolScreenshot,
    toolSnapshot,
    toolFind,
    toolAct,
    toolBatch,
    toolUiTree,
    toolUiList,
    toolUiClick,
    toolUiSetText,
    toolClick,
    toolType,
    toolKey,
  ];
}

/** Same export the runtime registers (src/setup/runtime.ts) — unchanged name. */
export const computerUseTools: Tool[] = makeFacadeTools(defaultDeps);

/** Tests build a facade with injected deps (fake probe, fake legacy, fake binary). */
export function makeComputerUseToolsForTest(deps: Partial<FacadeDeps>): Tool[] {
  return makeFacadeTools({ ...defaultDeps, ...deps });
}

export type { AdSnapshot };
