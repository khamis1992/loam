/** One-time Windows OS install (OD-2/OD-4) — SANDBOX_RUNTIME_INTO_LOAM §2.5.
 *  Always user-initiated (Settings button / API call); the CLI self-elevates
 *  (UAC dialog appears on Khamis's screen). Default --skip-profile-grant keeps
 *  other profiles unreadable (OD-4). A cancelled UAC is a friendly no-op, never
 *  an error state. Uninstall stays documented-only in v1 (W14). */
import { spawn } from "node:child_process";
import { srtAudit } from "./audit.js";
import { srtCliEntry, srtWinExePath, verifySrtPin } from "./policy.js";

export interface SrtInstallResult {
  ok: boolean;
  /** UAC declined / elevation cancelled by the user — nothing changed. */
  cancelled: boolean;
  message: string;
  detail?: string;
}

/** Spawns `node <pin>/dist/cli.js windows-install [--skip-profile-grant] --srt-win <path>`. */
export async function runSrtWindowsInstall(opts: { skipProfileGrant?: boolean } = {}): Promise<SrtInstallResult> {
  const skipProfileGrant = opts.skipProfileGrant ?? true; // OD-4
  const verify = verifySrtPin();
  if (!verify.ok) {
    return { ok: false, cancelled: false, message: `تعذّر التحقق من ملف العزل (${verify.reason}) — أعد تشغيل مثبّت Loam`, detail: verify.reason };
  }
  srtAudit().append({ name: "srt_install_started", outcome: "started", skipProfileGrant });
  const args = [srtCliEntry(), "windows-install"];
  if (skipProfileGrant) args.push("--skip-profile-grant");
  args.push("--srt-win", srtWinExePath());

  return await new Promise<SrtInstallResult>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", (err) => {
      srtAudit().append({ name: "srt_install_finished", outcome: "failed", skipProfileGrant, detail: err.message.slice(0, 160) });
      resolve({ ok: false, cancelled: false, message: "فشل تشغيل مثبّت العزل", detail: err.message.slice(0, 200) });
    });
    child.on("close", (code) => {
      const tail = out.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 240);
      const cancelled = code === 2 || /cancel|denied|elevat/i.test(out);
      if (code === 0) {
        srtAudit().append({ name: "srt_install_finished", outcome: "completed", skipProfileGrant });
        resolve({ ok: true, cancelled: false, message: "العزل جاهز — تم تثبيت عزل النظام", detail: tail });
      } else if (cancelled) {
        srtAudit().append({ name: "srt_install_finished", outcome: "skipped", skipProfileGrant, detail: "UAC cancelled" });
        resolve({ ok: false, cancelled: true, message: "تم إلغاء التثبيت (رفض صلاحية المدير) — لم يتغير شيء", detail: tail });
      } else {
        srtAudit().append({ name: "srt_install_finished", outcome: "failed", skipProfileGrant, detail: tail });
        resolve({ ok: false, cancelled: false, message: `فشل التثبيت (رمز ${code})`, detail: tail });
      }
    });
  });
}
