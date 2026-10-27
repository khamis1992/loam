import { spawnSync } from "node:child_process";

const protectedPaths = [
  "docs/handoff/watchdog.ps1",
  "qa/10-agents-after.png",
  "packages/tests/visual/baselines",
];
const result = spawnSync("git", ["diff", "--exit-code", "--", ...protectedPaths], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error("Protected QA artifacts changed. Revert them or run the visual refresh with LOAM_APPROVE_VISUAL_REFRESH=1 and review the diff.");
  process.exit(result.status || 1);
}
console.log("QA artifact guard: watchdog and visual baselines unchanged");
