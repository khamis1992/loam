import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright";
import { test } from "node:test";
import { localLegalOcr, closeLegalOcr } from "../evidence/ocr.js";
import { rasterizePdfPage } from "../evidence/pdfRaster.js";

function simplePdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test("local OCR and PDF rasterization work without network", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-pdf-"));
  try {
    const image = await sharp(Buffer.from("<svg width=\"900\" height=\"300\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><text x=\"40\" y=\"100\" font-size=\"72\" fill=\"black\">Contract</text><text x=\"40\" y=\"220\" font-size=\"72\" fill=\"black\">123456789</text></svg>")).png().toBuffer();
    const result = await localLegalOcr.recognize(image, "image/png");
    assert.match(result.text, /Contract/);
    assert.match(result.text, /123456789/);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 250 } });
    await page.setContent('<html><body style="background:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Arial;font-size:72px">هذا عقد قانوني</body></html>');
    const arabicImage = await page.screenshot({ type: "png" });
    await browser.close();
    assert.match((await localLegalOcr.recognize(arabicImage, "image/png")).text, /هذا عقد قانوني/);
    const file = path.join(dir, "simple.pdf");
    fs.writeFileSync(file, simplePdf("Contract 123"));
    const raster = await rasterizePdfPage(file, 1);
    assert.ok(raster.length > 1000);
    const ocrDir = path.resolve("resources/legal/ocr");
    assert.ok(fs.existsSync(path.join(ocrDir, "ara.traineddata")));
    assert.ok(fs.existsSync(path.join(ocrDir, "eng.traineddata")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await closeLegalOcr();
  }
});
