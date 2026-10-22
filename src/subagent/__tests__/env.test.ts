import test from "node:test";
import assert from "node:assert/strict";
import { scrubEnv } from "../env.js";

test("scrubEnv drops credential-like variable names", () => {
  const env = {
    OPENAI_API_KEY: "sk-secret",
    GITHUB_TOKEN: "gh-secret",
    MY_SECRET: "shh",
    DB_PASSWORD: "pw",
    AWS_ACCESS_KEY_ID: "aws",
    AZURE_CLIENT_SECRET: "az",
    PATH: "C:\\bin",
    HOME: "C:\\Users\\test",
  } as unknown as NodeJS.ProcessEnv;

  const out = scrubEnv(env);

  for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "MY_SECRET", "DB_PASSWORD", "AWS_ACCESS_KEY_ID", "AZURE_CLIENT_SECRET"]) {
    assert.equal(out[name], undefined, `${name} should be scrubbed`);
  }
  assert.equal(out.PATH, "C:\\bin");
  assert.equal(out.HOME, "C:\\Users\\test");
});

test("scrubEnv skips undefined values and lets explicit extras win", () => {
  const out = scrubEnv({ PATH: "original", UNSET: undefined } as unknown as NodeJS.ProcessEnv, {
    PATH: "override",
    EXTRA: "1",
  });
  assert.equal(out.UNSET, undefined);
  assert.equal(out.PATH, "override");
  assert.equal(out.EXTRA, "1");
});
