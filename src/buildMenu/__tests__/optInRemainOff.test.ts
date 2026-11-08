/**
 * Lookalike opt-in values stay off. Case variants, padding, and nearby
 * strings do not enable the build menu. LOAM_BUILD_MENU is not a switch,
 * and the default stays false.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/optInRemainOff.test.ts
 */
import { isolatedDataDir } from "../../test/isolation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULTS, loadConfig, parseOptInFlag } from "../../config.js";

const REMAIN_OFF = [
  "TRUE",
  "True",
  "YES",
  "Yes",
  "ON",
  "On",
  "false",
  "off",
  "no",
  "",
  " true",
  "true ",
  "1 ",
  " 1",
  "01",
  "1.0",
  "yes ",
  "on ",
  "YES ",
  "ON ",
] as const;

test("parseOptInFlag leaves lookalike values off", () => {
  for (const value of REMAIN_OFF) {
    assert.equal(parseOptInFlag(value), false, `string ${JSON.stringify(value)}`);
  }
  assert.equal(parseOptInFlag(2), false);
  assert.equal(parseOptInFlag(-1), false);
  assert.equal(parseOptInFlag(Number.NaN), false);
  assert.equal(parseOptInFlag(Number.POSITIVE_INFINITY), false);
  assert.equal(parseOptInFlag({}), false);
  assert.equal(parseOptInFlag([]), false);
  assert.equal(parseOptInFlag("Y"), false);
  assert.equal(parseOptInFlag("t"), false);
});

test("loadConfig leaves lookalikes and LOAM_BUILD_MENU off", () => {
  const file = path.join(isolatedDataDir(), "opt-in-remain-off.json");
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
    for (const value of REMAIN_OFF) {
      assert.equal(enabledFrom({ buildMenu: { enabled: value } }), false, `config ${JSON.stringify(value)}`);
    }
    assert.equal(enabledFrom({ buildMenu: { enabled: 2 } }), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: -1 } }), false);
    for (const envValue of ["TRUE", "True", "YES", "Yes", "ON", "On", "1 ", " 1", "", "false", "off"]) {
      assert.equal(enabledFrom({}, envValue), false, `env ${JSON.stringify(envValue)}`);
    }
    assert.equal(enabledFrom({ buildMenu: { enabled: "TRUE" } }, "1"), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: "Yes" } }, "TRUE"), false);
    assert.equal(enabledFrom({ buildMenu: { enabled: "On" } }, "ON"), false);
    assert.equal(DEFAULTS.buildMenu?.enabled, false);
  } finally {
    fs.rmSync(file, { force: true });
    restore();
  }
});
