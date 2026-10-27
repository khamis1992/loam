import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EvidenceCipher } from "../../enterprise/crypto.js";
import { inspectMobileArtifact } from "../artifacts.js";
import { MobileEngagementStore } from "../engagement.js";
import { buildProtectedMobileReport, readProtectedMobileMarkdown } from "../secureReport.js";

test("KMS-enabled reports are encrypted at rest and decrypt only with tenant binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-secure-report-"));
  fs.writeFileSync(path.join(root, "app.apk"), "fixture");
  const artifact = await inspectMobileArtifact(path.join(root, "app.apk"), root);
  const state = new MobileEngagementStore(root).create({ tenantId: "tenant-a", ownerId: "analyst-a", artifacts: [artifact] });
  const key = randomBytes(32);
  const cipher = new EvidenceCipher({ dataKey: async () => key });
  const report = await buildProtectedMobileReport(state, path.join(root, "report"), cipher);
  assert.equal(report.encrypted, true);
  assert.ok(!fs.existsSync(path.join(root, "report", "mobile-report.md")));
  assert.ok(!fs.readFileSync(report.markdownPath, "utf8").includes("MASVS"));
  assert.ok((await readProtectedMobileMarkdown(report, state, cipher)).includes("MASVS"));
  const other = new MobileEngagementStore(root).create({ tenantId: "tenant-b", ownerId: "analyst-b", artifacts: [artifact] });
  await assert.rejects(() => readProtectedMobileMarkdown(report, other, cipher));
});
