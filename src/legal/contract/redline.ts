/**
 * DOCX redline with real Word tracked changes (w:ins / w:del), RTL-aware,
 * built with the `docx` package Loam already depends on (package.json
 * "docx": "^9.12.0"; InsertedTextRun/DeletedTextRun OBSERVED in docx 9.12.0
 * typings). Replaces the research's suggestion to call the Python
 * legal-redline-tools: same output, no Python runtime, no extra dependency.
 */
import { AlignmentType, DeletedTextRun, Document, Footer, Header, InsertedTextRun, Packer, PageNumber, Paragraph, TextRun } from "docx";
import { DRAFT_WATERMARK_AR } from "../review.js";
import type { Clause } from "../types.js";

export interface RedlineEdit { clauseId: string; newText: string }

export interface RedlineOptions {
  title: string;
  author: string;
  /** ISO timestamp recorded on every revision. */
  date: string;
  rtl: boolean;
  font?: string;
  /** false = approved final export (no watermark header). */
  draft: boolean;
}

export type DiffOp = { op: "eq" | "del" | "ins"; text: string };

/** Word-level diff (LCS) that keeps whitespace attached; falls back to replace-all above 1500 tokens. */
export function wordDiff(a: string, b: string): DiffOp[] {
  const ta = a.match(/\S+\s*|\s+/g) ?? [];
  const tb = b.match(/\S+\s*|\s+/g) ?? [];
  if (ta.length * tb.length > 1500 * 1500) return [{ op: "del", text: a }, { op: "ins", text: b }];
  const n = ta.length, m = tb.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!; const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) row[j] = ta[i] === tb[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
  }
  const ops: DiffOp[] = [];
  const push = (op: DiffOp["op"], text: string): void => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text; else ops.push({ op, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push("eq", ta[i]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push("del", ta[i]!); i++; }
    else { push("ins", tb[j]!); j++; }
  }
  while (i < n) push("del", ta[i++]!);
  while (j < m) push("ins", tb[j++]!);
  return ops;
}

export async function buildRedlineDocx(clauses: Clause[], edits: RedlineEdit[], opts: RedlineOptions): Promise<Buffer> {
  const font = opts.font ?? (opts.rtl ? "Sakkal Majalla" : "Calibri");
  const size = opts.rtl ? 28 : 24; // half-points: 14pt Arabic, 12pt English
  let revision = 1;
  const runOpts = { font, size, rightToLeft: opts.rtl };
  const byId = new Map(edits.map((e) => [e.clauseId, e.newText]));
  const paragraphs: Paragraph[] = [
    new Paragraph({ bidirectional: opts.rtl, alignment: AlignmentType.CENTER, children: [new TextRun({ ...runOpts, text: opts.title, bold: true, size: size + 4 })] }),
  ];
  for (const clause of clauses) {
    const newText = byId.get(clause.id);
    const lines = (clause.text.startsWith(clause.heading) ? clause.text.slice(clause.heading.length) : clause.text).trim();
    paragraphs.push(new Paragraph({ bidirectional: opts.rtl, spacing: { before: 240 }, children: [new TextRun({ ...runOpts, text: clause.heading, bold: true })] }));
    if (newText === undefined) {
      paragraphs.push(new Paragraph({ bidirectional: opts.rtl, children: [new TextRun({ ...runOpts, text: lines })] }));
      continue;
    }
    const children = wordDiff(lines, newText.trim()).map((d) => {
      if (d.op === "eq") return new TextRun({ ...runOpts, text: d.text });
      const rev = { id: revision++, author: opts.author, date: opts.date };
      return d.op === "ins" ? new InsertedTextRun({ ...runOpts, ...rev, text: d.text }) : new DeletedTextRun({ ...runOpts, ...rev, text: d.text });
    });
    paragraphs.push(new Paragraph({ bidirectional: opts.rtl, children }));
  }
  const doc = new Document({
    creator: opts.author,
    title: opts.title,
    sections: [{
      properties: { page: { margin: { top: 1418, bottom: 1418, left: 1418, right: 1418 } } }, // 2.5 cm
      headers: opts.draft ? { default: new Header({ children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.CENTER, children: [new TextRun({ font, size: 20, text: DRAFT_WATERMARK_AR, rightToLeft: true, color: "B00020" })] })] }) } : {},
      footers: { default: new Footer({ children: [new Paragraph({ bidirectional: opts.rtl, alignment: AlignmentType.CENTER, children: [
        new TextRun({ ...runOpts, size: 18, children: [opts.rtl ? "صفحة " : "Page ", PageNumber.CURRENT, opts.rtl ? " من " : " of ", PageNumber.TOTAL_PAGES] }),
      ] })] }) },
      children: paragraphs,
    }],
  });
  return Packer.toBuffer(doc);
}
