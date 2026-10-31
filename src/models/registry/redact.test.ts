/**
 * Tests for secret redaction.
 * 
 * Validates that API keys and other secrets are properly redacted from text.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactSecretsFromObject } from "./redact.js";

describe("secret redaction", () => {
  it("redacts OpenAI/Anthropic keys (sk-...)", () => {
    const text = "Error: API call failed with key sk-1234567890abcdef1234567890abcdef";
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes("sk-1234567890abcdef1234567890abcdef"));
    assert.ok(redacted.includes("«redacted»"));
  });

  it("redacts Bearer tokens", () => {
    const text = "Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz123456";
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes("AbCdEfGhIjKlMnOpQrStUvWxYz123456"));
    assert.ok(redacted.includes("«redacted»"));
  });

  it("redacts x-api-key headers", () => {
    const text = 'Headers: {"x-api-key": "test-key-12345678"}';
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes("test-key-12345678"));
    assert.ok(redacted.includes("«redacted»"));
  });

  it("redacts Google AI keys (AIza...)", () => {
    const text = "Using Google API key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"));
    assert.ok(redacted.includes("«redacted»"));
  });

  it("redacts FreeLLMAPI keys", () => {
    const text = "FreeLLMAPI token: freellmapi-abcd1234efgh5678";
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes("freellmapi-abcd1234efgh5678"));
    assert.ok(redacted.includes("«redacted»"));
  });

  it("redacts known secrets passed explicitly", () => {
    const text = "The secret is: my-custom-secret-key-12345";
    const redacted = redactSecrets(text, ["my-custom-secret-key-12345"]);
    assert.ok(!redacted.includes("my-custom-secret-key-12345"));
    assert.ok(redacted.includes("«redacted»"));
  });

  it("redacts multiple occurrences of the same secret", () => {
    const secret = "test-key-abc123";
    const text = `First: ${secret}, Second: ${secret}, Third: ${secret}`;
    const redacted = redactSecrets(text, [secret]);
    assert.strictEqual(redacted, "First: «redacted», Second: «redacted», Third: «redacted»");
  });

  it("does not redact short strings (<6 chars)", () => {
    const text = "Error: API call failed";
    const redacted = redactSecrets(text, ["API", "call"]);
    // Short known secrets are ignored
    assert.strictEqual(redacted, text);
  });

  it("redacts secrets from objects recursively", () => {
    const obj = {
      message: "Error with key sk-test1234567890abcdef",
      nested: {
        array: ["Bearer token123456789", "other text"],
        value: "x-api-key: secret123456789",
      },
    };

    const redacted = redactSecretsFromObject(obj);
    const json = JSON.stringify(redacted);
    
    assert.ok(!json.includes("sk-test1234567890abcdef"));
    assert.ok(!json.includes("token123456789"));
    assert.ok(!json.includes("secret123456789"));
    assert.ok(json.includes("«redacted»"));
  });

  it("preserves non-string values in objects", () => {
    const obj = {
      number: 42,
      boolean: true,
      nullValue: null,
      array: [1, 2, 3],
    };

    const redacted = redactSecretsFromObject(obj);
    assert.deepStrictEqual(redacted, obj);
  });

  it("does not mutate input object", () => {
    const obj = {
      message: "Error with key sk-test1234567890abcdef",
    };

    const objCopy = { ...obj };
    redactSecretsFromObject(obj);
    
    // Original object unchanged
    assert.deepStrictEqual(obj, objCopy);
  });

  it("handles empty strings and arrays", () => {
    assert.strictEqual(redactSecrets(""), "");
    assert.strictEqual(redactSecrets("", []), "");
    assert.deepStrictEqual(redactSecretsFromObject([]), []);
    assert.deepStrictEqual(redactSecretsFromObject({}), {});
  });

  it("handles text with no secrets", () => {
    const text = "This is a normal log message with no secrets";
    const redacted = redactSecrets(text);
    assert.strictEqual(redacted, text);
  });
});
