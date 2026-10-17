import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SCRIPTS_DIR } from "../config.js";
import { log } from "../log.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

const UI_SCRIPT = path.join(SCRIPTS_DIR, "win-ui.ps1");
const INPUT_SCRIPT = path.join(SCRIPTS_DIR, "input.ps1");

function runPs(script: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { windowsHide: true, env: { ...process.env } },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/* ---------- physical input via nut.js (native; PS stays read-only & unflagged) ---------- */

interface NutMouse {
  config: { autoDelayMs: number; mouseSpeed: number };
  setPosition(p: unknown): Promise<void>;
  leftClick(): Promise<void>;
  rightClick(): Promise<void>;
}
interface NutModule {
  mouse: NutMouse;
  Point: new (x: number, y: number) => unknown;
}

let nut: NutModule | null = null;
let nutError: string | null = null;

async function getNut(): Promise<NutModule | null> {
  if (nut) return nut;
  try {
    const mod = (await import("@nut-tree-fork/nut-js")) as unknown as NutModule;
    mod.mouse.config.autoDelayMs = 0;
    mod.mouse.config.mouseSpeed = 6000;
    nut = mod;
    return nut;
  } catch (err) {
    nutError = err instanceof Error ? err.message : String(err);
    log.warn(`nut.js unavailable: ${nutError}`);
    return null;
  }
}

async function clickPoint(x: number, y: number, button: "left" | "right" = "left"): Promise<string> {
  const n = await getNut();
  if (!n) return `physical input unavailable (${nutError ?? "nut.js not installed"})`;
  await n.mouse.setPosition(new n.Point(x, y));
  if (button === "right") await n.mouse.rightClick();
  else await n.mouse.leftClick();
  return `clicked ${button} at ${x},${y}`;
}

function parseJson(out: string): Record<string, unknown> | null {
  const lines = out
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{") || l.trim().startsWith("["));
  const line = lines[lines.length - 1];
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requireEnabled(ctx: ToolContext): string | null {
  if (!ctx.cfg.computerUse.enabled) return "computer use is disabled in config (computerUse.enabled=false)";
  if (process.platform !== "win32") return "computer use tools are Windows-only in this build";
  return null;
}

function targetArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (args["index"] !== undefined) out.push("-Index", String(num(args, "index", -1)));
  const name = str(args, "name");
  if (name) out.push("-Name", name);
  const role = str(args, "role");
  if (role) out.push("-Role", role);
  return out;
}

export const computerUseTools: Tool[] = [
  {
    name: "computer_screenshot",
    description: "Capture the whole screen to a PNG file and return its path. Use it to see the current desktop state.",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      fs.mkdirSync(ctx.cfg.computerUse.screenshotDir, { recursive: true });
      const name = str(args, "name") || `screen_${Date.now()}`;
      const out = path.join(ctx.cfg.computerUse.screenshotDir, `${name}.png`);
      const res = await runPs(UI_SCRIPT, ["-Action", "screenshot", "-Out", out]);
      return { ok: res.code === 0, content: res.out.trim() || res.err };
    },
  },
  {
    name: "computer_list_windows",
    description: "List visible top-level windows (title, pid, position, size) as JSON.",
    parameters: { type: "object", properties: {} },
    async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const res = await runPs(UI_SCRIPT, ["-Action", "list_windows"]);
      return { ok: res.code === 0, content: res.out.trim() || res.err };
    },
  },
  {
    name: "computer_focus_window",
    description: "Give keyboard focus to a window whose title contains the given text.",
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const res = await runPs(UI_SCRIPT, ["-Action", "ui_focus_window", "-Title", str(args, "title")]);
      return { ok: res.code === 0, content: res.out.trim() || res.err };
    },
  },
  {
    name: "computer_ui_tree",
    description:
      "Dump the accessibility tree of the foreground window as indexed lines: [index] depth Role 'name' @x,y wxh. Use the index with computer_ui_click / computer_ui_set_text.",
    parameters: { type: "object", properties: { depth: { type: "number" } } },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const depth = Math.min(Math.max(num(args, "depth", 3), 1), 8);
      const res = await runPs(UI_SCRIPT, ["-Action", "ui_tree", "-Depth", String(depth)]);
      return { ok: res.code === 0, content: res.out.trim() || res.err };
    },
  },
  {
    name: "computer_ui_list",
    description:
      "Search the foreground window's accessibility tree by name/role and return matching elements with stable indexes and bounds. Use the index with computer_ui_click / computer_ui_set_text.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Substring of the accessible name." },
        role: { type: "string", description: "Control type, e.g. Button, Edit, MenuItem." },
        max: { type: "number" },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const a = ["-Action", "ui_elements", "-Max", String(Math.min(Math.max(num(args, "max", 60), 1), 200))];
      const name = str(args, "name");
      if (name) a.push("-Name", name);
      const role = str(args, "role");
      if (role) a.push("-Role", role);
      const res = await runPs(UI_SCRIPT, a);
      return { ok: res.code === 0, content: res.out.trim() || res.err };
    },
  },
  {
    name: "computer_ui_click",
    description:
      "Click a UI element in the foreground window by index (from computer_ui_tree/computer_ui_list) or by name/role. The element is resolved through accessibility, then clicked at its center.",
    parameters: {
      type: "object",
      properties: { index: { type: "number" }, name: { type: "string" }, role: { type: "string" } },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      if (args["index"] === undefined && !str(args, "name") && !str(args, "role")) {
        return { ok: false, content: "provide index, or name/role" };
      }
      const res = await runPs(UI_SCRIPT, ["-Action", "ui_bounds", ...targetArgs(args)]);
      const info = parseJson(res.out);
      if (!info) return { ok: false, content: res.out.trim() || res.err };
      if (info["found"] !== true) return { ok: false, content: JSON.stringify(info) };
      const x = (Number(info["x"]) || 0) + Math.floor((Number(info["w"]) || 0) / 2);
      const y = (Number(info["y"]) || 0) + Math.floor((Number(info["h"]) || 0) / 2);
      const clicked = await clickPoint(x, y);
      return { ok: true, content: `element '${String(info["name"] ?? "")}' [${String(info["role"] ?? "")}] → ${clicked}` };
    },
  },
  {
    name: "computer_ui_set_text",
    description:
      "Set the text of an edit field in the foreground window (by index or name/role). Uses the accessibility ValuePattern when available; otherwise focuses/clicks the field and pastes from the clipboard.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, index: { type: "number" }, name: { type: "string" }, role: { type: "string" } },
      required: ["text"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const text = str(args, "text");
      const res = await runPs(UI_SCRIPT, ["-Action", "ui_set_value", "-Text", text, ...targetArgs(args)]);
      const info = parseJson(res.out);
      if (!info) return { ok: false, content: res.out.trim() || res.err };
      if (info["result"] === "set_value") return { ok: true, content: `set value on '${String(info["name"] ?? "")}'` };
      if (info["result"] === "focus_then_type") {
        if (typeof info["x"] === "number" && typeof info["y"] === "number") {
          await clickPoint(info["x"], info["y"]);
        }
        const typed = await runPs(INPUT_SCRIPT, ["-Action", "type", "-Text", text]);
        return { ok: typed.code === 0, content: `focused '${String(info["name"] ?? "")}' → ${typed.out.trim() || typed.err}` };
      }
      return { ok: false, content: JSON.stringify(info) };
    },
  },
  {
    name: "computer_click",
    description: "Move the real mouse to screen coordinates and click (fallback for targets with no accessible element).",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, right: { type: "boolean" } },
      required: ["x", "y"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const clicked = await clickPoint(num(args, "x", 0), num(args, "y", 0), args["right"] === true ? "right" : "left");
      return { ok: !clicked.startsWith("physical input unavailable"), content: clicked };
    },
  },
  {
    name: "computer_type",
    description: "Type text into the currently focused control (clipboard paste; supports unicode/Arabic).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const res = await runPs(INPUT_SCRIPT, ["-Action", "type", "-Text", str(args, "text")]);
      return { ok: res.code === 0, content: res.out.trim() || res.err };
    },
  },
  {
    name: "computer_key",
    description: "Send a key combination to the focused window using SendKeys syntax (e.g. {ENTER}, ^s, %{F4}).",
    parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const blocked = requireEnabled(ctx);
      if (blocked) return { ok: false, content: blocked };
      const res = await runPs(INPUT_SCRIPT, ["-Action", "key", "-Keys", str(args, "keys")]);
      return { ok: res.code === 0, content: res.out.trim() || res.err };
    },
  },
];
