import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage } from "node:http";
import { isHostileCrossSite } from "../appShellOrigin.js";

function req(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("app shell origin", () => {
  it("allows the desktop shell even though fetch marks it cross-site", () => {
    assert.equal(isHostileCrossSite(req({ origin: "app://agent", host: "127.0.0.1:3971", "sec-fetch-site": "cross-site" })), false);
  });

  it("rejects a website that posts at the loopback server", () => {
    assert.equal(isHostileCrossSite(req({ origin: "https://evil.test", host: "127.0.0.1:3971", "sec-fetch-site": "cross-site" })), true);
  });

  it("allows a same-host request and a request with no origin", () => {
    assert.equal(isHostileCrossSite(req({ origin: "http://127.0.0.1:3971", host: "127.0.0.1:3971" })), false);
    assert.equal(isHostileCrossSite(req({ host: "127.0.0.1:3971" })), false);
  });
});
