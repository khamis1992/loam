import { createHash } from "node:crypto";
import type { EvidenceTimeline, TimelineEvent, TimelineKind } from "./evidenceTimeline.js";

export type InstrumentAction = "appium.capture-screen" | "appium.capture-network" | "frida.trace-methods" | "frida.review-storage";

export interface InstrumentationOptions {
  baseUrl: string;
  apiKey: string;
  deviceSerial: string;
  packageName: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const ALLOWED_ACTIONS = new Set<InstrumentAction>(["appium.capture-screen", "appium.capture-network", "frida.trace-methods", "frida.review-storage"]);

export class MobileInstrumentationProvider {
  constructor(private readonly options: InstrumentationOptions) {
    const url = new URL(options.baseUrl);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || !["http:", "https:"].includes(url.protocol)) throw new Error("instrumentation provider requires HTTPS outside loopback");
    if (!/^[A-Za-z0-9_.:-]+$/.test(options.deviceSerial) || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(options.packageName)) throw new Error("invalid instrumentation target");
  }

  async capture(timeline: EvidenceTimeline, tenantId: string, engagementId: string, action: InstrumentAction, relatedFindingIds: string[] = []): Promise<TimelineEvent> {
    if (!ALLOWED_ACTIONS.has(action)) throw new Error("instrumentation action is not allowlisted");
    const response = await (this.options.fetchFn ?? fetch)(this.options.baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ action, deviceSerial: this.options.deviceSerial, packageName: this.options.packageName }),
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    const text = (await response.text()).slice(0, 2_000_000);
    if (!response.ok) throw new Error(`instrumentation provider returned HTTP ${response.status}`);
    const result = JSON.parse(text) as { status?: unknown; content?: unknown };
    if (result.status !== "completed" || typeof result.content !== "string" || !result.content) throw new Error("instrumentation evidence is incomplete");
    const kind: TimelineKind = action === "appium.capture-screen" ? "screen" : action === "appium.capture-network" ? "request" : action === "frida.trace-methods" ? "code" : "device";
    return timeline.append(tenantId, engagementId, {
      kind,
      summary: `${action} on authorized package`,
      content: result.content,
      relatedFindingIds,
      artifactSha256: createHash("sha256").update(result.content).digest("hex"),
    });
  }
}
