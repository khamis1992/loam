/**
 * Default red capability set (RED_TEAM_BUILD_SPEC §4.2 capability router).
 *
 * Bridge-driven engines (sqlmap/ZAP/ffuf/nuclei/ysoserial) are included only
 * when their bridge is enabled AND the engine is installed (bridge status
 * "ready"); the in-process SSRF modules are always available. This keeps a
 * stock machine on the safe blue fallback and adds red hands as engines are
 * installed and enabled one by one.
 */
import { bridgeInfo, getManifest } from "../../bridges/registry.js";
import type { Config } from "../../config.js";
import { deserCapability } from "./deser.js";
import { adversaryCapability } from "./advsim/capability.js";
import { ssrfCapability, type SsrfCapabilityOptions } from "./ssrf.js";
import { dastCapability } from "./web/dast.js";
import { fuzzCapability } from "./web/fuzz.js";
import { sqliCapability } from "./web/sqli.js";
import { templatesCapability } from "./templates.js";
import { apkCapability } from "./mobile/apk.js";
import { mitmCapability } from "./mobile/mitm.js";
import { binaryCapability } from "./binary.js";
import type { RedCapability } from "./orchestrator/redOrchestrator.js";

export interface DefaultCapabilityOptions {
  ssrf?: SsrfCapabilityOptions;
  ysoserialJar?: string;
  fuzzWordlistFile?: string;
  nucleiSeverity?: string;
  nucleiTags?: string;
  nucleiTemplatesPath?: string;
}

async function bridgeReady(cfg: Pick<Config, "bridges">, id: string): Promise<boolean> {
  const manifest = getManifest(id);
  if (!manifest) return false;
  const info = await bridgeInfo(cfg, manifest);
  return info.status === "ready";
}

/**
 * The capabilities a campaign runs by default: SSRF modules always; SQLi/DAST/
 * fuzz/templates when their engine bridge is ready; deser when ysoserial is.
 */
export async function defaultRedCapabilities(cfg: Pick<Config, "bridges">, opts: DefaultCapabilityOptions = {}): Promise<RedCapability[]> {
  const caps: RedCapability[] = [ssrfCapability({ mode: opts.ssrf?.probeTemplate ? "modules" : "oob", ...opts.ssrf }), deserCapability({ mode: "node" })];
  if (await bridgeReady(cfg, "red-sqlmap")) caps.push(sqliCapability());
  if (await bridgeReady(cfg, "red-zap")) caps.push(dastCapability({ daemon: true }));
  if (await bridgeReady(cfg, "red-ffuf")) caps.push(fuzzCapability({ wordlistFile: opts.fuzzWordlistFile }));
  if (await bridgeReady(cfg, "red-nuclei")) caps.push(templatesCapability({ severity: opts.nucleiSeverity, ...(opts.nucleiTags ? { tags: opts.nucleiTags } : {}), ...(opts.nucleiTemplatesPath ? { templatesPath: opts.nucleiTemplatesPath } : {}) }));
  if (await bridgeReady(cfg, "red-ysoserial")) caps.push(deserCapability({ jar: opts.ysoserialJar }));
  if (await bridgeReady(cfg, "red-caldera")) caps.push(adversaryCapability());
  if (await bridgeReady(cfg, "red-apktool")) caps.push(apkCapability());
  if (await bridgeReady(cfg, "red-mitmproxy")) caps.push(mitmCapability());
  // Binary analysis is always available: it is first-party, offline, no bridge.
  caps.push(binaryCapability());
  return caps;
}
