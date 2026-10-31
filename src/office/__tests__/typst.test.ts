import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileTypst, typstStatus } from "../typst.js";

describe("typst engine (blueprint §7.3)", () => {
  it("reports honest status from the fixed candidate paths", async () => {
    const status = await typstStatus();
    // The machine has the binary under tools/ (installed during this program).
    assert.equal(status.installed, true);
    assert.match(status.version ?? "", /^typst 0\./);
    assert.ok(status.path, "binary path reported");
  });

  it("compiles a minimal English document to a real PDF", async () => {
    const { pdf } = await compileTypst("= Hello Typst\nThis is a *test* document.");
    assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
    assert.ok(pdf.length > 500, "non-trivial PDF body");
  });

  it("compiles an Arabic RTL document", async () => {
    // Typst 0.15: `dir` is no longer a set-text/page field — setting lang: "ar"
    // flips the layout direction automatically (verified against the binary).
    const source = [
      '#set text(lang: "ar")',
      '= مذكرة قانونية',
      'هذه وثيقة تجريبية للتحقق من دعم العربية في محرك Typst.',
      '#pagebreak()',
      '= صفحة ثانية',
    ].join("\n");
    const { pdf } = await compileTypst(source);
    assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
    assert.ok(pdf.length > 1000, "Arabic PDF has real content");
  });

  it("rejects invalid markup with a typst error, not a crash", async () => {
    await assert.rejects(() => compileTypst("#this-function-does-not-exist()"), /typst|error|expected/i);
  });

  it("rejects empty and oversized sources", async () => {
    await assert.rejects(() => compileTypst("   "), /empty source/);
    const big = "x".repeat(2_100_000);
    await assert.rejects(() => compileTypst(big), /too large/);
  });
});
