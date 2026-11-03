import path from "node:path";
import { CodeGraphService } from "../codegraph/service.js";

const root = path.resolve(process.argv[2] || process.cwd());
const service = new CodeGraphService({ enabled: true, autoIndex: "always" });
try {
  const before = await service.status(root);
  if (before.runtime !== "ready") throw new Error(`CodeGraph runtime is ${before.runtime}`);
  service.indexer.optIn(root);
  const job = service.indexer.requestIndex(root, "user");
  const finished = await service.indexer.waitFor(job.id, service.cfg.indexTimeoutMs + 5_000);
  if (!finished) throw new Error("CodeGraph update timed out");
  if (finished.status !== "succeeded") throw new Error(finished.error || `CodeGraph update exited ${finished.exitCode}`);
  const status = await service.status(root);
  console.log(`CodeGraph updated: ${status.displayName} ${status.state} ${status.builtAtCommit ?? "unknown"}`);
} finally {
  await service.dispose();
}
