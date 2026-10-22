import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  LIST_COMMANDS_ID,
  clearStudioEngines,
  describeStudio,
  listStudios,
  registerStudioEngine,
  runStudioCommand,
  unregisterStudioEngine,
  type StudioCommandSpec,
  type StudioEngine,
  type StudioRunOutput,
} from "../loamStudioHost.js";

const EMOJI = "\u{1F4A5}"; // surrogate pair, used to prove code-point truncation
const SOH = String.fromCharCode(1); // control character to sanitize

interface MockOpts {
  enabled?: boolean;
  reason?: string;
  enabledThrows?: boolean;
  commandsThrows?: boolean;
}

function mockEngine(app: StudioEngine["app"], opts: MockOpts = {}): StudioEngine {
  const enabled = opts.enabled !== false;
  return {
    app,
    title: `Mock ${app}`,
    description: `mock engine for ${app}`,
    enabled: () => {
      if (opts.enabledThrows) throw new Error("gate exploded");
      return enabled ? { enabled: true } : { enabled: false, reason: opts.reason };
    },
    commands: () => {
      if (opts.commandsThrows) throw new Error("catalog exploded");
      return [
        { id: "new", title: "Create", params: { name: { type: "string", required: true } } },
        { id: "rename", title: "Rename" },
        { id: "boom", title: "Always fails" },
        { id: "crash", title: "Throws" },
      ] satisfies StudioCommandSpec[];
    },
    run: (id, params): StudioRunOutput => {
      if (id === "boom") return { ok: false, error: "boom exploded" };
      if (id === "crash") throw new Error("engine crashed");
      return { ok: true, data: { id, params } };
    },
  };
}

describe("registerStudioEngine validation", () => {
  afterEach(() => clearStudioEngines());

  it("rejects non-engine values with a clear TypeError", () => {
    assert.throws(() => registerStudioEngine(null as unknown as StudioEngine), TypeError);
    assert.throws(() => registerStudioEngine({} as unknown as StudioEngine), TypeError);
    assert.throws(
      () =>
        registerStudioEngine({
          app: "spaces",
          title: "x",
          enabled: () => ({ enabled: true }),
          commands: () => [],
          run: () => ({ ok: true }),
        } as unknown as StudioEngine),
      TypeError,
    );
  });

  it("registers a valid engine and lets a later valid one replace it", () => {
    registerStudioEngine(mockEngine("doc"));
    assert.equal(listStudios().length, 1);
    registerStudioEngine(mockEngine("doc"));
    assert.equal(listStudios().length, 1);
    assert.equal(unregisterStudioEngine("doc"), true);
    assert.equal(unregisterStudioEngine("doc"), false);
  });
});

describe("listStudios resilience", () => {
  afterEach(() => clearStudioEngines());

  it("never throws when an engine gate or catalog throws", () => {
    registerStudioEngine(mockEngine("doc", { enabledThrows: true }));
    registerStudioEngine(mockEngine("sheet", { commandsThrows: true }));
    const studios = listStudios();
    assert.equal(studios.length, 2);
    const doc = studios.find((s) => s.app === "doc")!;
    assert.equal(doc.available, false);
    assert.match(doc.reason!, /Mock doc/);
    const sheet = studios.find((s) => s.app === "sheet")!;
    assert.deepEqual(sheet.commands, []);
  });

  it("skips apps whose resolver throws instead of failing the whole list", () => {
    const studios = listStudios((app) => {
      if (app === "video") throw new Error("resolver exploded");
      return app === "design" ? mockEngine("design") : undefined;
    });
    assert.deepEqual(studios.map((s) => s.app), ["design"]);
  });

  it("falls back to a safe reason when the gate reason is empty or multiline", () => {
    const blank = describeStudio(mockEngine("doc", { enabled: false, reason: "  \n  " }));
    assert.equal(blank.available, false);
    assert.equal(blank.reason, "Mock doc is currently unavailable");

    const noisy = describeStudio(mockEngine("sheet", { enabled: false, reason: `a${SOH}b\nc d` }));
    assert.ok(!noisy.reason!.includes("\n"));
    assert.ok(!/[\u0000-\u001F]/.test(noisy.reason!));
  });

  it("truncates reasons by code points without splitting a surrogate pair", () => {
    const descriptor = describeStudio(mockEngine("doc", { enabled: false, reason: EMOJI.repeat(300) }));
    assert.equal(Array.from(descriptor.reason!).length, 240);
    assert.equal(descriptor.reason!.length, 480); // 240 code points * 2 UTF-16 units
    assert.ok(!descriptor.reason!.includes("\uFFFD"));
  });
});

describe("runStudioCommand hardening", () => {
  afterEach(() => clearStudioEngines());

  it("drops invalid, duplicate, and virtual catalog entries", async () => {
    const engine: StudioEngine = {
      ...mockEngine("doc"),
      commands: () =>
        [
          { id: "real", title: "Real" },
          { id: "real", title: "Duplicate" },
          { id: LIST_COMMANDS_ID, title: "Virtual" },
          { id: "   ", title: "Blank" },
          null,
          42,
        ] as unknown as StudioCommandSpec[],
    };
    const listed = await runStudioCommand("doc", { id: LIST_COMMANDS_ID }, () => engine);
    assert.ok(listed.ok && listed.kind === "commands");
    if (listed.ok && listed.kind === "commands") {
      assert.deepEqual(listed.commands.map((c) => c.id), ["real"]);
      assert.equal(listed.commands[0]!.title, "Real");
    }
  });

  it("returns bad_request for a null/undefined command body", async () => {
    registerStudioEngine(mockEngine("doc"));
    const nullBody = await runStudioCommand("doc", null);
    assert.ok(!nullBody.ok && nullBody.kind === "bad_request");
    const missing = await runStudioCommand("doc", undefined);
    assert.ok(!missing.ok && missing.kind === "bad_request");
    const arrayBody = await runStudioCommand("doc", [1, 2] as unknown as { id?: unknown });
    assert.ok(!arrayBody.ok && arrayBody.kind === "bad_request");
  });

  it("returns unsupported_command when the catalog throws", async () => {
    registerStudioEngine(mockEngine("doc", { commandsThrows: true }));
    const res = await runStudioCommand("doc", { id: "new" });
    assert.ok(!res.ok && res.kind === "unsupported_command");
  });

  it("returns disabled when the gate throws instead of propagating", async () => {
    registerStudioEngine(mockEngine("doc", { enabledThrows: true }));
    const res = await runStudioCommand("doc", { id: "new" });
    assert.ok(!res.ok && res.kind === "disabled");
    if (!res.ok && res.kind === "disabled") {
      assert.equal(res.error, "studio_disabled");
      assert.match(res.reason, /Mock doc/);
    }
  });

  it("contains malformed run results and sanitizes engine_error text", async () => {
    const engine: StudioEngine = {
      ...mockEngine("doc"),
      commands: () => [
        { id: "noisy", title: "Noisy" },
        { id: "malformed", title: "Malformed" },
      ],
      run: (id): StudioRunOutput => {
        if (id === "noisy") return { ok: false, error: `bad${SOH}value\nsecond line ` + "x".repeat(300) };
        if (id === "malformed") return undefined as unknown as StudioRunOutput;
        return { ok: true, data: { ok: 1 } };
      },
    };
    registerStudioEngine(engine);

    const noisy = await runStudioCommand("doc", { id: "noisy" });
    assert.ok(!noisy.ok && noisy.kind === "engine_error");
    if (!noisy.ok && noisy.kind === "engine_error") {
      assert.ok(!noisy.error.includes("\n"));
      assert.ok(noisy.error.length <= 240);
    }

    const malformed = await runStudioCommand("doc", { id: "malformed" });
    assert.ok(!malformed.ok && malformed.kind === "engine_error" && malformed.error === "command failed");
  });

  it("handles thrown non-Error values and async engines", async () => {
    const syncEngine: StudioEngine = {
      ...mockEngine("sheet"),
      commands: () => [{ id: "throwString", title: "Throw" }],
      run: (id) => {
        if (id === "throwString") throw "plain string failure";
        return { ok: true, data: { id } };
      },
    };
    registerStudioEngine(syncEngine);
    const thrown = await runStudioCommand("sheet", { id: "throwString" });
    assert.ok(!thrown.ok && thrown.kind === "engine_error");
    if (!thrown.ok && thrown.kind === "engine_error") {
      assert.equal(thrown.error, "plain string failure");
    }

    const asyncEngine: StudioEngine = {
      ...mockEngine("slides"),
      run: async (id) => ({ ok: true, data: { async: true, id } }),
    };
    const asyncRes = await runStudioCommand("slides", { id: "new" }, () => asyncEngine);
    assert.deepEqual(asyncRes, { ok: true, kind: "result", data: { async: true, id: "new" } });
  });

  it("reports unknown_app when the resolver throws", async () => {
    const res = await runStudioCommand("design", { id: "new" }, () => {
      throw new Error("resolver exploded");
    });
    assert.ok(!res.ok && res.kind === "unknown_app");
  });

  it("defaults params to an empty object and rejects non-object params", async () => {
    registerStudioEngine(mockEngine("doc"));
    const ok = await runStudioCommand("doc", { id: "rename" });
    assert.deepEqual(ok, { ok: true, kind: "result", data: { id: "rename", params: {} } });
    const bad = await runStudioCommand("doc", { id: "rename", params: "nope" });
    assert.ok(!bad.ok && bad.kind === "bad_request");
  });
});
