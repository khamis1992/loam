import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type ConsoleMessage } from "playwright";
import type { Config } from "../config.js";
import { resolveWrite } from "../policy/paths.js";
import { log } from "../log.js";

/** One responsive capture target. `name` becomes the PNG file name. */
export interface ShotViewport {
  name: string;
  width: number;
  height: number;
}

/**
 * The three widths the design pipeline inspects: phone, tablet and desktop.
 * Mobile-first on purpose — the generated layout must hold at 375 px first.
 */
export const DEFAULT_VIEWPORTS: readonly ShotViewport[] = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

export interface ShotConsoleEntry {
  type: "console" | "pageerror" | "http";
  text: string;
  url?: string;
  line?: number;
  column?: number;
}

export interface ViewportShot {
  viewport: ShotViewport;
  /** Absolute PNG path. */
  file: string;
  /** Workspace-relative PNG path, safe to show the model. */
  relative: string;
  errors: ShotConsoleEntry[];
}

export interface ShotResult {
  ok: boolean;
  url: string;
  /** Absolute output directory that holds the PNGs. */
  dir: string;
  shots: ViewportShot[];
  /** Flat, de-duplicated error list across every viewport. */
  errors: string[];
  warnings: string[];
  /** True when the browser could not be launched or the URL was unusable. */
  unavailable?: boolean;
  message?: string;
  elapsedMs: number;
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function consoleLocation(message: ConsoleMessage): { url?: string; line?: number; column?: number } {
  const loc = message.location();
  return {
    ...(loc.url ? { url: loc.url } : {}),
    ...(typeof loc.lineNumber === "number" ? { line: loc.lineNumber } : {}),
    ...(typeof loc.columnNumber === "number" ? { column: loc.columnNumber } : {}),
  };
}

/**
 * Renders a generated site in a headless browser at several responsive
 * viewports and records what the page said while loading. Network access is
 * pinned to the captured origin: any other host is aborted, so a fixture or a
 * local preview never reaches the public internet during inspection.
 */
export class PreviewScreenshotService {
  constructor(private readonly cfg: Config) {}

  async capture(o: {
    workspace: string;
    url: string;
    outDir?: string;
    viewports?: readonly ShotViewport[];
    waitMs?: number;
    fullPage?: boolean;
    signal?: AbortSignal;
  }): Promise<ShotResult> {
    const started = Date.now();
    const viewports = o.viewports && o.viewports.length > 0 ? o.viewports : DEFAULT_VIEWPORTS;
    const origin = originOf(o.url);
    const result: ShotResult = { ok: false, url: o.url, dir: "", shots: [], errors: [], warnings: [], elapsedMs: 0 };
    if (!origin) {
      result.unavailable = true;
      result.message = `invalid url: ${o.url}`;
      result.elapsedMs = Date.now() - started;
      return result;
    }

    const dir = resolveWrite(o.workspace, o.outDir ?? path.join(".preview-shots", randomUUID()));
    result.dir = dir;
    fs.mkdirSync(dir, { recursive: true });

    const signal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(120_000)]);
    const warnings = new Set<string>();
    let browser: Browser | undefined;
    try {
      signal.throwIfAborted();
      browser = await chromium.launch({
        headless: true,
        ...(this.cfg.browser.channel ? { channel: this.cfg.browser.channel } : {}),
        timeout: 20_000,
      });
      for (const viewport of viewports) {
        signal.throwIfAborted();
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        await context.route("**/*", (route) => {
          const requestOrigin = originOf(route.request().url());
          if (requestOrigin === origin) return route.continue();
          return route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(15_000);
        const errors: ShotConsoleEntry[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") {
            errors.push({ type: "console", text: message.text(), ...consoleLocation(message) });
          } else if (message.type() === "warning") {
            warnings.add(message.text());
          }
        });
        page.on("pageerror", (error) => errors.push({ type: "pageerror", text: error.message }));
        page.on("response", (response) => {
          const url = response.url();
          if (response.status() >= 400 && originOf(url) === origin && !url.endsWith("/favicon.ico")) {
            errors.push({ type: "http", text: `HTTP ${response.status()} ${url}` });
          }
        });
        try {
          const response = await page.goto(o.url, { waitUntil: "load" });
          if (!response || !response.ok()) {
            throw new Error(`page failed to load (${response ? response.status() : "no response"})`);
          }
          if (o.waitMs && o.waitMs > 0) await page.waitForTimeout(o.waitMs);
          const file = path.join(dir, `${viewport.name}.png`);
          await page.screenshot({ path: file, fullPage: o.fullPage ?? true, animations: "disabled" });
          result.shots.push({
            viewport,
            file,
            relative: path.relative(o.workspace, file).split(path.sep).join("/"),
            errors,
          });
          result.errors.push(...errors.map((entry) => entry.text));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`[${viewport.name}] ${message}`);
        } finally {
          await context.close().catch(() => {});
        }
      }
      result.warnings = [...warnings];
      // The same page error is observed once per viewport; report it once.
      result.errors = [...new Set(result.errors)];
      result.ok = result.shots.length === viewports.length;
    } catch (error) {
      result.ok = false;
      result.unavailable = true;
      result.message = error instanceof Error ? error.message : String(error);
      log.warn(`preview screenshot failed: ${result.message}`);
    } finally {
      await browser?.close().catch(() => {});
      result.elapsedMs = Date.now() - started;
    }
    return result;
  }
}
