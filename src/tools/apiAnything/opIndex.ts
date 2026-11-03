import fs from "node:fs";
import path from "node:path";
import { log } from "../../log.js";
import { HOME_DIR, LOOKUP_REFRESH_MS, SITE_RE, bundledSitesDir } from "./constants.js";
import type { OpIndexEntry, SiteIndexEntry, SpecSource } from "./types.js";

interface RawOp { name?: unknown; readOnly?: unknown; params?: unknown; description?: unknown }
interface RawSite { baseUrl?: unknown; displayName?: unknown; loginCookies?: unknown; operations?: unknown; shared?: unknown }

export class OpIndex {
  private ops = new Map<string, OpIndexEntry>();
  private siteMap = new Map<string, SiteIndexEntry>();
  private lastRefresh = 0;

  constructor(
    private readonly dirs: () => Array<{ dir: string; source: SpecSource }>,
    private readonly now: () => number = Date.now,
  ) {}

  refresh(): void {
    const ops = new Map<string, OpIndexEntry>();
    const sites = new Map<string, SiteIndexEntry>();
    for (const { dir, source } of this.dirs()) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        const site = file.slice(0, -".json".length);
        if (!SITE_RE.test(site) || sites.has(site)) continue;
        let raw: RawSite;
        try {
          raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as RawSite;
        } catch (err) {
          log.warn(`api-anything: unreadable spec ${source}/${file}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : "";
        let host = "";
        try {
          host = new URL(baseUrl).hostname.toLowerCase();
        } catch {
          host = "";
        }
        const list = Array.isArray(raw.operations) ? (raw.operations as RawOp[]) : [];
        let writes = 0;
        for (const op of list) {
          if (typeof op.name !== "string" || !op.name) continue;
          const readOnly = op.readOnly === true;
          if (!readOnly) writes++;
          const params = Array.isArray(op.params)
            ? (op.params as Array<{ name?: unknown }>).flatMap((p) => (typeof p.name === "string" ? [p.name] : []))
            : [];
          ops.set(key(site, op.name), { site, op: op.name, readOnly, source, params });
        }
        sites.set(site, {
          site,
          displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
          baseUrl,
          host,
          source,
          ops: list.length,
          writes,
          loginCookies: Array.isArray(raw.loginCookies) ? raw.loginCookies.filter((c): c is string => typeof c === "string") : [],
          shared: raw.shared !== undefined,
        });
      }
    }
    this.ops = ops;
    this.siteMap = sites;
    this.lastRefresh = this.now();
  }

  /** Exact lookup; one throttled re-read on a miss (an op learned a moment ago). */
  lookup(site: string, op: string): OpIndexEntry | undefined {
    const hit = this.ops.get(key(site, op));
    if (hit) return hit;
    if (this.now() - this.lastRefresh < LOOKUP_REFRESH_MS) return undefined;
    this.refresh();
    return this.ops.get(key(site, op));
  }

  site(name: string): SiteIndexEntry | undefined {
    return this.siteMap.get(name);
  }

  sites(): SiteIndexEntry[] {
    return [...this.siteMap.values()].sort((a, b) => a.site.localeCompare(b.site));
  }

  operations(site: string): OpIndexEntry[] {
    return [...this.ops.values()].filter((o) => o.site === site);
  }
}

function key(site: string, op: string): string {
  return `${site}\u0000${op}`;
}

export const opIndex = new OpIndex(() => [
  { dir: path.join(HOME_DIR, "sites"), source: "user" },
  { dir: path.join(HOME_DIR, "registry"), source: "registry" },
  { dir: bundledSitesDir(), source: "bundled" },
]);
