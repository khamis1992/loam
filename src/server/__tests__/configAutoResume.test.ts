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
import test, { describe } from "node:test";
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

/**
 * The config-file path is the one a user edits by hand, so a value that merely
 * *looks* like an off switch must not silently switch the gate ON: a stray `"0"`
 * is truthy in JavaScript, and `1`/`"yes"` are not the documented spellings.
 */
describe("config.json recovery.autoResume", () => {
  const file = path.join(isolatedRoot(), "config-recovery-probe.json");

  /** Load a config whose `recovery` value can only have come from the file. */
  function fromFile(value: unknown): boolean {
    const previous = process.env.LOAM_CONFIG;
    const previousFlag = process.env.LOAM_AUTO_RESUME;
    delete process.env.LOAM_AUTO_RESUME;
    delete process.env.MANUS_LOCAL_AUTO_RESUME;
    process.env.LOAM_CONFIG = file;
    fs.writeFileSync(file, JSON.stringify({ recovery: { autoResume: value } }));
    try {
      return loadConfig().recovery?.autoResume ?? false;
    } finally {
      fs.rmSync(file, { force: true });
      if (previous === undefined) delete process.env.LOAM_CONFIG; else process.env.LOAM_CONFIG = previous;
      if (previousFlag === undefined) delete process.env.LOAM_AUTO_RESUME; else process.env.LOAM_AUTO_RESUME = previousFlag;
    }
  }

  test("accepts the two documented on spellings", () => {
    assert.equal(fromFile(true), true);
    assert.equal(fromFile("1"), true);
    assert.equal(fromFile("true"), true);
  });

  test("never lets a value that is not an on spelling enable it", () => {
    // This is the fail-open the first draft had: the row was copied verbatim, so
    // the truthy string `"0"` turned auto-resume ON.
    for (const value of [false, "0", "false", 0, 1, "yes", "on", "TRUE", " 1", ""]) {
      assert.equal(fromFile(value), false, `config value ${JSON.stringify(value)} must not enable it`);
    }
  });

  test("an explicit env 0 disables it even when the file asks for it", () => {
    const previousFlag = process.env.LOAM_AUTO_RESUME;
    process.env.LOAM_CONFIG = file;
    fs.writeFileSync(file, JSON.stringify({ recovery: { autoResume: true } }));
    try {
      process.env.LOAM_AUTO_RESUME = "0";
      assert.equal(loadConfig().recovery?.autoResume, false);
      process.env.LOAM_AUTO_RESUME = "1";
      assert.equal(loadConfig().recovery?.autoResume, true);
    } finally {
      fs.rmSync(file, { force: true });
      if (previousFlag === undefined) delete process.env.LOAM_AUTO_RESUME; else process.env.LOAM_AUTO_RESUME = previousFlag;
    }
  });

  test("an unrecognised env value leaves the file's value alone", () => {
    // A typo in the launch script must not open the gate, and must not silently
    // disable a file that asked for it either: it is simply not read.
    const previousFlag = process.env.LOAM_AUTO_RESUME;
    process.env.LOAM_CONFIG = file;
    fs.writeFileSync(file, JSON.stringify({ recovery: { autoResume: true } }));
    try {
      process.env.LOAM_AUTO_RESUME = "yes";
      assert.equal(loadConfig().recovery?.autoResume, true);
    } finally {
      fs.rmSync(file, { force: true });
      if (previousFlag === undefined) delete process.env.LOAM_AUTO_RESUME; else process.env.LOAM_AUTO_RESUME = previousFlag;
    }
  });
});
