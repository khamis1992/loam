import { androidArtifact, androidBuildStatus, androidEnvironment, cancelAndroidBuild, startAndroidBuild } from '../../mobile/android/build.js';
import { readMobile } from '../../mobile/store.js';
import type { Artifact } from '../../../packages/shared/src/buildMenu.js';
import { zipEntryNames } from '../../preview/zip.js';
import { BuildMenuError } from '../grants.js';
import { writeBytesArtifact } from '../artifacts.js';

export function apkBlockReason(checks: readonly { ready: boolean }[]): 'missing_requirement' | null {
  return checks.every((check) => check.ready) ? null : 'missing_requirement';
}

type AndroidEnvironmentChecks = {
  checks: readonly { ready: boolean }[];
};

export async function exportDebugApk(
  workspace: string,
  projectId: string,
  revision: number,
  environment: AndroidEnvironmentChecks = androidEnvironment(),
): Promise<Artifact> {
  if (apkBlockReason(environment.checks)) throw new BuildMenuError('missing_requirement', 400);
  const project = readMobile(workspace);
  if (!project) throw new BuildMenuError('tool_failed', 500);
  const job = await startAndroidBuild(workspace, projectId, project.revision);
  const finished = await waitForAndroid(workspace, job.id);
  if (finished.status !== 'succeeded') throw new BuildMenuError('tool_failed', 500);
  const bytes = await androidArtifact(workspace, job.id, 'apk');
  assertPackedMobile(workspace, project.revision);
  assertDebugApk(bytes);
  return writeBytesArtifact(workspace, projectId, revision, 'apk-debug', bytes, 'apk');
}

export function assertPackedMobile(workspace: string, packedRevision: number): void {
  const after = readMobile(workspace);
  if (!after || after.revision !== packedRevision) throw new BuildMenuError('stale_revision', 409);
}

export function assertDebugApk(bytes: Buffer): void {
  let names: string[];
  try {
    names = zipEntryNames(bytes);
  } catch {
    throw new BuildMenuError('tool_failed', 500);
  }
  if (!names.includes('classes.dex') || !names.includes('AndroidManifest.xml')) {
    throw new BuildMenuError('tool_failed', 500);
  }
}

async function waitForAndroid(workspace: string, id: string) {
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = androidBuildStatus(workspace, id);
    const job = status.build;
    if (!job) throw new BuildMenuError('tool_failed', 500);
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  try {
    cancelAndroidBuild(workspace, id);
  } catch {
    // A missing run still ends as a failed build.
  }
  throw new BuildMenuError('tool_failed', 500);
}
