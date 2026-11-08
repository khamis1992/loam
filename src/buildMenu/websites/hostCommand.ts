import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BuildMenuError } from '../grants.js';
import { assertFrozenWebsiteTemplate } from './templateLock.js';

const DIGEST = /^[a-f0-9]{64}$/;
const REMOTE_URL = /https?\s*:\s*\/\//i;
const MAILTO = /mailto\s*:/i;
const PROTOCOL_RELATIVE = /(?<!:)\/\//;
const LIFECYCLE_SCRIPT = /(?:^|[^a-z])(?:prepare|(?:pre|post)?install|(?:pre|post)?publish(?:only)?|(?:pre|post)?pack|(?:pre|post)?uninstall|(?:pre|post)?version|(?:pre|post)?start|(?:pre|post)?stop|(?:pre|post)?test|(?:pre|post)?restart|(?:pre|post)?shrinkwrap|(?:pre|post)(?:build|dev|typecheck|ci))(?:[^a-z]|$)/i;
let approvedLock: string | null = null;
let hostRunner: ((command: WebsiteHostCommand) => Promise<number>) | null = null;
let devStarter: ((command: WebsiteHostCommand) => Promise<{ stop: () => Promise<void> }>) | null = null;

export function configureWebsiteLock(digest: string | null): void {
  if (digest !== null && !DIGEST.test(digest)) throw new BuildMenuError('invalid_request', 400);
  approvedLock = digest;
}

export type WebsiteHostScript = 'typecheck' | 'build' | 'dev';

export interface WebsiteHostCommand {
  executable: 'npm' | 'npm.cmd';
  args: readonly string[];
  cwd: string;
  shell: false;
  env: Readonly<Record<string, string>>;
}

export function configureWebsiteHostRunner(runner: ((command: WebsiteHostCommand) => Promise<number>) | null): void {
  hostRunner = runner;
}

export function websiteHostReady(): boolean {
  return approvedLock !== null;
}

export function currentWebsiteHostRunner(): ((command: WebsiteHostCommand) => Promise<number>) | null {
  return hostRunner;
}

export function configureWebsiteDevStarter(starter: ((command: WebsiteHostCommand) => Promise<{ stop: () => Promise<void> }>) | null): void {
  devStarter = starter;
}

export function currentWebsiteDevStarter(): ((command: WebsiteHostCommand) => Promise<{ stop: () => Promise<void> }>) | null {
  return devStarter;
}

export async function startApprovedWebsiteDev(input: {
  workspace: string;
  ports: readonly number[];
  signal: AbortSignal;
  installImpl: (command: WebsiteHostCommand) => Promise<number>;
  listenImpl: (command: WebsiteHostCommand) => Promise<{ stop: () => Promise<void> }>;
}): Promise<{ stop: () => Promise<void>; port: number }> {
  if (input.signal.aborted) throw new BuildMenuError('cancelled', 409);
  const ports = input.ports.filter((port) => ownedPort(port)).slice(0, 3);
  const [install] = ports.length > 0 ? websiteHostCommands(input.workspace, 'dev', ports[0]) : [];
  if (!install) throw new BuildMenuError('port_exhausted', 503);
  if (input.signal.aborted) throw new BuildMenuError('cancelled', 409);
  const pending = deliverWebsiteHostCommand(install, input.installImpl);
  const watch = untilAborted(input.signal);
  let code: number;
  try {
    code = await Promise.race([pending, watch.promise]);
  } catch (error) {
    watch.stop();
    void pending.catch(() => undefined);
    if (input.signal.aborted) throw new BuildMenuError('cancelled', 409);
    throw error instanceof BuildMenuError ? error : new BuildMenuError('tool_failed', 500);
  }
  watch.stop();
  if (input.signal.aborted) {
    void pending.catch(() => undefined);
    throw new BuildMenuError('cancelled', 409);
  }
  if (code !== 0) throw new BuildMenuError('tool_failed', 500);
  for (const port of ports) {
    if (input.signal.aborted) throw new BuildMenuError('cancelled', 409);
    const dev = websiteHostCommands(input.workspace, 'dev', port)[1];
    if (!dev) throw new BuildMenuError('tool_failed', 500);
    try {
      const started = await deliverWebsiteHostCommand(dev, input.listenImpl);
      return { stop: started.stop, port };
    } catch (error) {
      if (input.signal.aborted) throw new BuildMenuError('cancelled', 409);
      if (!portConflict(error)) throw error instanceof BuildMenuError ? error : new BuildMenuError('tool_failed', 500);
    }
  }
  throw new BuildMenuError('port_exhausted', 503);
}

function portConflict(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof BuildMenuError) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EADDRINUSE' || error.message === 'EADDRINUSE';
}

function untilAborted(signal: AbortSignal): { promise: Promise<never>; stop: () => void } {
  let onAbort = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new BuildMenuError('cancelled', 409));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, stop: () => signal.removeEventListener('abort', onAbort) };
}

export async function runWebsiteHost(input: {
  workspace: string;
  script: WebsiteHostScript;
  port?: number;
  spawnImpl: (command: WebsiteHostCommand) => Promise<number>;
}): Promise<void> {
  const commands = websiteHostCommands(input.workspace, input.script, input.port);
  for (const command of commands) {
    const code = await deliverWebsiteHostCommand(command, input.spawnImpl);
    if (code !== 0) throw new BuildMenuError('tool_failed', 500);
  }
}

export async function deliverWebsiteHostCommand<T>(
  command: WebsiteHostCommand,
  runner: (command: WebsiteHostCommand) => Promise<T>,
): Promise<T> {
  if (hostCommandRefused(command)) throw new BuildMenuError('invalid_request', 400);
  return runner(command);
}

function hostCommandRefused(command: WebsiteHostCommand): boolean {
  const joined = command.args.join(' ');
  return command.args.some((arg) => hostArgRefused(arg)) || hostArgRefused(joined);
}

function hostArgRefused(arg: string): boolean {
  return hostArgForms(arg).some((form) => REMOTE_URL.test(form) || MAILTO.test(form) || PROTOCOL_RELATIVE.test(form) || LIFECYCLE_SCRIPT.test(form));
}

function hostArgForms(arg: string): string[] {
  const forms: string[] = [];
  const seen = new Set<string>();
  const remember = (value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    forms.push(value);
  };
  let pending = [arg];
  for (let depth = 0; depth < 3; depth += 1) {
    const layer = pending;
    pending = [];
    for (const item of layer) {
      const collapsed = collapseQuotes(item);
      remember(item);
      remember(collapsed);
      remember(item.replace(/['"]/g, ''));
      remember(collapsed.replace(/['"]/g, ''));
      if (depth === 2) continue;
      pending.push(decodePercent(item), decodePercent(collapsed));
    }
  }
  return forms;
}

function collapseQuotes(value: string): string {
  let current = value;
  let previous = '';
  while (current !== previous) {
    previous = current;
    current = current.replace(/['"]\s*\+\s*['"]/g, '');
  }
  return current;
}

function decodePercent(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export function websiteHostCommands(workspace: string, script: WebsiteHostScript, port?: number): WebsiteHostCommand[] {
  if (script !== 'typecheck' && script !== 'build' && script !== 'dev') throw new BuildMenuError('invalid_request', 400);
  if (script === 'dev' && !ownedPort(port)) throw new BuildMenuError('invalid_request', 400);
  assertFrozenWebsiteTemplate(workspace);
  assertApprovedLock(workspace);
  const cwd = appDir(workspace);
  const env = hostEnv(workspace);
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install: WebsiteHostCommand = { executable, args: ['ci', '--ignore-scripts'], cwd, shell: false, env };
  const runArgs = script === 'dev'
    ? ['--ignore-scripts', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : ['--ignore-scripts', 'run', script];
  return [install, { executable, args: runArgs, cwd, shell: false, env }];
}

function ownedPort(port: number | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function appDir(workspace: string): string {
  const root = path.resolve(workspace);
  const cwd = path.resolve(root, 'app');
  const relative = path.relative(root, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new BuildMenuError('unsafe_path', 400);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(cwd);
  } catch {
    throw new BuildMenuError('unsafe_path', 400);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BuildMenuError('unsafe_path', 400);
  return cwd;
}

function assertApprovedLock(workspace: string): void {
  if (approvedLock === null) throw new BuildMenuError('missing_requirement', 400);
  const file = path.join(workspace, 'app', 'package-lock.json');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new BuildMenuError('missing_requirement', 400);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BuildMenuError('unsafe_path', 400);
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== approvedLock) throw new BuildMenuError('missing_requirement', 400);
}

function hostEnv(workspace: string): Record<string, string> {
  const env: Record<string, string> = {
    npm_config_cache: path.join(path.resolve(workspace), '.loam', 'build-menu', 'npm-cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'PATHEXT', 'ComSpec'] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}
