import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const plan = require('./quitPlan.cjs') as {
  rememberWidget(dataDir: string, record: { pid: number; nonce: string; workspace: string; identity: string }): void;
  forgetWidget(dataDir: string, pid: number): void;
  writeWidgetNonce(workspace: string, nonce: string): void;
  readWidgetStartIdentity(pid: number): string | null;
};

function dataDir(): string | null {
  const dir = process.env.LOAM_DATA_DIR;
  return dir && path.isAbsolute(dir) ? dir : null;
}

export function rememberOpenedWidget(workspace: string, nonce: string, pid: number): void {
  const dir = dataDir();
  if (!dir) return;
  const identity = plan.readWidgetStartIdentity(pid);
  if (!identity) return;
  plan.writeWidgetNonce(workspace, nonce);
  plan.rememberWidget(dir, { pid, nonce, workspace, identity });
}

export function forgetOpenedWidget(pid: number): void {
  const dir = dataDir();
  if (!dir) return;
  plan.forgetWidget(dir, pid);
}
