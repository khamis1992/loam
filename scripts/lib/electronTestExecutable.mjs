import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';

export async function createElectronTestExecutable(sourcePath) {
  const executablePath = path.join(path.dirname(sourcePath), `${path.basename(sourcePath, '.exe')}.test-${process.pid}-${randomBytes(4).toString('hex')}.exe`);
  await fs.copyFile(sourcePath, executablePath);
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
  });
  return {
    executablePath,
    cleanup: () => fs.rm(executablePath, { force: true }),
  };
}
