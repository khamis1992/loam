import assert from "node:assert/strict";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { exportStudio } from "../studio/export.js";

const doc = await exportStudio({ kind: "document", revision: 1, title: "تقرير Loam", content: { blocks: [
  { type: "heading", text: "النتائج", bold: true }, { type: "paragraph", text: "نص قابل للتحرير <&>", italic: true }, { type: "bullet", text: "أول بند" },
] } });
assert.match(doc.filename, /\.docx$/); assert.match(doc.contentType, /wordprocessingml/);
const docZip = await JSZip.loadAsync(doc.buffer), documentXml = await docZip.file("word/document.xml")!.async("string");
assert.ok(documentXml.includes("النتائج")); assert.ok(documentXml.includes("&lt;&amp;&gt;"));
assert.match(documentXml, /w:b\b/); assert.match(documentXml, /w:i\b/); assert.match(documentXml, /w:numPr/); assert.match(documentXml, /w:bidi/);
assert.match(documentXml, /w:keepNext/); assert.match(documentXml, /w:widowControl/);
assert.match(documentXml, /w:szCs w:val="30"/); assert.match(documentXml, /w:bCs/);
assert.match(documentXml, /w:fill="EAF5F5"/); assert.match(documentXml, /w:pgSz w:w="11906" w:h="16838"/);
const headerXml = await docZip.file("word/header1.xml")!.async("string");
const footerXml = await docZip.file("word/footer1.xml")!.async("string");
assert.ok(headerXml.includes("تقرير Loam")); assert.match(footerXml, /NUMPAGES/); assert.match(footerXml, /PAGE/);
const multiline = await exportStudio({ kind: "document", revision: 1, title: "English report", content: { blocks: [
  { type: "paragraph", text: "First line\nSecond line" }, { type: "bullet", text: "English bullet" },
] } });
const multilineZip = await JSZip.loadAsync(multiline.buffer);
assert.match(await multilineZip.file("word/document.xml")!.async("string"), /w:br/);
const repeated = await exportStudio({ kind: "document", revision: 1, title: "Repeated title", content: { blocks: [
  { type: "heading", text: "Repeated title" }, { type: "paragraph", text: "Actual content" },
] } });
const repeatedZip = await JSZip.loadAsync(repeated.buffer);
assert.equal((await repeatedZip.file("word/document.xml")!.async("string")).split("Repeated title").length - 1, 1);

const deck = await exportStudio({ kind: "presentation", revision: 3, title: "عرض Loam", content: { slides: [
  { id: "one", title: "المقدمة", body: "محتوى مباشر", notes: "ملاحظة المتحدث", background: "#101827", accent: "#00bbdd" },
  { id: "two", title: "Conclusion", body: "Editable text", notes: "", background: "#ffffff", accent: "#112233" },
] } });
assert.match(deck.filename, /\.pptx$/); assert.match(deck.contentType, /presentationml/);
const pptZip = await JSZip.loadAsync(deck.buffer), slideXml = await pptZip.file("ppt/slides/slide1.xml")!.async("string");
assert.ok(slideXml.includes("المقدمة")); assert.ok(slideXml.includes("101827")); assert.match(slideXml, /00bbdd/i);
assert.ok(pptZip.file("ppt/slides/slide2.xml"));
assert.ok((await pptZip.file("ppt/notesSlides/notesSlide1.xml")!.async("string")).includes("ملاحظة المتحدث"));

const book = await exportStudio({ kind: "spreadsheet", revision: 2, title: "../CON", content: { sheets: [
  { name: "الميزانية", cells: [["البند", "القيمة"], ["أ", "12.5"], ["ب", "7"], ["المجموع", "=SUM(B2:B3)"], ["رمز", "00123"], ["معرف طويل", "12345678901234567"]] },
  { name: "Second", cells: [["second sheet"]] },
] } });
assert.match(book.filename, /\.xlsx$/); assert.ok(!book.filename.includes("/")); assert.match(book.contentType, /spreadsheetml/);
const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(book.buffer as unknown as ExcelJS.Buffer);
assert.equal(workbook.worksheets.length, 2); const sheet = workbook.getWorksheet("الميزانية")!;
assert.equal(sheet.getCell("B2").value, 12.5); assert.equal(sheet.getCell("B4").formula, "SUM(B2:B3)");
assert.equal(sheet.getCell("B5").value, "00123"); assert.equal(sheet.getCell("B6").value, "12345678901234567");
assert.equal(sheet.views[0]!.rightToLeft, true);
for (const kind of ["document", "presentation", "spreadsheet"] as const) {
  const content = kind === "document" ? { blocks: [] } : kind === "presentation" ? { slides: [] } : { sheets: [] };
  const result = await exportStudio({ kind, title: "CON", content, revision: 1 } as Parameters<typeof exportStudio>[0]);
  assert.ok(result.buffer.length > 100); assert.match(result.filename, /^Loam-CON\./);
}
console.log("PASS native studio exports: DOCX formatting/RTL, PPTX slides/notes/colors, XLSX formulas/types/sheets, filenames and empty documents");
