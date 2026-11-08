import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startProtocolAdapter, type ProtocolAdapter } from "../adapter.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-web-login-"));
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
process.env.LOAM_DATA_DIR = tmpDir;
process.env.LOAM_PORT = "3939";

let adapter: ProtocolAdapter | undefined;
let base = "";

before(async () => {
  adapter = await startProtocolAdapter({
    cfg: { workspace: tmpDir } as never,
    runTask: (async () => ({ taskId: "t", text: "" })) as never,
    getTask: () => undefined,
    port: 0,
  });
  base = `http://127.0.0.1:${adapter.port}`;
});

after(async () => {
  await adapter?.close();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  delete process.env.LOAM_DATA_DIR;
  delete process.env.LOAM_PORT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("browser local login", () => {
  it("rejects a non-Loam origin before issuing a token", async () => {
    const res = await fetch(`${base}/login?from=web&nonce=evil`, { headers: { Origin: "https://example.com" } });
    assert.equal(res.status, 403);
  });

  it("requires an explicit trusted origin for the JSON flow", async () => {
    const res = await fetch(`${base}/login?from=web&nonce=missing`);
    assert.equal(res.status, 403);
  });

  it("exchanges a trusted web login into a session with single-use credentials", async () => {
    const login = await fetch(`${base}/login?from=web&type=signIn&nonce=web-test`, {
      headers: { Origin: "http://127.0.0.1:3939" },
    });
    assert.equal(login.status, 200);
    const loginData = await login.json() as { token?: string };
    assert.ok(loginData.token);

    const generated = await fetch(`${base}/user.v1.UserAuthService/GenerateTempAuthCode`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loginData.token}` },
      body: "{}",
    });
    assert.equal(generated.status, 200);
    const generatedData = await generated.json() as { token?: string };
    assert.ok(generatedData.token);

    const exchanged = await fetch(`${base}/user.v1.UserAuthPublicService/ExchangeTokenByCode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: generatedData.token }),
    });
    assert.equal(exchanged.status, 200);
    const session = await exchanged.json() as { token?: string };
    assert.ok(session.token);

    const replay = await fetch(`${base}/user.v1.UserAuthPublicService/ExchangeTokenByCode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: generatedData.token }),
    });
    assert.equal(replay.status, 401);
  });

  it("preserves the desktop deep-link redirect", async () => {
    const res = await fetch(`${base}/login?from=desktop&type=signIn&nonce=desktop-test`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^agentstudio:\/\/auth\/callback\?token=/);
  });
});
