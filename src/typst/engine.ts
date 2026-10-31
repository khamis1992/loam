/**
 * Local Typst compiler — blueprint gap 2 (academic publishing engine).
 *
 * Wraps @myriaddreamin/typst-ts-node-compiler (the official typst.ts native
 * binding) so a task can typeset `.typ` sources into PDF entirely on-device:
 * math, bibliography, figure numbering — the academic layer the office suite
 * lacked. A fresh compiler instance is created per compile on purpose: typst
 * sources and virtual files must never leak from one task into another.
 *
 * Fonts: system font directories plus `<workspace>/fonts` are scanned; typst
 * substitutes a close family when the requested one is missing (a warning,
 * not an error).
 */
import fs from "node:fs";
import path from "node:path";
import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";

export interface TypstCompileOptions {
  /** Absolute path of the entry `.typ` file. */
  mainPath: string;
  /** Typst workspace root: module imports and `fonts/` lookup happen here. */
  workspaceRoot: string;
  /** Extra virtual sources keyed by path relative to the workspace root. */
  sources?: Record<string, string>;
  /** `sys.inputs` key/value pairs for the document. */
  inputs?: Record<string, string>;
  /** Additional font directories to scan. */
  fontDirs?: string[];
}

export interface TypstCompileResult {
  ok: boolean;
  /** The PDF bytes on success, null otherwise. */
  pdf: Buffer | null;
  /** Human-readable diagnostics: errors first, then warnings. */
  diagnostics: string[];
  pages: number;
  title: string | null;
}

/** System font directories worth scanning, per platform. */
export function systemFontDirs(): string[] {
  if (process.platform === "win32") {
    return [process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : "C:\\Windows\\Fonts", path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts")];
  }
  if (process.platform === "darwin") {
    return ["/System/Library/Fonts", "/Library/Fonts", path.join(process.env.HOME ?? "", "Library", "Fonts")];
  }
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(process.env.HOME ?? "", ".fonts")];
}

function formatDiagnostics(items: unknown[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      out.push(item);
    } else if (item && typeof item === "object") {
      const d = item as Record<string, unknown>;
      // typical shape: { severity, message } or { message }
      const severity = typeof d.severity === "string" ? d.severity : "";
      const message = typeof d.message === "string" ? d.message : JSON.stringify(item);
      out.push(severity ? `${severity}: ${message}` : message);
    }
  }
  return out.filter((line) => line.length > 0);
}

/** Compile one Typst document. Synchronous and self-contained: never throws. */
export function compileTypst(opts: TypstCompileOptions): TypstCompileResult {
  const fail = (diagnostics: string[]): TypstCompileResult => ({ ok: false, pdf: null, diagnostics, pages: 0, title: null });
  let compiler: NodeCompiler;
  const fontPaths = [...systemFontDirs(), ...(opts.fontDirs ?? []), path.join(opts.workspaceRoot, "fonts")]
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  try {
    compiler = NodeCompiler.create({
      workspace: opts.workspaceRoot,
      inputs: opts.inputs ?? {},
      fontArgs: [{ fontPaths }],
    });
  } catch (err) {
    return fail([`typst init failed: ${err instanceof Error ? err.message : String(err)}`]);
  }
  for (const [rel, source] of Object.entries(opts.sources ?? {})) {
    try {
      compiler.addSource(path.join(opts.workspaceRoot, rel), source);
    } catch (err) {
      return fail([`could not stage virtual source ${rel}: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }
  let compiled;
  try {
    compiled = compiler.compile({ mainFilePath: opts.mainPath });
  } catch (err) {
    return fail([`typst compile crashed: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const diagnostics: string[] = [];
  for (const node of [compiled.takeWarnings(), compiled.takeError()]) {
    if (node) diagnostics.push(...formatDiagnostics(compiler.fetchDiagnostics(node)));
  }
  const doc = compiled.result;
  if (compiled.hasError() || !doc) {
    return fail(diagnostics.length > 0 ? diagnostics : ["typst compile failed without diagnostics"]);
  }
  let pdf: Buffer;
  try {
    pdf = compiler.pdf(doc);
  } catch (err) {
    return fail([...diagnostics, `pdf export failed: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return { ok: true, pdf, diagnostics, pages: doc.numOfPages, title: doc.title };
}
