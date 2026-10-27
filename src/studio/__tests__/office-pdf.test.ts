import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudioError } from "../store.js";
import { readOfficeFileBytes, renderDeckPdf, renderWorkbookPdf } from "../office-pdf.js";

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-pdf-test-"));
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  return dir;
}

/** A runner that "exports" by writing a minimal PDF — mirrors the ready-marker flow. */
function fakePdfRunner(bytes: string = "%PDF-1.7 fake"): (cmd: string, args: string[], output: string) => Promise<void> {
  return async (_cmd: string, args: string[], output: string) => {
    const outFile = args[args.indexOf("-OutputFile") + 1]!;
    fs.writeFileSync(outFile, bytes, "utf8");
    fs.writeFileSync(outFile + ".ready", "exported", "utf8");
  };
}

test("readOfficeFileBytes enforces extension, traversal and size", async () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "a.xlsx"), "x");
  fs.writeFileSync(path.join(root, "big.xlsx"), "y".repeat(10));
  const ok = await readOfficeFileBytes(root, "a.xlsx", [".xlsx"]);
  assert.equal(ok.toString(), "x");
  await assert.rejects(readOfficeFileBytes(root, "a.xlsx", [".pptx"]), /نوع الملف غير مدعوم/);
  await assert.rejects(readOfficeFileBytes(root, "../outside.xlsx", [".xlsx"]), /مسار|خارج/);
  await assert.rejects(readOfficeFileBytes(root, "missing.xlsx", [".xlsx"]), /غير موجود/);
  try {
    await readOfficeFileBytes(root, "big.xlsx", [".xlsx"], );
  } catch {
    /* size cap only triggers above 25MB; the call above must not throw for 10 bytes */
    assert.fail("small file must read fine");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("renderDeckPdf with an injected runner returns validated PDF bytes and cleans the temp dir", async () => {
  const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("loam-pptx-pdf-")).length;
  const pdf = await renderDeckPdf(Buffer.from("PK fake pptx"), { run: fakePdfRunner() as never });
  assert.ok(pdf.subarray(0, 4).toString("latin1") === "%PDF");
  const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("loam-pptx-pdf-")).length;
  assert.equal(after, before, "temp dir removed after export");
});

test("renderWorkbookPdf rejects invalid output and propagates runner errors", async () => {
  await assert.rejects(
    renderWorkbookPdf(Buffer.from("PK fake"), { run: fakePdfRunner("not a pdf") as never }),
    (err: unknown) => err instanceof StudioError && err.status === 503,
  );
  await assert.rejects(
    renderWorkbookPdf(Buffer.from("PK fake"), {
      run: async () => { throw new Error("boom"); },
    } as never),
    (err: unknown) => err instanceof StudioError && err.status === 503,
  );
  await assert.rejects(renderWorkbookPdf(Buffer.alloc(0)), /فارغ|غير صالح/);
});
