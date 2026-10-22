/**
 * V9 acceptance gate: every design-registry block must build and its manifest
 * must validate.
 *
 * Run directly (`npm run check:design-registry`). Exits non-zero when any
 * manifest is malformed or any block fails to compile, so CI fails closed.
 */
import {
  buildRegistry,
  validateRegistry,
  type BuildIssue,
  type ManifestIssue,
} from "../design/registry.js";

export interface RegistryCheckResult {
  blocks: number;
  rtlBlocks: number;
  manifestIssues: number;
  built: number;
  buildIssues: number;
}

export async function runDesignRegistryCheck(): Promise<RegistryCheckResult> {
  const { records, issues } = validateRegistry();
  const build = await buildRegistry();
  return {
    blocks: records.length,
    rtlBlocks: records.filter((r) => r.manifest.rtl).length,
    manifestIssues: issues.length,
    built: build.built,
    buildIssues: build.issues.length,
  };
}

function report(
  result: RegistryCheckResult,
  manifestIssues: ManifestIssue[],
  buildIssues: BuildIssue[],
): void {
  for (const issue of manifestIssues) {
    console.error(`  [manifest] ${issue.block}.${issue.field} — ${issue.message}`);
  }
  for (const issue of buildIssues) {
    console.error(`  [build] ${issue.block} — ${issue.message}`);
  }
  if (result.manifestIssues === 0 && result.buildIssues === 0) {
    console.log(
      `design registry: OK (${result.blocks} blocks, ${result.rtlBlocks} RTL, all manifests valid, all built)`,
    );
    return;
  }
  console.error(
    `design registry: ${result.blocks} blocks (${result.rtlBlocks} RTL), ` +
      `${result.manifestIssues} manifest issue(s), ${result.buildIssues} build failure(s)`,
  );
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] !== undefined && /check-design-registry\.ts$/.test(process.argv[1] ?? "");
if (isDirectRun) {
  const { records, issues } = validateRegistry();
  const build = await buildRegistry();
  report(
    {
      blocks: records.length,
      rtlBlocks: records.filter((r) => r.manifest.rtl).length,
      manifestIssues: issues.length,
      built: build.built,
      buildIssues: build.issues.length,
    },
    issues,
    build.issues,
  );
}
