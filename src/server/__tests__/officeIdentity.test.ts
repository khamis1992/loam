import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** د2: the office identity is settings-driven. Defaults keep the legacy
 * admin/"local" behavior; a configured name/role flows into every office
 * run, approval and audit record. DATA_DIR is isolated per process. */
process.env.MANUS_LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-identity-"));
const { loadSettings, updateSettings } = await import("../settings.js");
const { localOfficeIdentity } = await import("../../office/intelligence/authorization.js");

test("identity defaults to the legacy admin/local when nothing is configured", () => {
  loadSettings();
  const identity = localOfficeIdentity();
  assert.equal(identity.id, "local");
  assert.deepEqual(identity.roles, ["admin"]);
  assert.deepEqual(identity.tenantIds, ["local"]);
});

test("a configured name and role flow into the acting identity", () => {
  updateSettings({ officeIdentity: { name: "  خالد الجابر  ", role: "partner" } });
  const identity = localOfficeIdentity();
  assert.equal(identity.id, "خالد الجابر");
  assert.deepEqual(identity.roles, ["partner"]);
  // and it persists through a settings reload (the loader whitelists it).
  const reloaded = loadSettings();
  assert.equal(reloaded.officeIdentity?.name, "خالد الجابر");
  assert.equal(reloaded.officeIdentity?.role, "partner");
});

test("an unknown role falls back to admin; an empty identity clears to defaults", () => {
  updateSettings({ officeIdentity: { name: "سارة", role: "superuser" as never } });
  assert.deepEqual(localOfficeIdentity().roles, ["admin"]);
  updateSettings({ officeIdentity: {} });
  assert.equal(localOfficeIdentity().id, "local");
  assert.equal(loadSettings().officeIdentity, undefined);
});
