import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { Document, Header, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { segmentContract } from "../contract/clauses.js";
import { buildOriginalRedlineDocx } from "../contract/ooxmlRedline.js";
import { buildRedlineDocx } from "../contract/redline.js";
import { finalizeApprovedRedlineDocx } from "../contract/finalizeRedline.js";
import { DRAFT_WATERMARK_AR } from "../review.js";

async function originalDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [{
      headers: { default: new Header({ children: [new Paragraph("Original header")] }) },
      children: [
        new Paragraph("عقد تجريبي"),
        new Paragraph("البند 1"),
        new Paragraph("الثمن 1000 ريال"),
        new Paragraph("البند 2"),
        new Paragraph("السرية"),
        new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("جدول يجب أن يبقى")] })] })] }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

test("OOXML redline edits only the target clause and preserves the package", async () => {
  const original = await originalDocx();
  const text = "عقد تجريبي\nالبند 1\nالثمن 1000 ريال\nالبند 2\nالسرية";
  const clauses = segmentContract("ct-1", text);
  const target = clauses.find((clause) => clause.text.includes("1000"))!;
  const output = await buildOriginalRedlineDocx(original, clauses, [{ clauseId: target.id, newText: target.text.replace("1000", "2000") }], { author: "Loam Legal", date: "2026-10-26T00:00:00Z", rtl: true, draft: true });
  const zip = await JSZip.loadAsync(output);
  const xml = await zip.file("word/document.xml")!.async("string");
  assert.match(xml, /w:ins/);
  assert.match(xml, /w:del/);
  assert.match(xml, /2000/);
  assert.match(xml, /جدول يجب أن يبقى/);
  assert.match(await zip.file("word/headerLegalDraft.xml")!.async("string"), new RegExp(DRAFT_WATERMARK_AR));
  const originalZip = await JSZip.loadAsync(original);
  assert.equal(await zip.file("word/styles.xml")!.async("string"), await originalZip.file("word/styles.xml")!.async("string"));
  assert.match(await zip.file("word/header1.xml")!.async("string"), /Original header/);
});

test("final original redline omits the draft header", async () => {
  const original = await originalDocx();
  const text = "عقد تجريبي\nالبند 1\nالثمن 1000 ريال";
  const clauses = segmentContract("ct-1", text);
  const target = clauses.find((clause) => clause.text.includes("1000"))!;
  const output = await buildOriginalRedlineDocx(original, clauses, [{ clauseId: target.id, newText: target.text.replace("1000", "2000") }], { author: "Loam Legal", date: "2026-10-26T00:00:00Z", rtl: true, draft: false });
  const zip = await JSZip.loadAsync(output);
  assert.equal(zip.file("word/headerLegalDraft.xml"), null);
});

test("approved finalization removes only the draft header and preserves tracked changes", async () => {
  const original = await originalDocx();
  const clauses = segmentContract("ct-1", "عقد تجريبي\nالبند 1\nالثمن 1000 ريال");
  const target = clauses.find((clause) => clause.text.includes("1000"))!;
  const edits = [{ clauseId: target.id, newText: target.text.replace("1000", "2000") }];
  const options = { author: "Loam Legal", date: "2026-10-26T00:00:00Z", rtl: true, draft: true };
  const originalRedline = await buildOriginalRedlineDocx(original, clauses, edits, options);
  const generatedRedline = await buildRedlineDocx(clauses, edits, { ...options, title: "عقد" });
  for (const { draft, originalHeader } of [{ draft: originalRedline, originalHeader: true }, { draft: generatedRedline, originalHeader: false }]) {
    const before = await JSZip.loadAsync(draft);
    const final = await finalizeApprovedRedlineDocx(draft);
    const after = await JSZip.loadAsync(final);
    const revisionCount = (xml: string) => (xml.match(/<w:(?:ins|del)\b/g) ?? []).length;
    assert.equal(revisionCount(await after.file("word/document.xml")!.async("string")), revisionCount(await before.file("word/document.xml")!.async("string")));
    if (originalHeader) assert.match(await after.file("word/header1.xml")!.async("string"), /Original header/);
    const headers = Object.keys(after.files).filter((name) => /^word\/header[^/]*\.xml$/.test(name));
    for (const header of headers) assert.doesNotMatch(await after.file(header)!.async("string"), new RegExp(DRAFT_WATERMARK_AR));
    await assert.rejects(finalizeApprovedRedlineDocx(final), /exactly one draft watermark/);
  }
});
