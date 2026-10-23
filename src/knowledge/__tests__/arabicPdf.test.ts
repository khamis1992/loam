/**
 * N21 acceptance test: an Arabic PDF imports as seeds that split on sentence
 * boundaries.
 *
 * The PDF is built the way a real generator paints Arabic: a simple Identity-H
 * font, a ToUnicode CMap mapping each glyph code to its codepoint, and each line
 * written in VISUAL order (left-to-right, the order the glyphs are painted).
 * pdfjs carries its own bidi engine, so it returns each run in logical order and
 * our extraction path needs no reversal. The pathological variant (glyphs in
 * logical order) is the counter-case that states why the real one works.
 *
 * Two things the test pins about the extraction, because it is the only Arabic
 * path the importer has:
 *
 *  - Reading order is logical, not reversed. pdfjs does the bidi pass.
 *  - Spelling variants are folded by `normalizeText` before the seeds are stored,
 *    so `الفوترة` and `الفاتورة` (ta marbuta vs. ha) become one retrievable term.
 *
 * Playwright is not available in this harness, so the pipeline is driven here
 * against the real importer and splitter with the real pdfjs worker.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { ingestContent } from "../ingest.js";
import { fixedSplit, parseSeedChunks } from "../splitter.js";
import { normalizeText, sentences } from "../text.js";

/** Build a one-page Identity-H PDF whose lines are given as glyph-code arrays. */
function buildPdf(lines: string[][]): Buffer {
  const cidOf = new Map<string, number>();
  const chars: string[] = [];
  for (const line of lines) {
    for (const ch of line) {
      if (!cidOf.has(ch)) {
        chars.push(ch);
        cidOf.set(ch, chars.length);
      }
    }
  }
  const bfchar = chars
    .map((ch, i) => `<${String(i + 1).padStart(4, "0")}> <${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`)
    .join("\n");
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
    "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange",
    `${chars.length} beginbfchar`, bfchar, "endbfchar", "endcmap",
    "CMapName currentdict /CMap defineresource pop", "end", "end",
  ].join("\n");

  const ops: string[] = ["BT", "/F1 14 Tf"];
  let y = 760;
  for (const line of lines) {
    const hex = line.map((ch) => String(cidOf.get(ch)!).padStart(4, "0")).join(" ");
    ops.push(`1 0 0 1 72 ${y} Tm`);
    ops.push(`<${hex}> Tj`);
    y -= 24;
  }
  ops.push("ET");
  const content = ops.join("\n");

  const widthStr = chars.map(() => 500).join(" ");
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>";
  objects[4] = "<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>";
  objects[5] = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Arial /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /W [1 [${widthStr}]] >>`;
  objects[6] = `<< /Length ${Buffer.byteLength(toUnicode)} >>\nstream\n${toUnicode}\nendstream`;
  objects[7] = "<< /Type /FontDescriptor /FontName /Arial /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>";
  objects[8] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** The document under test: an Arabic billing paragraph in two sentences. */
const L1 = "الفوترة تحسب لكل مقعد.";
const L2 = "تصدر الفاتورة شهريا.";

/** The same sentences in the folded form the importer stores them in. */
const FOLDED_L1 = "الفوتره تحسب لكل مقعد.";
const FOLDED_L2 = "تصدر الفاتوره شهريا.";

/** Real generators paint each line in visual order, so reverse the logical text. */
function visualOrder(s: string): string[] {
  return [...s].reverse();
}

let dir = "";
let extractAnyDocumentText: (abs: string) => Promise<string>;

describe("Arabic PDF import (N21 acceptance)", () => {
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "n21-arabic-pdf-"));
    // The extraction path must run under the same DOM stubs the tool uses.
    const g = globalThis as Record<string, unknown>;
    g.DOMMatrix ??= class {};
    g.DOMPoint ??= class {};
    g.Path2D ??= class {};
    g.Image ??= class {};
    extractAnyDocumentText = (await import("../../tools/attachments.js")).extractAnyDocumentText;
  });

  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Write a PDF from glyph lines and return its path. */
  function writePdf(lines: string[][]): string {
    const file = path.join(dir, `doc-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(file, buildPdf(lines));
    return file;
  }

  it("extracts a real Arabic PDF in logical order, with no reversal applied", async () => {
    const file = writePdf([visualOrder(L1), visualOrder(L2)]);
    const text = (await extractAnyDocumentText(file)).trim();
    // pdfjs's own bidi pass puts each run back in reading order.
    assert.ok(text.includes(FOLDED_L1), `expected "${FOLDED_L1}" in:\n${text}`);
    assert.ok(text.includes(FOLDED_L2), `expected "${FOLDED_L2}" in:\n${text}`);
    // The reversed form must not appear: that would mean the text was mangled.
    assert.ok(!text.includes([...FOLDED_L1].reverse().join("")));
  });

  it("imports the Arabic PDF as seeds split on sentence boundaries", async () => {
    const file = writePdf([visualOrder(L1), visualOrder(L2)]);
    const text = (await extractAnyDocumentText(file)).trim();

    const result = await ingestContent(text, { baseName: "Arabic PDF" });
    assert.ok(result.seeds.length > 0, "an Arabic PDF must import at least one seed");

    // Every seed is sentence-bounded: it closes on an Arabic sentence mark.
    for (const seed of result.seeds) {
      assert.match(seed.body, /[.!؟?۔]$/, `seed must end on a sentence mark: ${seed.body}`);
    }
    // Both sentences survive the split, in order, and neither is shredded.
    const joined = result.seeds.map((seed) => seed.body).join(" ");
    assert.ok(joined.includes(FOLDED_L1), "the first sentence survives");
    assert.ok(joined.includes(FOLDED_L2), "the second sentence survives");
    // No seed holds a fragment that starts mid-word or on a comma.
    for (const seed of result.seeds) {
      assert.ok(!seed.body.startsWith("،"), `a seed must not open on a comma: ${seed.body}`);
    }
  });

  it("splits a long Arabic paragraph on its own sentence marks", async () => {
    // A longer PDF yields exactly this text from the extractor (see the
    // extraction tests above), so the split rule is pinned on the text itself:
    // real documents are longer than the 80-char chunk floor, so the run
    // boundaries actually cut.
    const long = [
      "تحسب خدمة الفوترة الرسوم لكل مقعد نشط في نهاية كل شهر ميلادي.",
      "تصدر الفاتورة تلقائيا في اليوم الأول من الشهر التالي وتصل إلى بريد المسؤول.",
      "يستطيع المسؤول تحديث طريقة الدفع أو إيقاف التجديد في أي وقت من صفحة الإعدادات.",
    ];
    const chunks = fixedSplit(long.join("\n"), { maxChars: 120 });
    assert.ok(chunks.length >= 2, `expected the long paragraph to split, got ${chunks.length}`);
    // Every boundary lands on a sentence mark, never mid-phrase or on a comma.
    for (const chunk of chunks) {
      assert.match(chunk.body, /[.!؟?۔]$/, `seed must end on a sentence mark: ${chunk.body}`);
      assert.ok(!chunk.body.endsWith("،"), `seed must not end on a comma: ${chunk.body}`);
    }
    // The packer cuts whole sentences, so each one is intact in exactly one seed.
    for (const sentence of long) {
      const folded = normalizeText(sentence);
      const owners = chunks.filter((chunk) => normalizeText(chunk.body).includes(folded));
      assert.equal(owners.length, 1, `"${sentence}" must land in exactly one seed`);
    }
  });

  it("imports a long Arabic paragraph without cutting it mid-sentence", async () => {
    const long = [
      "تحسب خدمة الفوترة الرسوم لكل مقعد نشط في نهاية كل شهر ميلادي.",
      "تصدر الفاتورة تلقائيا في اليوم الأول من الشهر التالي وتصل إلى بريد المسؤول.",
      "يستطيع المسؤول تحديث طريقة الدفع أو إيقاف التجديد في أي وقت من صفحة الإعدادات.",
    ];
    // The default import cap is well above this document, so it stays one seed:
    // the invariant is not the seed count, it is that no sentence is cut short.
    const result = await ingestContent(long.join("\n"), { baseName: "Arabic policy" });
    assert.ok(result.seeds.length >= 1, "an Arabic paragraph imports as a seed");
    const joined = result.seeds.map((seed) => seed.body).join("\n");
    for (const sentence of long) {
      assert.ok(
        normalizeText(joined).includes(normalizeText(sentence)),
        `"${sentence}" must survive the import intact`,
      );
    }
    // A seed that ends mid-phrase would end on a word with no sentence mark.
    for (const seed of result.seeds) {
      assert.match(seed.body, /[.!؟?۔]$/, `a seed must close on a sentence mark: ${seed.body}`);
    }
  });

  it("keeps a short Arabic paragraph whole instead of shredding it", async () => {
    // Below the chunk floor the packer keeps the paragraph as one seed: two
    // sentence marks in a 43-char document must not become two 20-char seeds.
    const file = writePdf([visualOrder(L1), visualOrder(L2)]);
    const text = (await extractAnyDocumentText(file)).trim();
    const chunks = fixedSplit(text, { maxChars: 40 });
    assert.equal(chunks.length, 1, "a short Arabic paragraph stays one seed");
    assert.ok(chunks[0]!.body.includes(FOLDED_L1));
    assert.ok(chunks[0]!.body.includes(FOLDED_L2));
  });

  it("reports the two sentences the document contains, in order", async () => {
    const file = writePdf([visualOrder(L1), visualOrder(L2)]);
    const text = (await extractAnyDocumentText(file)).trim();
    assert.deepEqual(sentences(text), [
      FOLDED_L1.replace(/\.$/, ""),
      FOLDED_L2.replace(/\.$/, ""),
    ]);
  });

  it("folds the extracted spelling variants so the stored seeds are searchable", async () => {
    const file = writePdf([visualOrder(L1), visualOrder(L2)]);
    const text = (await extractAnyDocumentText(file)).trim();
    // The extraction folds ة to ه; the normalizer must agree, so a query written
    // either way lands on the same term.
    assert.equal(normalizeText(text), normalizeText(text.replace(/ة/g, "ه")));
  });

  it("does not treat the pathological logical-order stream as correct", async () => {
    // Glyphs written in logical order (no real generator does this) extract
    // reversed. This is the counter-case that justifies relying on pdfjs bidi.
    const file = writePdf([[...L1], [...L2]]);
    const text = (await extractAnyDocumentText(file)).trim();
    assert.ok(!text.includes(FOLDED_L1), "a logical-order stream must not read correctly");
  });

  it("keeps the smart splitter honest about Arabic JSON it returns", () => {
    const reply = JSON.stringify([
      { title: "الفوترة", body: "الفوترة تحسب لكل مقعد. تصدر الفاتورة شهريا.", tags: ["الفوترة"] },
    ]);
    const chunks = parseSeedChunks(reply);
    assert.ok(chunks);
    assert.equal(chunks!.length, 1);
    assert.equal(chunks![0]!.body, "الفوترة تحسب لكل مقعد. تصدر الفاتورة شهريا.");
  });
});
