import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { Checkpoint, VerifierSpec, VerifyContext } from "./types.js";

export function safeResolve(workspace: string, rel: string): string | null {
  const ws = path.resolve(workspace);
  const full = path.resolve(ws, rel);
  if (full === ws || full.startsWith(ws + path.sep)) return full;
  return null;
}

interface ShellOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runShell(command: string, cwd: string, timeoutMs = 60_000): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, windowsHide: true })
      : spawn("/bin/sh", ["-c", command], { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, add: string): string => (s.length >= 64_000 ? s : s + add);
    child.stdout.on("data", (c: Buffer) => void (stdout = cap(stdout, c.toString("utf8"))));
    child.stderr.on("data", (c: Buffer) => void (stderr = cap(stderr, c.toString("utf8"))));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
  });
}

function getJsonPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".").filter((p) => p.length > 0)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function parseJudgeJson(text: string): { pass: boolean; reason: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { pass?: unknown; reason?: unknown };
    if (typeof parsed.pass !== "boolean") return null;
    return { pass: parsed.pass, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return null;
  }
}

export async function checkVerifier(spec: VerifierSpec, ctx: VerifyContext): Promise<Checkpoint> {
  const type = spec.type;
  try {
    if (type === "file_exists" || type === "file_absent") {
      const full = safeResolve(ctx.workspace, spec.path);
      if (!full) return { type, ok: false, detail: `مسار خارج مجلد الحالة: ${spec.path}` };
      const exists = fs.existsSync(full) && fs.statSync(full).isFile();
      const want = type === "file_exists";
      return { type, ok: exists === want, detail: `${spec.path}: ${exists ? "الملف موجود" : "الملف غير موجود"} (المطلوب: ${type})` };
    }
    if (type === "file_contains") {
      const full = safeResolve(ctx.workspace, spec.path);
      if (!full) return { type, ok: false, detail: `مسار خارج مجلد الحالة: ${spec.path}` };
      if (!fs.existsSync(full)) return { type, ok: false, detail: `الملف غير موجود: ${spec.path}` };
      const content = fs.readFileSync(full, "utf8");
      const ok = content.includes(spec.text);
      return { type, ok, detail: ok ? `عُثر على النص في ${spec.path}` : `النص غير موجود في ${spec.path}` };
    }
    if (type === "file_matches") {
      const full = safeResolve(ctx.workspace, spec.path);
      if (!full) return { type, ok: false, detail: `مسار خارج مجلد الحالة: ${spec.path}` };
      if (!fs.existsSync(full)) return { type, ok: false, detail: `الملف غير موجود: ${spec.path}` };
      let re: RegExp;
      try {
        re = new RegExp(spec.pattern, spec.flags ?? "s");
      } catch {
        return { type, ok: false, detail: `نمط regex غير صالح: ${spec.pattern}` };
      }
      const ok = re.test(fs.readFileSync(full, "utf8"));
      return { type, ok, detail: ok ? `المحتوى يطابق النمط في ${spec.path}` : `المحتوى لا يطابق: ${spec.pattern}` };
    }
    if (type === "shell_exit") {
      const out = await runShell(spec.command, ctx.workspace);
      const want = spec.exitCode ?? 0;
      const ok = !out.timedOut && out.code === want;
      return { type, ok, detail: `exit=${out.code}${out.timedOut ? " (timeout)" : ""} expected=${want}` };
    }
    if (type === "shell_contains") {
      const out = await runShell(spec.command, ctx.workspace);
      const ok = `${out.stdout}\n${out.stderr}`.includes(spec.text);
      return { type, ok, detail: ok ? "النص موجود في مخرجات الأمر" : "النص غير موجود في مخرجات الأمر" };
    }
    if (type === "http_ok") {
      const res = await fetch(spec.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { type, ok: false, detail: `HTTP ${res.status} ${spec.url}` };
      if (spec.jsonPath) {
        const body = (await res.json()) as unknown;
        const value = getJsonPath(body, spec.jsonPath);
        const ok = value !== undefined && value !== null;
        return { type, ok, detail: ok ? `${spec.jsonPath}=${JSON.stringify(value).slice(0, 120)}` : `${spec.jsonPath} غير موجود` };
      }
      return { type, ok: true, detail: `HTTP ${res.status}` };
    }
    if (type === "tool_used") {
      const matches = ctx.trace.filter((t) => t.name === spec.name && (spec.expectOk === false || t.ok));
      const min = spec.minCount ?? 1;
      const ok = matches.length >= min;
      return { type, ok, detail: `${spec.name}: ${matches.length}/${min} استخدام` };
    }
    if (type === "answer_matches") {
      let re: RegExp;
      try {
        re = new RegExp(spec.pattern, spec.flags ?? "i");
      } catch {
        return { type, ok: false, detail: `نمط regex غير صالح: ${spec.pattern}` };
      }
      const ok = re.test(ctx.finalText);
      return { type, ok, detail: ok ? "الإجابة مطابقة" : `الإجابة لا تطابق: ${spec.pattern}` };
    }
    if (type === "llm_judge") {
      if (!ctx.ollama) return { type, ok: false, detail: "llm_judge يتطلب اتصال Ollama" };
      const result = await ctx.ollama.chat({
        model: ctx.cfg.selfImprove.model || ctx.cfg.model,
        messages: [
          {
            role: "system",
            content:
              'You are a strict grader. Judge whether the final answer satisfies the rubric. Reply with ONLY JSON: {"pass": true|false, "reason": "..."}',
          },
          {
            role: "user",
            content: `RUBRIC:\n${spec.rubric}\n\nFINAL ANSWER:\n${ctx.finalText.slice(0, 4000)}`,
          },
        ],
        temperature: 0,
        timeoutMs: 120_000,
      });
      const judged = parseJudgeJson(result.content);
      if (!judged) return { type, ok: false, detail: "فشل تحليل حكم الموديل" };
      return { type, ok: judged.pass, detail: judged.reason.slice(0, 300) || "llm_judge" };
    }
    return { type: "unknown", ok: false, detail: "نوع verifier غير معروف" };
  } catch (err) {
    return { type, ok: false, detail: `خطأ في التحقق: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runVerifiers(specs: VerifierSpec[] | undefined, ctx: VerifyContext): Promise<Checkpoint[]> {
  if (!specs || specs.length === 0) {
    return [{ type: "verifier_missing", ok: false, detail: "لا توجد verifiers لهذه الحالة" }];
  }
  const out: Checkpoint[] = [];
  for (const spec of specs) out.push(await checkVerifier(spec, ctx));
  return out;
}
