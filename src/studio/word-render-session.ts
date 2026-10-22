import fs from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import { ROOT } from '../config.js';
import { StudioError } from './store.js';

type Owner = { id: number; started: string };
type Pending = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Stop only the dedicated Word process identified by PID and creation time; never a general Word sweep. */
async function stopOwnedWord(owner: Owner): Promise<void> {
  await new Promise<void>(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p=Get-Process -Id ${owner.id} -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -eq 'WINWORD' -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${owner.started}'){Stop-Process -Id $p.Id -Force}`,
  ], { windowsHide: true, timeout: 10_000 }, () => resolve()));
}

/**
 * One long-lived dedicated Word process answers every preview render, so saves skip the
 * per-render PowerShell and Word startup cost. A crash, hang or startup failure tears the
 * session down by its recorded owner and retries once with a fresh session; ownership is
 * written at session startup, before any document work, so no failure can strand a Word
 * process. Document-level open/export failures are reported to the caller without a retry.
 */
class WordRenderSession {
  private child: ChildProcess | null = null;
  private dir: string | null = null;
  private owner: Owner | null = null;
  private handshake: Promise<void> = Promise.resolve();
  private pending = new Map<number, Pending>();
  private commands = 0;
  private renders = 0;
  private recoveries = 0;
  private idle: NodeJS.Timeout | null = null;

  status() { return { running: !!(this.child && this.child.exitCode === null), owner: this.owner, renders: this.renders, recoveries: this.recoveries }; }

  private touchIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { void this.shutdown(); }, 10 * 60_000);
    this.idle.unref?.();
  }

  private async readOwner(): Promise<Owner | null> {
    try {
      const value = JSON.parse((await fs.readFile(path.join(this.dir!, 'owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
      return Number.isSafeInteger(value?.id) && value.id > 0 && /^\d+$/.test(String(value.started)) ? { id: value.id, started: String(value.started) } : null;
    } catch { return null; }
  }

  /** Route one helper stdout line to its waiting render call. */
  private route(line: string) {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (!Number.isSafeInteger(message?.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve();
    else pending.reject(coded(String(message.error ?? 'render failed'), message.fatal ? 'session-crash' : 'render-error'));
  }

  private async destroy() {
    const child = this.child;
    this.child = null; this.handshake = Promise.resolve();
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(coded('session died', 'session-crash')); }
    this.pending.clear();
    const dir = this.dir;
    const owner = await this.readOwner().catch(() => null);
    this.dir = null; this.owner = null;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise<void>(resolve => { const done = () => resolve(); child.once('exit', done); setTimeout(done, 3000); });
    }
    if (owner) await stopOwnedWord(owner).catch(() => {});
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  private start(): Promise<void> {
    if (!this.dir) this.dir = mkdtempSync(path.join(os.tmpdir(), 'loam-word-session-'));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/render-word-preview-server.ps1'), '-OwnerFile', path.join(this.dir, 'owner.json')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      const fail = (message: string) => { this.handshake = Promise.resolve(); void this.destroy().then(() => reject(coded(message, 'session-crash'))); };
      const timer = setTimeout(() => fail('تعذّر تشغيل جلسة معاينة Word خلال المهلة المحددة.'), 60_000);
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line: string) => {
        if (line.includes('"hello"')) {
          clearTimeout(timer);
          void this.readOwner().then(owner => { this.owner = owner; });
          resolve();
          return;
        }
        this.route(line);
      });
      child.stderr!.on('data', () => { /* helper diagnostics only */ });
      child.once('exit', code => { clearTimeout(timer); fail(`انتهت جلسة معاينة Word قبل الجهوزية (${code}).`); });
    });
    this.handshake = ready;
    return ready;
  }

  private ensure(): Promise<void> {
    if (this.child && this.child.exitCode === null) return this.handshake;
    return this.start();
  }

  private send(input: string, output: string, timeout: number): Promise<void> {
    const child = this.child!;
    return new Promise<void>((resolve, reject) => {
      const id = ++this.commands;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.recoveries++;
        void this.destroy();
        reject(coded('session render timeout', 'session-timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin!.write(JSON.stringify({ id, input, output }) + '\n');
      } catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        this.recoveries++;
        void this.destroy();
        reject(coded(String(error), 'session-crash'));
      }
    });
  }

  /** Render one document through the persistent session, recovering once from a crash or hang. */
  async render(input: string, output: string, timeout = 120_000): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensure();
        this.touchIdle();
        await this.send(input, output, timeout);
        this.renders++;
        return;
      } catch (error: any) {
        if (error?.code === 'render-error') throw new StudioError('تعذّر إنشاء المعاينة بواسطة Word. تأكد من تثبيته وإكمال تفعيله ثم أعد المحاولة.', 503);
        await this.destroy().catch(() => {});
        if (attempt > 0) throw new StudioError('تعذّر إنشاء المعاينة بواسطة Word بعد إعادة تشغيل الجلسة. أعد المحاولة.', 503);
        this.recoveries++;
      }
    }
  }

  /** Graceful quit for tests and idle shutdown; falls back to owner-checked teardown. */
  async shutdown() {
    const child = this.child;
    if (child && child.exitCode === null && child.stdin) { try { child.stdin.write('quit\n'); } catch { /* already gone */ } }
    if (child && child.exitCode === null) await new Promise<void>(resolve => { const done = () => resolve(); child.once('exit', done); setTimeout(done, 4000); });
    await this.destroy();
  }
}

export const wordRenderSession = new WordRenderSession();
/** Best-effort synchronous teardown: closing stdin makes the helper quit its dedicated Word cleanly. */
process.once('exit', () => { try { (wordRenderSession as any).child?.stdin?.end(); } catch { /* already gone */ } });
