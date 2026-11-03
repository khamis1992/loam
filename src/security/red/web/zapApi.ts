/**
 * Headless ZAP REST API driver (spec §6.3). quickscan's GUI path is unusable in
 * headless environments; daemon + REST is the supported mode.
 */
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";
import type { ZapAlert } from "./dast.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForZap(base: string, ctx: RedCapabilityContext, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await ctx.transport.request(`${base}/JSON/core/view/version`);
      if (res.status === 200) return;
      lastStatus = res.status;
    } catch {
      /* daemon is still starting */
    }
    await sleep(1000);
  }
  throw new Error(`ZAP daemon did not become ready (last HTTP ${lastStatus})`);
}

async function zapJson(base: string, path: string, ctx: RedCapabilityContext, method: "GET" | "POST" = "GET", form?: Record<string, string>): Promise<unknown> {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const res = await ctx.transport.request(`${base}${path}`, {
    method,
    ...(form ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body } : {}),
  });
  if (res.status !== 200) throw new Error(`ZAP API ${path}: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`ZAP API ${path}: non-JSON response`);
  }
}

async function waitForScan(kind: "spider" | "ascan", id: string, base: string, ctx: RedCapabilityContext, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = (await zapJson(base, `/JSON/${kind}/view/status/?scanId=${encodeURIComponent(id)}`, ctx)) as { status?: string };
    const status = String(doc.status ?? "");
    if (status === "finished" || status === "stopped" || status === "100") return;
    await sleep(1000);
  }
  throw new Error(`ZAP ${kind} scan ${id} did not finish`);
}

/** Start ZAP daemon via the bridge, wait for readiness, spider + active scan, then read alerts. */
export async function scanZapWithDaemon(
  jar: string,
  port: number,
  target: string,
  ctx: RedCapabilityContext,
): Promise<ZapAlert[]> {
  if (!ctx.bridgeDaemon) throw new Error("runBridgeDetached is required for daemon-based DAST");
  const base = `http://127.0.0.1:${port}`;
  const daemon = await ctx.bridgeDaemon("red-zap", "daemon", { jar, port });
  try {
    await waitForZap(base, ctx);
    const spider = (await zapJson(base, "/JSON/spider/action/scan/", ctx, "POST", {
      url: target,
      maxChildren: "10",
      recurse: "true",
      subtreeOnly: "false",
    })) as { scan?: string };
    if (!spider.scan) throw new Error("ZAP spider did not return a scan id");
    await waitForScan("spider", spider.scan, base, ctx, 120_000);

    const active = (await zapJson(base, "/JSON/ascan/action/scan/", ctx, "POST", {
      url: target,
      recurse: "false",
      inScopeOnly: "true",
    })) as { scan?: string };
    if (!active.scan) throw new Error("ZAP active scan did not return a scan id");
    await waitForScan("ascan", active.scan, base, ctx, 180_000);

    const doc = (await zapJson(base, `/JSON/core/view/alerts/?baseurl=${encodeURIComponent(target)}&start=0&count=100`, ctx)) as { alerts?: unknown[] };
    const out: ZapAlert[] = [];
    for (const raw of doc.alerts ?? []) {
      const a = raw as Record<string, unknown>;
      if (typeof a.alert !== "string" || a.riskcode === undefined) continue;
      out.push({
        pluginid: String(a.pluginId ?? a.pluginid ?? ""),
        name: a.alert,
        riskcode: String(a.riskcode),
        uri: String(a.url ?? target),
        ...(typeof a.description === "string" ? { description: a.description } : {}),
        ...(typeof a.solution === "string" ? { solution: a.solution } : {}),
      });
    }
    return out;
  } finally {
    daemon.stop();
  }
}
