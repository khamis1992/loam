import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { attachModelSecrets } = require("../../../../electron/model-secrets.cjs") as {
  attachModelSecrets: (child: FakeChild, app: FakeApp, safeStorage: FakeSafeStorage) => void;
};

const ID = "11111111-1111-4111-8111-111111111111";

interface FakeChild {
  on(event: string, handler: (message: Record<string, unknown>) => void): void;
  postMessage(message: Record<string, unknown>): void;
  emit(message: Record<string, unknown>): void;
  sent: Array<Record<string, unknown>>;
}

interface FakeApp {
  getPath(name: string): string;
}

interface FakeSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(buf: Buffer): string;
}

function fakeChild(): FakeChild {
  const handlers: Array<(message: Record<string, unknown>) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    on(_event, handler) {
      handlers.push(handler);
    },
    postMessage(message) {
      sent.push(message);
    },
    emit(message) {
      for (const handler of handlers) handler(message);
    },
  };
}

function fakeSafeStorage(): FakeSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (buf) => buf.toString("utf8"),
  };
}

describe("model secrets vault", () => {
  it("stores a key, echoes the request id, and keeps the value out of the index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-model-secrets-"));
    const app: FakeApp = { getPath: () => dir };
    const child = fakeChild();
    attachModelSecrets(child, app, fakeSafeStorage());

    child.emit({ type: "loam:model-secrets:put", requestId: 7, id: ID, value: "sk-test-secret-1234", label: "OpenAI" });
    const put = child.sent.at(-1);
    assert.equal(put?.type, "loam:model-secrets:put-response");
    assert.equal(put?.requestId, 7);
    assert.equal(put?.ok, true);
    assert.equal(put?.hint, "...1234");

    const index = fs.readFileSync(path.join(dir, "model-secrets", "index.json"), "utf8");
    assert.equal(index.includes("sk-test-secret-1234"), false);

    child.emit({ type: "loam:model-secrets:get", requestId: 8, id: ID });
    const got = child.sent.at(-1);
    assert.equal(got?.requestId, 8);
    assert.equal(got?.value, "sk-test-secret-1234");

    child.emit({ type: "loam:model-secrets:hints", requestId: 9 });
    const hints = child.sent.at(-1);
    assert.equal(hints?.requestId, 9);
    assert.equal((hints?.hints as Record<string, string>)[ID], "...1234");
  });
});
