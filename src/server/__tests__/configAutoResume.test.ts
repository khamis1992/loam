/**
 * O6b: `LOAM_AUTO_RESUME` flag parsing (BUILD_SPEC §9, GAP_TABLE row 12).
 *
 * Auto-resume is opt-in, so the flag's parsing is the whole safety boundary: a
 * typo, a wrong variable name, or a stale `MANUS_LOCAL_AUTO_RESUME` must never
 * turn an interrupted task into an unattended resume. These assertions pin the
 * accepted spellings, the precedence between the two variable names, and the
 * fact that anything unrecognised keeps today's "Resume requires review".
 *
 * `loadConfig()` reads the environment at call time, so each test sets
 * `process.env` directly. `LOAM_CONFIG` is pointed at a file that does not exist
 * so a developer's real `config.json` cannot supply a `recovery` value that
 * would mask the env under test.
 *
 * Run: node --import tsx --test src/server/__tests__/configAutoResume.test.ts
 */
import "../../test/isolation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULTS, loadConfig } from "../../config.js";

/** The two variable names the flag accepts, plus the ones it must not read. */
const FLAG_VARS = ["LOAM_AUTO_RESUME", "MANUS_LOCAL_AUTO_RESUME"] as const;

test.after(() => {
  for (const name of FLAG_VARS) delete process.env[name];
  delete process.env.LOAM_CONFIG;
});

/** Load a config whose `recovery` value can only have come from the environment. */
function configFromEnv(env: Record<string, string | undefined>): boolean {
  const previous = new Map<string, string | undefined>();
  for (const name of [...FLAG_VARS, "LOAM_CONFIG"]) previous.set(name, process.env[name]);
  for (const name of FLAG_VARS) delete process.env[name];
  // A non-existent config file makes `raw` empty, so `merge(DEFAULTS, {})` leaves
  // the env as the only source of truth for `recovery.autoResume`.
  process.env.LOAM_CONFIG = path.join(isolatedRoot(), "no-such-config.json");
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return loadConfig().recovery?.autoResume ?? false;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The throwaway root `src/test/isolation.ts` redirected this process to. */
function isolatedRoot(): string {
  return process.env.LOAM_ROOT!;
}

test("auto-resume defaults to off", () => {
  assert.equal(DEFAULTS.recovery?.autoResume ?? false, false, "the flag is opt-in");
  assert.equal(configFromEnv({}), false, "no flag keeps Resume requires review");
});

test("LOAM_AUTO_RESUME accepts 1 and true", () => {
  assert.equal(configFromEnv({ LOAM_AUTO_RESUME: "1" }), true);
  assert.equal(configFromEnv({ LOAM_AUTO_RESUME: "true" }), true);
});

test("LOAM_AUTO_RESUME accepts 0 and false", () => {
  assert.equal(configFromEnv({ LOAM_AUTO_RESUME: "0" }), false);
  assert.equal(configFromEnv({ LOAM_AUTO_RESUME: "false" }), false);
});

test("MANUS_LOCAL_AUTO_RESUME is the fallback spelling", () => {
  assert.equal(configFromEnv({ MANUS_LOCAL_AUTO_RESUME: "1" }), true);
  assert.equal(configFromEnv({ MANUS_LOCAL_AUTO_RESUME: "false" }), false);
});

test("LOAM_AUTO_RESUME wins over MANUS_LOCAL_AUTO_RESUME", () => {
  assert.equal(configFromEnv({ LOAM_AUTO_RESUME: "0", MANUS_LOCAL_AUTO_RESUME: "1" }), false);
  assert.equal(configFromEnv({ LOAM_AUTO_RESUME: "1", MANUS_LOCAL_AUTO_RESUME: "0" }), true);
});

test("an unrecognised value leaves the default in place", () => {
  // `yes`, `on`, an empty string and a stray space must not enable auto-resume:
  // a typo in the launch script must fail closed, not open.
  for (const value of ["yes", "on", "TRUE", " 1", "", "2"]) {
    assert.equal(configFromEnv({ LOAM_AUTO_RESUME: value }), false, `value ${JSON.stringify(value)} must not enable it`);
  }
});

test("the isolated root exists so the test never reads the real config.json", () => {
  assert.ok(fs.existsSync(isolatedRoot()), "src/test/isolation.ts must have redirected LOAM_ROOT");
});
