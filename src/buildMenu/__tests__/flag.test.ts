/**
 * Build-menu opt-in. Only boolean true, "1", and "true" enable the menu.
 * LOAM_BUILD_MENU is not a switch, and the default stays off.
 *
 * Run: node --import tsx --test src/buildMenu/__tests__/flag.test.ts
 */
import { isolatedDataDir } from "../../test/isolation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULTS, loadConfig, parseOptInFlag } from "../../config.js";

test("parseOptInFlag enables only true, 1, and true", () => {
  assert.equal(parseOptInFlag(true), true);
  assert.equal(parseOptInFlag("1"), true);
  assert.equal(parseOptInFlag("true"), true);
  assert.equal(parseOptInFlag("0"), false);
  assert.equal(parseOptInFlag(1), false);
  assert.equal(parseOptInFlag("yes"), false);
  assert.equal(parseOptInFlag(null), false);
  assert.equal(parseOptInFlag(undefined), false);
});

test("buildMenu.enabled defaults to false", () => {
  assert.equal(DEFAULTS.buildMenu?.enabled, false);
});

test("loadConfig applies the opt-in parser and ignores LOAM_BUILD_MENU", () => {
  const file = path.join(isolatedDataDir(), "build-menu-flag.json");
  const saved = {
    LOAM_CONFIG: process.env.LOAM_CONFIG,
    MANUS_LOCAL_CONFIG: process.env.MANUS_LOCAL_CONFIG,
    LOAM_BUILD_MENU: process.env.LOAM_BUILD_MENU,
  };
  const restore = (): void => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  function enabledFrom(body: unknown, buildMenuEnv?: string): boolean {
    fs.writeFileSync(file, JSON.stringify(body));
    process.env.LOAM_CONFIG = file;
    delete process.env.MANUS_LOCAL_CONFIG;
    if (buildMenuEnv === undefined) delete process.env.LOAM_BUILD_MENU;
    else process.env.LOAM_BUILD_MENU = buildMenuEnv;
    return loadConfig().buildMenu?.enabled === true;
  }

  try {
    assert.equal(enabledFrom({ buildMenu: { enabled: true } }), true);
    assert.equal(enabledFrom({ buildMenu: { enabled: "1" } }), true);
    assert.equal(enabledFrom({ buildMenu: { enabled: "true" } }), true);
    assert.equal(enabledFrom({ buildMenu: { enabled: "0" } }), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: 1 } }), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: "yes" } }), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: null } }), false);
    assert.equal(enabledFrom({}), false);
    assert.equal(enabledFrom({ buildMenu: {} }), false);
    assert.equal(enabledFrom({}, "1"), false);
    assert.equal(enabledFrom({}, "true"), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: false } }, "1"), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: true } }, "1"), true);
    assert.equal(DEFAULTS.buildMenu?.enabled, false);
  } finally {
    fs.rmSync(file, { force: true });
    restore();
  }
});
