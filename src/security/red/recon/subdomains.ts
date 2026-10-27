/**
 * Passive subdomain discovery (Supremacy M3.1): certificate transparency
 * (crt.sh) + HackerTarget API, for domains you own. No active DNS bruteforce,
 * no third-party harm. Results feed nuclei scans and recon fingerprinting.
 */
import type { AuthorizationRecord } from "../gate.js";

export interface DiscoveredSubdomain {
  subdomain: string;
  source: "crt.sh" | "hackertarget";
}

const isValidSubdomain = (sub: string, root: string): boolean => {
  if (!sub || sub.length > 253 || !/^[a-z0-9*.-]+$/i.test(sub)) return false;
  const normalized = sub.toLowerCase().replace(/^\*\./, "");
  const rootNorm = root.toLowerCase().replace(/^\*\./, "");
  return normalized === rootNorm || normalized.endsWith(`.${rootNorm}`);
};

async function fetchCrtSh(domain: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const doc = (await res.json()) as Array<{ name_value?: string }>;
  const names = new Set<string>();
  for (const entry of doc) {
    if (typeof entry.name_value !== "string") continue;
    for (const name of entry.name_value.split(/\n/)) {
      const clean = name.trim().replace(/^\*\./, "");
      if (isValidSubdomain(clean, domain)) names.add(clean.toLowerCase());
    }
  }
  return [...names];
}

async function fetchHackerTarget(domain: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`;
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const text = await res.text();
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const [host] = line.split(",");
    if (typeof host === "string" && isValidSubdomain(host.trim(), domain)) names.add(host.trim().toLowerCase());
  }
  return [...names];
}

/**
 * Discover subdomains for an owned domain via passive sources only.
 * The caller is responsible for gate-checking the root domain.
 */
export async function discoverSubdomains(
  domain: string,
  authz: AuthorizationRecord | null,
  signal?: AbortSignal,
): Promise<DiscoveredSubdomain[]> {
  const clean = domain.toLowerCase().trim().replace(/\.$/, "");
  if (!clean || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) return [];
  // Gate: the root domain or a parent must be in the allow-list.
  const inScope = !authz || authz.scope.allowHosts.some((h) => {
    const entry = h.toLowerCase();
    return entry === clean || clean.endsWith(`.${entry}`) || entry === `*.${clean}`;
  });
  if (!inScope) return [];

  const out = new Map<string, DiscoveredSubdomain>();
  const [crt, hacker] = await Promise.allSettled([fetchCrtSh(clean, signal), fetchHackerTarget(clean, signal)]);
  if (crt.status === "fulfilled") for (const s of crt.value) if (!out.has(s)) out.set(s, { subdomain: s, source: "crt.sh" });
  if (hacker.status === "fulfilled") for (const s of hacker.value) if (!out.has(s)) out.set(s, { subdomain: s, source: "hackertarget" });
  return [...out.values()].slice(0, 100);
}
