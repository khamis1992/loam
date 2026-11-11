import { spawn } from "node:child_process";
import { globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const files = globSync("src/**/__tests__/*.test.ts")
  .filter((file) => !file.replaceAll("\\", "/").endsWith("src/tools/__tests__/search.test.ts"))
  .sort();
if (files.length === 0) throw new Error("No unit tests found");
const requestedConcurrency = Number(process.env.LOAM_TEST_CONCURRENCY ?? 1);
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 1;
const batchSize = 1;
let resultCode = 0;

for (let offset = 0; offset < files.length; offset += batchSize) {
  const batch = files.slice(offset, offset + batchSize);
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), "loam-unit-"));
  const isolatedEnv = {
    ...process.env,
    MANUS_LOCAL_CONFIG: path.join(isolatedRoot, "config.json"),
    MANUS_LOCAL_DATA_DIR: path.join(isolatedRoot, "data"),
    MANUS_LOCAL_WORKSPACE: path.join(isolatedRoot, "workspace"),
    MANUS_LOCAL_SKILLS_DIR: path.join(isolatedRoot, "skills"),
    MANUS_LOCAL_EVALS_DIR: path.join(isolatedRoot, "evals"),
  };
  for (const name of ["LOAM_CONFIG", "LOAM_DATA_DIR", "LOAM_WORKSPACE", "LOAM_SKILLS_DIR", "LOAM_EVALS_DIR"]) {
    delete isolatedEnv[name];
  }
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...batch], {
        stdio: "inherit",
        windowsHide: true,
        env: isolatedEnv,
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        if (signal) reject(new Error(`Unit tests terminated by ${signal}`));
        else resolve(exitCode ?? 1);
      });
    });
    if (code !== 0) resultCode = code;
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (resultCode !== 0) process.exit(resultCode);
