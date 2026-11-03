import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { IntelCache } from "../intel/cache.js";
import { epssFor } from "../intel/epss.js";
import { KEV_FALLBACK_URL, KEV_URL, loadKev, resetKevMemo } from "../intel/kev.js";
import type { FetchFn } from "../intel/kev.js";
import { daysSince, pocConfidenceFromSources, pocPoints, riskLabelToScore, scoreCve } from "../intel/risk.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-intel-"));
/** Windows keeps sqlite WAL handles briefly after close; retry the cleanup. */
const rmTmp = (d: string): void => {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* WAL handle still held; harmless in the OS temp dir */ }
};

const KEV_DOC = {
  title: "CISA KEV",
  vulnerabilities: [
    { cveID: "CVE-2021-44228", dateAdded: "2021-12-10", dueDate: "2021-12-24", knownRansomwareCampaignUse: "Known" },
    { cveID: "CVE-2020-1472", dateAdded: "2020-08-17", dueDate: "2020-10-01", knownRansomwareCampaignUse: "Unknown" },
    { cveID: "not-a-cve", dateAdded: "", dueDate: "", knownRansomwareCampaignUse: "Unknown" },
  ],
};

test("intel cache: set/get, lazy expiry, negative markers, stats", () => {
  const d = tmp();
  try {
    const c = new IntelCache(path.join(d, "c.db"));
    c.set("k", { a: 1 }, 3600);
    assert.deepEqual(c.get<{ a: number }>("k"), { a: 1 });
    c.set("exp", { b: 2 }, -1); // already expired
    assert.equal(c.get("exp"), null);
    c.set("neg", { available: false }, 3600);
    assert.deepEqual(c.get<{ available: boolean }>("neg"), { available: false });
    assert.equal(c.get("missing"), null);
    assert.equal(c.stats().entries, 3, "the expired row is lazily invisible but physically present until the next open purges it");
    c.clear();
    assert.equal(c.stats().entries, 0);
    c.close();
    // Reopen survives on disk.
    const c2 = new IntelCache(path.join(d, "c.db"));
    assert.equal(c2.stats().entries, 0);
    c2.close();
  } finally { rmTmp(d); }
});

test("kev: primary source parses entries, memo avoids refetch, cache survives memo reset", async () => {
  const d = tmp();
  let fetches = 0;
  const fetchFn: FetchFn = async (url) => {
    fetches++;
    assert.equal(url, KEV_URL);
    return { ok: true, status: 200, json: async () => KEV_DOC };
  };
  try {
    const cache = new IntelCache(path.join(d, "c.db"));
    resetKevMemo();
    const r1 = await loadKev({ fetchFn, cache });
    assert.equal(r1.status, "ok");
    if (r1.status === "ok") {
      assert.equal(r1.entries.size, 2); // "not-a-cve" dropped
      assert.equal(r1.entries.get("CVE-2021-44228")?.ransomware, true);
      assert.equal(r1.entries.get("CVE-2020-1472")?.ransomware, false);
    }
    const r2 = await loadKev({ fetchFn, cache });
    assert.equal(fetches, 1, "memo serves the second call");
    resetKevMemo();
    const r3 = await loadKev({ fetchFn, cache });
    assert.equal(fetches, 1, "sqlite cache serves after memo reset");
    assert.equal(r3.status, "ok");
    cache.close();
  } finally { rmTmp(d); }
});

test("kev: falls back to the mirror, then reports unavailable — never throws", async () => {
  const d = tmp();
  const calls: string[] = [];
  let mode = "primary-down";
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    if (mode === "primary-down" && url === KEV_URL) return { ok: false, status: 503, json: async () => ({}) };
    if (mode === "all-down") return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => KEV_DOC };
  };
  try {
    const cache = new IntelCache(path.join(d, "c.db"));
    resetKevMemo();
    const r = await loadKev({ fetchFn, cache });
    assert.equal(r.status, "ok");
    assert.deepEqual(calls, [KEV_URL, KEV_FALLBACK_URL], "mirror is tried after the primary fails");
    resetKevMemo();
    cache.clear();
    mode = "all-down";
    const r2 = await loadKev({ fetchFn, cache });
    assert.equal(r2.status, "unavailable");
    cache.close();
  } finally { rmTmp(d); }
});

test("epss: chunks of 100, retries once, tolerates a failing chunk, caches negatives", async () => {
  const d = tmp();
  let calls = 0;
  const ids = Array.from({ length: 150 }, (_, i) => `CVE-2021-${10000 + i}`);
  const fetchFn: FetchFn = async (url) => {
    calls++;
    if (url.includes(ids[149]!)) return { ok: false, status: 500, json: async () => ({}) }; // second chunk always fails
    const q = url.split("cve=")[1] ?? "";
    const asked = decodeURIComponent(q.split("&")[0] ?? "").split(",").filter(Boolean);
    return { ok: true, status: 200, json: async () => ({ data: asked.filter((c) => c !== ids[0]).map((c) => ({ cve: c, epss: "0.5", percentile: "0.9" })) }) };
  };
  try {
    const cache = new IntelCache(path.join(d, "c.db"));
    const r = await epssFor(ids, { fetchFn, cache, sleep: async () => {} });
    assert.equal(r.scores.size, 99, "100 asked minus the one EPSS has no score for");
    assert.equal(r.scores.get(ids[1]!)?.epss, 0.5);
    assert.ok(r.unreachable);
    assert.equal(r.missing, 50, "the failed 50-id chunk counts as not answered");
    // ids[0] got a negative marker; the successful chunk is cached: a second pass fetches only the failed chunk again.
    const before = calls;
    const r2 = await epssFor(ids, { fetchFn, cache, sleep: async () => {} });
    assert.equal(r2.scores.size, 99);
    assert.equal(calls - before, 2, "retry of the failed chunk only (once per attempt)");
    cache.close();
  } finally { rmTmp(d); }
});

test("risk: log4shell is critical, KEV floors at 76, low stays low", () => {
  const kev = { cve: "CVE-2021-44228", dateAdded: "2021-12-10", dueDate: "", ransomware: true };
  const log4shell = scoreCve({ cveId: "CVE-2021-44228", cvssScore: 10, published: "2021-12-10", epssProbability: 0.975, kev });
  assert.equal(log4shell.risk_label, "CRITICAL");
  assert.ok(log4shell.risk_score >= 76);
  assert.deepEqual(log4shell.boosters_applied, ["CVSS>=9+EPSS>0.7"]);

  const floor = scoreCve({ cveId: "CVE-2000-0001", cvssScore: 2, published: "2000-01-01", epssProbability: 0.01, kev: { cve: "CVE-2000-0001", dateAdded: "", dueDate: "", ransomware: false } });
  assert.equal(floor.risk_score, 76);
  assert.equal(floor.risk_label, "CRITICAL");

  const low = scoreCve({ cveId: "CVE-2000-0001", cvssScore: 2, published: "2000-01-01", epssProbability: 0.01 });
  assert.equal(low.risk_label, "LOW");
  assert.equal(low.urgency, "SCHEDULE FOR NEXT CYCLE");
});

test("risk: WEAPONIZED without KEV scores 25 and stays LOW", () => {
  const r = scoreCve({ cveId: "CVE-2000-0001", cvssScore: 5, published: "2000-01-01", epssProbability: 0, pocConfidence: "WEAPONIZED" });
  assert.equal(r.scoring_version, "1.1");
  assert.equal(r.components.poc_contribution, 15);
  assert.equal(r.risk_score, 25);
  assert.equal(r.risk_label, "LOW");
});

test("risk: band edges, urgency ladder and booster stacking", () => {
  const now = new Date("2026-10-24T00:00:00Z");
  // 50 exactly (CVSS 8 -> 16 + EPSS 34/35 -> 34); cvss<9 keeps the booster off.
  const mid = scoreCve({ cveId: "CVE-2024-1", cvssScore: 8, published: "2020-01-01", epssProbability: 34 / 35 });
  assert.equal(mid.risk_score, 50);
  assert.equal(mid.risk_label, "MEDIUM");
  // Ceiling without KEV: base 70 (20+35+15) x 1.10 = 77 -> CRITICAL via multipliers alone.
  const ceiling = scoreCve({ cveId: "CVE-2024-2", cvssScore: 10, published: "2020-01-01", epssProbability: 1.0, pocConfidence: "WEAPONIZED" });
  assert.equal(ceiling.risk_score, 77);
  assert.equal(ceiling.risk_label, "CRITICAL");
  const belowCeiling = scoreCve({ cveId: "CVE-2024-2b", cvssScore: 10, published: "2020-01-01", epssProbability: 0.99, pocConfidence: "PUBLIC_EXPLOIT" });
  assert.equal(belowCeiling.risk_label, "HIGH");

  const fresh = scoreCve({ cveId: "CVE-2026-10", cvssScore: 10, published: "2026-10-20", epssProbability: 0.8, now });
  assert.deepEqual(fresh.boosters_applied, ["CVSS>=9+EPSS>0.7", "Published<7days"]);
  assert.ok(fresh.risk_score > (20 + 28) * 1.1, "multipliers stack multiplicatively");

  assert.equal(scoreCve({ cveId: "CVE-2024-3", cvssScore: 9, published: "2020-01-01", epssProbability: 0.6 }).urgency, "PATCH WITHIN 72 HOURS");
  assert.equal(scoreCve({ cveId: "CVE-2024-4", cvssScore: 9.5, published: "2020-01-01", epssProbability: 0.1 }).urgency, "PATCH THIS WEEK");
  assert.equal(scoreCve({ cveId: "CVE-2024-5", cvssScore: 7, published: "2020-01-01" }).urgency, "PATCH THIS MONTH");
  const imm = scoreCve({ cveId: "CVE-2024-6", cvssScore: 8, published: "2020-01-01", epssProbability: 0.9, kev: { cve: "CVE-2024-6", dateAdded: "", dueDate: "", ransomware: false } });
  assert.equal(imm.urgency, "PATCH IMMEDIATELY");
});

test("risk: poc ladder, confidence derivation, daysSince and label mapping", () => {
  assert.deepEqual(
    (["WEAPONIZED", "PUBLIC_EXPLOIT_REMOTE", "PUBLIC_EXPLOIT", "PUBLIC_POC_HIGH_QUALITY", "PUBLIC_POC_LOW_QUALITY", "NONE"] as const).map(pocPoints),
    [15, 12, 10, 7, 3, 0],
  );
  assert.equal(pocConfidenceFromSources({ metasploitExploits: [{}] }), "WEAPONIZED");
  assert.equal(pocConfidenceFromSources({ exploitDbRemote: true, anyGithubRepo: true }), "PUBLIC_EXPLOIT_REMOTE");
  assert.equal(pocConfidenceFromSources({ nucleiTemplates: [{}] }), "PUBLIC_POC_HIGH_QUALITY");
  assert.equal(pocConfidenceFromSources({ anyGithubRepo: true }), "PUBLIC_POC_LOW_QUALITY");
  assert.equal(pocConfidenceFromSources({}), "NONE");
  assert.equal(daysSince("2026-10-17", new Date("2026-10-24T00:00:00Z")), 7);
  assert.equal(daysSince("2026-10-17T12:00:00", new Date("2026-10-24T12:00:00Z")), 7);
  assert.equal(daysSince("garbage"), null);
  assert.equal(riskLabelToScore("CRITICAL"), "critical");
  assert.equal(riskLabelToScore("LOW"), "low");
});
