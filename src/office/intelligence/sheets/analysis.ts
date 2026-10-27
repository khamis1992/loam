import type { StudioArtifact } from "../../../studio/store.js";
import { columnLetters, type OfficeEditOp } from "../../../tools/officeEditAgent.js";

type SpreadsheetArtifact = Extract<StudioArtifact, { kind: "spreadsheet" }>;

export interface NumericPoint {
  sheet: string;
  row: number;
  column: number;
  address: string;
  value: number;
}

export function numericValue(text: string): number | undefined {
  const normalized = text.trim()
    .replace(/[٠-٩]/gu, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/gu, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/٫/gu, ".")
    .replace(/(?<=\d)[,،](?=\d{3}\b)/gu, "");
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/u.test(normalized)) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

export function numericColumns(artifact: SpreadsheetArtifact): Array<{ sheet: string; column: number; label: string; points: NumericPoint[] }> {
  const out: Array<{ sheet: string; column: number; label: string; points: NumericPoint[] }> = [];
  for (const sheet of artifact.content.sheets) {
    const width = sheet.cells.reduce((max, row) => Math.max(max, row.length), 0);
    for (let c = 0; c < width; c++) {
      const points: NumericPoint[] = [];
      sheet.cells.forEach((row, r) => {
        const value = numericValue(row[c] ?? "");
        if (value !== undefined) points.push({ sheet: sheet.name, row: r + 1, column: c + 1, address: `${sheet.name}!${columnLetters(c + 1)}${r + 1}`, value });
      });
      if (points.length >= 2) {
        const firstText = sheet.cells[0]?.[c]?.trim();
        out.push({ sheet: sheet.name, column: c + 1, label: firstText && numericValue(firstText) === undefined ? firstText : columnLetters(c + 1), points });
      }
    }
  }
  return out;
}

export function analyzeSpreadsheet(artifact: SpreadsheetArtifact): {
  sheets: number;
  formulas: number;
  errors: number;
  numericColumns: Array<{ sheet: string; column: string; label: string; count: number; sum: number; mean: number; min: number; max: number }>;
} {
  let formulas = 0;
  let errors = 0;
  for (const sheet of artifact.content.sheets) {
    for (const row of sheet.cells) for (const cell of row) {
      if (cell.startsWith("=")) formulas++;
      if (/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A)/iu.test(cell)) errors++;
    }
  }
  return {
    sheets: artifact.content.sheets.length,
    formulas,
    errors,
    numericColumns: numericColumns(artifact).map((column) => {
      const values = column.points.map((point) => point.value);
      const sum = values.reduce((total, value) => total + value, 0);
      return {
        sheet: column.sheet,
        column: columnLetters(column.column),
        label: column.label,
        count: values.length,
        sum,
        mean: sum / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
      };
    }),
  };
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[lower + 1]! - sorted[lower]!) * fraction;
}

export function detectSpreadsheetAnomalies(artifact: SpreadsheetArtifact): Array<{ address: string; value: number; lower: number; upper: number; reason: string }> {
  return numericColumns(artifact).flatMap((column) => {
    if (column.points.length < 4) return [];
    const values = column.points.map((point) => point.value).sort((a, b) => a - b);
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const spread = q3 - q1;
    if (spread === 0) return [];
    const lower = q1 - 1.5 * spread;
    const upper = q3 + 1.5 * spread;
    return column.points.filter((point) => point.value < lower || point.value > upper).map((point) => ({
      address: point.address,
      value: point.value,
      lower,
      upper,
      reason: `القيمة خارج النطاق الربيعي المتوقع للعمود ${column.label}`,
    }));
  });
}

export function createSpreadsheetCleaningPlan(artifact: SpreadsheetArtifact): { ops: OfficeEditOp[]; duplicates: string[]; normalizedDates: number; trimmedCells: number } {
  const ops: OfficeEditOp[] = [];
  const duplicates: string[] = [];
  let normalizedDates = 0;
  let trimmedCells = 0;
  for (const sheet of artifact.content.sheets) {
    const rows = new Map<string, number>();
    sheet.cells.forEach((row, r) => {
      const signature = JSON.stringify(row.map((cell) => cell.trim()));
      if (signature !== JSON.stringify([]) && row.some((cell) => cell.trim())) {
        const previous = rows.get(signature);
        if (previous !== undefined) duplicates.push(`${sheet.name}!${r + 1} duplicates row ${previous}`);
        else rows.set(signature, r + 1);
      }
      row.forEach((cell, c) => {
        if (!cell || cell.startsWith("=")) return;
        let next = cell;
        if (next !== next.trim()) {
          next = next.trim();
          trimmedCells++;
        }
        const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(next);
        if (date) {
          const candidate = `${date[3]}-${date[2]!.padStart(2, "0")}-${date[1]!.padStart(2, "0")}`;
          const parsed = new Date(`${candidate}T00:00:00Z`);
          if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
            next = candidate;
            normalizedDates++;
          }
        }
        if (next !== cell && ops.length < 100) ops.push({ op: "set-cell", sheet: sheet.name, address: `${columnLetters(c + 1)}${r + 1}`, value: next });
      });
    });
  }
  return { ops, duplicates, normalizedDates, trimmedCells };
}

export function forecastNumericSeries(values: number[], periods = 3): {
  method: "linear-regression";
  forecasts: Array<{ period: number; value: number; lower: number; upper: number }>;
  mae: number;
  assumptions: string[];
} {
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) throw new Error("at least four finite numeric observations are required");
  if (!Number.isSafeInteger(periods) || periods < 1 || periods > 24) throw new Error("forecast periods must be between 1 and 24");
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  const residuals = values.map((value, index) => value - (intercept + slope * index));
  const mae = residuals.reduce((sum, value) => sum + Math.abs(value), 0) / n;
  const deviation = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, n - 2));
  return {
    method: "linear-regression",
    forecasts: Array.from({ length: periods }, (_, index) => {
      const period = n + index + 1;
      const value = intercept + slope * (period - 1);
      const margin = 1.96 * deviation * Math.sqrt(1 + 1 / n + ((period - 1 - meanX) ** 2) / (denominator || 1));
      return { period, value, lower: value - margin, upper: value + margin };
    }),
    mae,
    assumptions: ["العلاقة الزمنية خطية", "لا توجد تغيرات هيكلية مستقبلية", "فترات الثقة إرشادية وليست ضمانًا"],
  };
}

export function explainFormula(formula: string): string {
  const value = formula.trim();
  if (!value.startsWith("=") || value.length < 2) return "الخلية لا تحتوي صيغة.";
  const sum = /^=SUM\(([A-Z]+\d+):([A-Z]+\d+)\)$/iu.exec(value);
  if (sum) return `يجمع القيم في النطاق ${sum[1]}:${sum[2]}.`;
  const average = /^=AVERAGE\(([A-Z]+\d+):([A-Z]+\d+)\)$/iu.exec(value);
  if (average) return `يحسب المتوسط الحسابي للقيم الرقمية في النطاق ${average[1]}:${average[2]}.`;
  if (/^=[A-Z]+\d+(?:[+\-*/][A-Z]+\d+)+$/iu.test(value)) return `ينفذ عملية حسابية بين الخلايا المشار إليها في ${value.slice(1)}.`;
  if (/#REF!/iu.test(value)) return "الصيغة تحتوي مرجعًا غير صالح #REF! ويجب تصحيحه قبل الاعتماد عليها.";
  return "صيغة مخصصة؛ راجع المراجع والدوال والنطاقات قبل الاعتماد. لا يفسرها المحلل الحتمي الحالي تفصيليًا.";
}
