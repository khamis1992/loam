import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildMenuError } from '../grants.js';
import { leaseEnv } from '../processLease.js';
import { installsPackage } from './installGuard.js';
import { forgetKernelLease, releaseActiveKernelCell, rememberRunningLease } from './kernelLease.js';
import { KERNEL_TIMEOUT_MS, MAX_KERNEL_LINE, parseKernelStdout, type StoredOutput } from './messages.js';

const DIGEST = /@sha256:[a-f0-9]{64}$/;
const MAX_STDOUT = 1_000_000;
const PIN_FILE = fileURLToPath(new URL('./python/image-pin.json', import.meta.url));
let pinOverride: string | null | undefined;

function decodePercent(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function revealCommand(value: string): string[] {
  const forms = new Set<string>();
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    forms.add(current);
    let collapsed = current;
    let previous = '';
    while (collapsed !== previous) {
      previous = collapsed;
      collapsed = collapsed.replace(/['"]\s*\+\s*['"]/g, '');
    }
    const decoded = decodePercent(collapsed.replace(/['"]/g, ''));
    forms.add(decoded);
    if (decoded === current) break;
    current = decoded;
  }
  return [...forms];
}

function blockedReference(value: string): boolean {
  return revealCommand(value).some((form) => {
    const folded = form.toLowerCase();
    return folded.includes('latest') || /docker\s+pull/.test(folded) || /(?:^|[\s:])pull(?:[\s:@]|$)/.test(folded);
  });
}

function pinnedImage(image: string): boolean {
  return DIGEST.test(image) && !blockedReference(image);
}

export function configureNotebookPin(digest: string | null): void {
  if (digest !== null && !pinnedImage(digest)) throw new BuildMenuError('missing_requirement', 400);
  pinOverride = digest;
}

export function resetNotebookPin(): void {
  pinOverride = undefined;
}

interface KernelSession {
  key: string;
  child: ChildProcess;
  closed: boolean;
  nonce: string;
  activeJobId: string | null;
  stopOwned: () => void;
}

const sessions = new Map<string, KernelSession>();

export function resetKernelSessions(): void {
  for (const session of [...sessions.values()]) session.stopOwned();
  sessions.clear();
}

export function stopOwnedKernel(projectId: string, workspace: string): void {
  const session = sessions.get(`${projectId}\0${path.resolve(workspace)}`);
  if (!session || session.closed) return;
  session.stopOwned();
}

export interface KernelCommand {
  executable: string;
  args: string[];
  name: string;
}

export function kernelCommand(input: {
  executable: string;
  image: string;
  workspace: string;
  projectId: string;
  jobId: string;
  nonce: string;
}): KernelCommand {
  assertContainerEngine(input.executable);
  if (!pinnedImage(input.image)) throw new BuildMenuError('missing_requirement', 400);
  if (!/^[a-f0-9]{16}$/.test(input.nonce)) throw new BuildMenuError('invalid_request', 400);
  const name = `loamk${input.nonce}`;
  const root = path.resolve(input.workspace);
  const data = path.resolve(root, 'app', 'data');
  const output = path.resolve(root, 'app', 'output');
  if (!data.startsWith(`${root}${path.sep}`) || !output.startsWith(`${root}${path.sep}`)) {
    throw new BuildMenuError('unsafe_path', 400);
  }
  assertMountDir(root, data);
  assertMountDir(root, output);
  return {
    executable: input.executable,
    name,
    args: [
      'run', '--rm', '--pull', 'never', '--name', name, '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '128', '--memory', '1g', '--cpus', '1', '--user', '1000:1000',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--label', `loam.build-menu.kernel=${input.nonce}`,
      '--label', `loam.project=${input.projectId}`,
      '--label', `loam.job=${input.jobId}`,
      '-w', '/output',
      '-v', `${data}:/data:ro`,
      '-v', `${output}:/output:rw`,
      '-i', input.image,
      '/usr/local/bin/python', '/opt/loam/worker.py',
    ],
  };
}

export function kernelStopCommand(executable: string, nonce: string): KernelCommand {
  assertContainerEngine(executable);
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw new BuildMenuError('invalid_request', 400);
  return { executable, name: `loamk${nonce}`, args: ['stop', `loamk${nonce}`] };
}

export function readNotebookText(workspace: string): string {
  return fs.readFileSync(notebookFile(workspace), 'utf8');
}

export function readCellSource(workspace: string, cellId: string): string {
  const notebook = JSON.parse(readNotebookText(workspace)) as {
    cells?: { id?: string; source?: string | string[] }[];
  };
  const cell = notebook.cells?.find((item) => item.id === cellId);
  if (!cell) throw new BuildMenuError('invalid_request', 400);
  const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
  if (installsPackage(source)) throw new BuildMenuError('approval_required', 403);
  return source;
}

export async function runKernelCell(input: {
  workspace: string;
  cellId: string;
  projectId: string;
  jobId: string;
  image?: string;
  dockerPath?: string;
  nonce?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnImpl?: typeof spawn;
  inspectImpl?: typeof spawn;
  stopImpl?: typeof spawn;
}): Promise<{ text: string }> {
  if (input.signal?.aborted) throw new BuildMenuError('cancelled', 409);
  const source = readCellSource(input.workspace, input.cellId);
  if (Buffer.byteLength(source) > 200_000) throw new BuildMenuError('cell_too_large', 400);
  const image = requestedImage(input.image);
  const executable = input.dockerPath ?? findDocker();
  if (!image || !executable || !fs.existsSync(executable)) throw new BuildMenuError('missing_requirement', 400);
  const command = kernelCommand({
    executable,
    image,
    workspace: input.workspace,
    projectId: input.projectId,
    jobId: input.jobId,
    nonce: input.nonce ?? '0123456789abcdef',
  });
  if (command.args.some((arg) => arg.includes(source))) throw new BuildMenuError('unsafe_path', 400);
  const key = `${input.projectId}\0${path.resolve(input.workspace)}`;
  const line = `${JSON.stringify({ type: 'execute', cellId: input.cellId, code: source })}\n`;
  const timeoutMs = input.timeoutMs ?? KERNEL_TIMEOUT_MS;
  const existing = sessions.get(key);
  if (existing && !existing.closed) {
    if (existing.activeJobId) throw new BuildMenuError('busy', 409);
    existing.activeJobId = input.jobId;
    rememberRunningLease(input.workspace, { nonce: existing.nonce, projectId: input.projectId, jobId: input.jobId, cellId: input.cellId });
    try {
      const result = await finishCell(input.workspace, input.cellId, existing.child, line, timeoutMs, existing.stopOwned, input.signal);
      releaseActiveKernelCell(input.workspace, { nonce: existing.nonce, projectId: input.projectId, cellId: input.cellId });
      return result;
    } catch (error) {
      if (existing.closed) forgetKernelLease(input.workspace, input.projectId);
      else releaseActiveKernelCell(input.workspace, { nonce: existing.nonce, projectId: input.projectId, cellId: input.cellId });
      throw error;
    } finally {
      if (existing.activeJobId === input.jobId) existing.activeJobId = null;
    }
  }
  prepareMounts(input.workspace);
  const engine = input.spawnImpl ?? spawn;
  const nonce = input.nonce ?? '0123456789abcdef';
  const session: KernelSession = { key, child: undefined as unknown as ChildProcess, closed: false, nonce, activeJobId: input.jobId, stopOwned: () => undefined };
  sessions.set(key, session);
  let child: ChildProcess;
  try {
    await assertImagePresent(command.executable, image, input.inspectImpl ?? (input.spawnImpl ? imagePresent : engine));
    child = engine(command.executable, command.args, {
      cwd: input.workspace,
      env: leaseEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (sessions.get(key) === session) sessions.delete(key);
    throw error;
  }
  session.child = child;
  child.stderr?.resume();
  let stopped = false;
  const stopOwned = (): void => {
    if (stopped) return;
    stopped = true;
    session.closed = true;
    if (sessions.get(key) === session) sessions.delete(key);
    try {
      child.stdin?.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
      child.stdin?.end();
    } catch {
      /* The pipe may already be closed. */
    }
    try {
      const stopCommand = kernelStopCommand(command.executable, nonce);
      const stopper = (input.stopImpl ?? spawn)(stopCommand.executable, stopCommand.args, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      stopper.unref?.();
      stopper.on?.('error', () => undefined);
    } catch {
      /* A missing engine still ends this cell as interrupted. */
    }
    forgetKernelLease(input.workspace, input.projectId);
  };
  session.stopOwned = stopOwned;
  sessions.set(key, session);
  child.on('exit', () => {
    session.closed = true;
    if (sessions.get(key) === session) sessions.delete(key);
  });
  rememberRunningLease(input.workspace, { nonce, projectId: input.projectId, jobId: input.jobId, cellId: input.cellId });
  try {
    const result = await finishCell(input.workspace, input.cellId, child, line, timeoutMs, stopOwned, input.signal);
    releaseActiveKernelCell(input.workspace, { nonce, projectId: input.projectId, cellId: input.cellId });
    return result;
  } catch (error) {
    if (session.closed) forgetKernelLease(input.workspace, input.projectId);
    else releaseActiveKernelCell(input.workspace, { nonce, projectId: input.projectId, cellId: input.cellId });
    throw error;
  } finally {
    if (session.activeJobId === input.jobId) session.activeJobId = null;
  }
}

async function finishCell(
  workspace: string,
  cellId: string,
  child: ChildProcess,
  line: string,
  timeoutMs: number,
  stopOwned: () => void,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  const pending = collect(child, timeoutMs, stopOwned, signal, cellId);
  child.stdin?.write(line);
  try {
    const text = await pending;
    const parsed = parseKernelStdout(text, cellId);
    writeOutputs(workspace, cellId, parsed.outputs);
    return { text: parsed.text };
  } catch (error) {
    markInterrupted(workspace, cellId);
    throw error;
  }
}

function approvedNotebookDigest(): string | null {
  if (pinOverride !== undefined) return pinOverride;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as { status?: unknown; digest?: unknown };
  if (record.status !== 'approved' || typeof record.digest !== 'string') return null;
  if (!pinnedImage(record.digest)) return null;
  return record.digest;
}

function requestedImage(explicit: string | undefined): string {
  const requested = explicit ?? process.env.LOAM_NOTEBOOK_IMAGE ?? '';
  const approved = approvedNotebookDigest();
  if (!explicit) {
    if (!approved || requested !== approved) throw new BuildMenuError('missing_requirement', 400);
  } else if (approved && explicit !== approved) throw new BuildMenuError('missing_requirement', 400);
  return requested;
}

function imagePresent(_executable: string, args: readonly string[]): ChildProcess {
  if (args.some((arg) => blockedReference(arg))) throw new BuildMenuError('missing_requirement', 400);
  const child = new EventEmitter() as ChildProcess;
  process.nextTick(() => child.emit('exit', 0));
  return child;
}

function assertImagePresent(executable: string, image: string, engine: typeof spawn): Promise<void> {
  if (!pinnedImage(image)) throw new BuildMenuError('missing_requirement', 400);
  const args = ['image', 'inspect', '--format', '{{.Id}}', image];
  let child: ChildProcess;
  try {
    child = engine(executable, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  } catch {
    throw new BuildMenuError('missing_requirement', 400);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new BuildMenuError('missing_requirement', 400));
    };
    child.on('error', () => finish(1));
    child.on('exit', (code) => finish(code));
  });
}

function assertContainerEngine(executable: string): void {
  if (blockedReference(executable)) throw new BuildMenuError('missing_requirement', 400);
  const base = path.basename(executable).toLowerCase();
  if (base === 'python' || base === 'python.exe' || base === 'python3' || base === 'python3.exe' || base === 'py.exe') {
    throw new BuildMenuError('missing_requirement', 400);
  }
  if (base !== 'docker' && base !== 'docker.exe' && base !== 'podman' && base !== 'podman.exe') {
    throw new BuildMenuError('missing_requirement', 400);
  }
}

function assertMountDir(root: string, dir: string): void {
  if (!dir.startsWith(`${root}${path.sep}`)) throw new BuildMenuError('unsafe_path', 400);
  if (!fs.existsSync(dir)) return;
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BuildMenuError('unsafe_path', 400);
  let realRoot = '';
  let realDir = '';
  try {
    realRoot = fs.realpathSync(root);
    realDir = fs.realpathSync(dir);
  } catch {
    throw new BuildMenuError('unsafe_path', 400);
  }
  const relative = path.relative(realRoot, realDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new BuildMenuError('unsafe_path', 400);
}

function prepareMounts(workspace: string): void {
  const root = path.resolve(workspace);
  for (const name of ['data', 'output'] as const) {
    const dir = path.resolve(root, 'app', name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    assertMountDir(root, dir);
  }
}

function findDocker(): string | null {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe']
    : ['/usr/bin/docker', '/usr/local/bin/docker'];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function lineTooLong(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.length > MAX_KERNEL_LINE);
}

function cellFinished(text: string, cellId: string): boolean {
  const lines = text.split(/\r?\n/);
  const partial = lines.at(-1) !== '';
  const complete = partial ? lines.slice(0, -1) : lines;
  for (const line of complete) {
    if (!line) continue;
    if (line.length > MAX_KERNEL_LINE) return true;
    try {
      const record = JSON.parse(line) as { type?: string; cellId?: string };
      if ((record.type === 'error' || record.type === 'complete') && record.cellId === cellId) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function collect(child: ChildProcess, timeoutMs: number, onKill: () => void, signal: AbortSignal | undefined, cellId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const finish = (error: BuildMenuError | null, value = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (error: BuildMenuError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.kill('SIGTERM');
      onKill();
      reject(error);
    };
    const onAbort = (): void => fail(new BuildMenuError('cancelled', 409));
    const timer = setTimeout(() => fail(new BuildMenuError('tool_failed', 500)), timeoutMs);
    if (signal?.aborted) fail(new BuildMenuError('cancelled', 409));
    else signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof child.stdout?.setEncoding === 'function') child.stdout.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return;
      text += chunk;
      if (text.length > MAX_STDOUT || lineTooLong(text)) fail(new BuildMenuError('tool_failed', 500));
      else if (cellFinished(text, cellId)) finish(null, text);
    });
    let stderrBytes = 0;
    const stderr = child.stderr as (ChildProcess['stderr'] & { on?: (event: string, listener: (chunk: string) => void) => void }) | null;
    stderr?.on?.('data', (chunk: string) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (chunk.length > MAX_KERNEL_LINE || stderrBytes > MAX_KERNEL_LINE) fail(new BuildMenuError('tool_failed', 500));
    });
    child.on('error', () => finish(new BuildMenuError('tool_failed', 500)));
    child.on('exit', (code) => {
      if (code === 0) finish(null, text);
      else finish(new BuildMenuError('tool_failed', 500));
    });
  });
}

function writeOutputs(workspace: string, cellId: string, outputs: StoredOutput[]): void {
  const found = readCell(workspace, cellId);
  if (!found) return;
  found.cell.outputs = outputs;
  found.cell.execution_count = 1;
  fs.writeFileSync(notebookPath(workspace), `${JSON.stringify(found.notebook, null, 2)}\n`);
}

function markInterrupted(workspace: string, cellId: string): void {
  const found = readCell(workspace, cellId);
  if (!found) return;
  found.cell.outputs = [{ output_type: 'error', ename: 'interrupted', evalue: 'interrupted' }];
  fs.writeFileSync(notebookPath(workspace), `${JSON.stringify(found.notebook, null, 2)}\n`);
}

function notebookPath(workspace: string): string {
  return notebookFile(workspace);
}

function notebookFile(workspace: string): string {
  const file = path.join(workspace, 'app', 'notebook.ipynb');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code === 'ENOENT') return file;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
  return file;
}

function readCell(workspace: string, cellId: string): { notebook: { cells: CellRecord[] }; cell: CellRecord } | null {
  const notebook = JSON.parse(fs.readFileSync(notebookPath(workspace), 'utf8')) as { cells: CellRecord[] };
  const cell = notebook.cells.find((item) => item.id === cellId);
  if (!cell) return null;
  return { notebook, cell };
}

interface CellRecord {
  id?: string;
  source?: unknown;
  outputs?: unknown[];
  execution_count?: number | null;
}
