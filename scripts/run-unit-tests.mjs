import { spawn } from "node:child_process";
import { globSync } from "node:fs";

const files = globSync("src/**/__tests__/*.test.ts")
  .filter((file) => !file.replaceAll("\\", "/").endsWith("src/tools/__tests__/search.test.ts"))
  .sort();
if (files.length === 0) throw new Error("No unit tests found");
const requestedConcurrency = Number(process.env.LOAM_TEST_CONCURRENCY ?? 4);
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 4;
const child = spawn(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...files], {
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
