import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildCatalogPlan, catalogCoverage } from "../planner.js";
import { CATALOG_SEED_COUNT, seedVulnerabilityCatalog } from "../seed.js";
import { VulnerabilityCatalogStore, validateVulnerabilityRecord } from "../store.js";
import { createAuthorizationRecord } from "../../red/gate.js";
import type { VulnerabilityRecord } from "../types.js";

const tempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-catalog-"));

describe("vulnerability catalog", () => {
  it("persists and filters the complete versioned seed catalog", () => {
    const store = new VulnerabilityCatalogStore(path.join(tempRoot(), "catalog.sqlite"));
    assert.equal(seedVulnerabilityCatalog(store), CATALOG_SEED_COUNT);
    assert.ok(CATALOG_SEED_COUNT >= 75);
    const stats = store.stats();
    assert.equal(stats.total, CATALOG_SEED_COUNT);
    assert.ok((stats.byPlatform.web ?? 0) >= 35);
    assert.ok((stats.byPlatform.android ?? 0) >= 25);
    assert.ok((stats.byPlatform.ios ?? 0) >= 25);
    assert.equal(store.get("web-sql-injection")?.validationKey, "http.injection");
    assert.ok(store.list({ platform: "web", cwe: "CWE-89" }).length >= 1);
    assert.ok(store.list({ category: "reverse-engineering" }).every((record) => record.reverseEngineering));
    assert.throws(() => validateVulnerabilityRecord({ ...store.get("web-sql-injection")!, cwe: [] }));
    store.close();
  });

  it("plans dynamic and reverse-engineering stages only within active scope", () => {
    const root = tempRoot();
    const store = new VulnerabilityCatalogStore(path.join(root, "catalog.sqlite"));
    seedVulnerabilityCatalog(store);
    const authz = createAuthorizationRecord({ statement: "catalog lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [80], allowUrlPrefixes: [], denyAlways: [] } });
    const records = store.list({ limit: 1000 });
    const plan = buildCatalogPlan(records, { platform: "web", technologies: ["sql", "rest"], target: "http://127.0.0.1/", authorization: authz });
    assert.ok(plan.some((item) => item.vulnerabilityId === "web-sql-injection" && item.stage === "dynamic" && item.status === "planned"));
    assert.ok(plan.some((item) => item.stage === "retest"));
    const blocked = buildCatalogPlan(records, { platform: "web", technologies: ["load"], target: "http://127.0.0.1/", authorization: null });
    assert.equal(blocked.find((item) => item.vulnerabilityId === "web-denial-of-service")?.status, "blocked");
    assert.equal(catalogCoverage(blocked).clean, false);
    const reverse = buildCatalogPlan(records, { platform: "android", technologies: ["dex", "jadx"], target: "http://127.0.0.1/", authorization: authz });
    assert.ok(reverse.some((item) => item.vulnerabilityId === "re-dex-endpoints" && item.stage === "reverse-engineering"));
    store.close();
  });

  it("marks unknown validators unavailable rather than clean", () => {
    const record: VulnerabilityRecord = {
      id: "custom-unknown",
      kind: "class",
      title: "Custom",
      description: "Custom class",
      platforms: ["web"],
      categories: ["custom"],
      cwe: ["CWE-1"],
      capec: [],
      owasp: [],
      severity: "info",
      prerequisites: [],
      detectionMethods: ["manual"],
      validationKey: "custom.missing",
      evidenceRequired: ["evidence"],
      techHints: [],
      reverseEngineering: false,
      action: "read-only",
      impact: "unknown",
      remediation: "review",
    };
    const plan = buildCatalogPlan([record], { platform: "web", technologies: [], target: "http://127.0.0.1/", authorization: null });
    assert.equal(plan[0]?.status, "unavailable");
    assert.equal(catalogCoverage(plan).clean, false);
  });
});
