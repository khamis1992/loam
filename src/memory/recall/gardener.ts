import { applyDecay, applyForgetting } from "./decay.js";
import { defaultRecallConfig } from "./defaults.js";
import { nremFuse, remAssociate } from "./dream.js";
import { isIdle } from "./idle.js";
import { rememberFact } from "./link.js";
import type { RecallRepo } from "./repo.js";
import type { GardenerReport, RecallConfig, TextModel } from "./types.js";
import { newId } from "./vectors.js";

export interface TickOptions {
  force?: boolean;
  now?: number;
  catchUp?: boolean;
}

export function riyadhHour(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "0";
  return Number(hour);
}

export function inQuietHours(ms: number, window: [number, number]): boolean {
  const hour = riyadhHour(ms);
  return hour >= window[0] && hour < window[1];
}

export async function runGardenerTick(
  repo: RecallRepo,
  config: RecallConfig,
  kind: "light" | "deep" | "sleep",
  model: TextModel | undefined,
  opts: TickOptions = {},
): Promise<GardenerReport> {
  const now = opts.now ?? Date.now();
  const steps: GardenerReport["steps"] = [];
  let catchUp = opts.catchUp ?? false;
  if (kind === "sleep" && !opts.force) {
    const last = repo.lastSleepAt();
    const due = last === undefined || now - last >= config.gardener.sleepEveryH * 3_600_000;
    const quiet = inQuietHours(now, config.gardener.quietHours);
    const idle = !config.gardener.onlyWhenIdle || isIdle();
    if (!idle) return { tick: kind, catchUp: false, steps: [{ name: "idle-gate", ok: false, ms: 0, error: "foreground run active" }] };
    if (!due) return { tick: kind, catchUp: false, steps: [{ name: "schedule", ok: true, ms: 0, detail: "not due" }] };
    if (!quiet) {
      const missed = last !== undefined && now - last >= config.gardener.sleepEveryH * 3_600_000;
      if (!missed) return { tick: kind, catchUp: false, steps: [{ name: "quiet-hours", ok: true, ms: 0, detail: "waiting" }] };
      catchUp = true;
    }
  }
  if ((kind === "deep" || kind === "light") && config.gardener.onlyWhenIdle && !isIdle() && !opts.force) {
    return { tick: kind, catchUp, steps: [{ name: "idle-gate", ok: false, ms: 0, error: "foreground run active" }] };
  }

  const run = async (name: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - started, detail });
    } catch (error) {
      steps.push({ name, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  };

  if (kind === "light" || kind === "deep" || kind === "sleep") await run("decay", () => applyDecay(repo, config, now));
  if (kind === "deep" || kind === "sleep") await run("forget", () => applyForgetting(repo, config, now));
  if (kind === "sleep") {
    await run("nrem", () => nremFuse({ repo, config, model, now }));
    await run("rem", () => remAssociate({ repo, config, model, now }));
    await run("reflection", () => reflect(repo, model, now));
  }
  const report: GardenerReport = { tick: kind, catchUp, steps };
  repo.saveRun(newId("gard_"), kind, catchUp, now, report);
  return report;
}

async function reflect(repo: RecallRepo, model: TextModel | undefined, now: number): Promise<{ insights: number }> {
  if (!model) return { insights: 0 };
  const recent = repo.latest(undefined, ["active"]).slice(0, 20);
  if (recent.length === 0) return { insights: 0 };
  const result = await model.complete(
    "Summarise the day into at most 5 insight sentences. Reply with JSON {\"insights\":string[]}.",
    recent.map((memory) => memory.content).join("\n"),
    { temperature: 0.2, timeoutMs: 20_000 },
  );
  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) return { insights: 0 };
  const parsed = JSON.parse(match[0]) as { insights?: unknown };
  const insights = Array.isArray(parsed.insights) ? parsed.insights.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
  for (const content of insights) {
    await rememberFact(repo, defaultRecallConfig(), undefined, undefined, {
      content, scope: "user", kind: "insight", origin: "reflection",
    }, now);
  }
  return { insights: insights.length };
}

export function startGardener(repo: RecallRepo, config: RecallConfig, model: () => TextModel | undefined): () => void {
  const light = setInterval(() => { void runGardenerTick(repo, config, "light", model()); }, config.gardener.lightEveryMin * 60_000);
  const deep = setInterval(() => { void runGardenerTick(repo, config, "deep", model()); }, config.gardener.deepEveryMin * 60_000);
  const sleep = setInterval(() => { void runGardenerTick(repo, config, "sleep", model()); }, 10 * 60_000);
  light.unref?.();
  deep.unref?.();
  sleep.unref?.();
  return () => {
    clearInterval(light);
    clearInterval(deep);
    clearInterval(sleep);
  };
}
