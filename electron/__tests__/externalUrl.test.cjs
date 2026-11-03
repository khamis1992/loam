const assert = require("node:assert/strict");
const test = require("node:test");
const { isTrustedExternalUrl } = require("../externalUrl.cjs");

test("external URL policy allows HTTPS, mail and the local update feed", () => {
  assert.equal(isTrustedExternalUrl("https://example.com/docs"), true);
  assert.equal(isTrustedExternalUrl("mailto:support@example.com"), true);
  assert.equal(isTrustedExternalUrl("http://127.0.0.1:8788/latest.yml"), true);
});

test("external URL policy blocks untrusted hosts and executable schemes", () => {
  for (const url of [
    "http://example.com",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "ms-msdt:id",
    "not a URL",
  ]) {
    assert.equal(isTrustedExternalUrl(url), false, url);
  }
});
