/**
 * Pure spreadsheet formula engine for the basic sheet editor.
 *
 * Parses and evaluates a practical Excel-like grammar (numbers, strings,
 * booleans, unary minus, arithmetic / text / comparison operators, cell refs,
 * ranges, cross-sheet refs and ~70 functions), recalculates a whole cell grid
 * dependency-aware (cycles surface as #CIRC!), and formats computed values as
 * display text.
 *
 * The module has no imports and performs no I/O. It is deterministic except
 * TODAY()/NOW(), which read `ctx.now` (default: the current time).
 *
 * Deliberate limits: expressions are capped at 2000 characters, 5000 evaluated
 * nodes and a parse depth of 64; formula-to-formula dependency chains are
 * capped at 256 hops. Each breach evaluates to #VALUE!.
 */

/** A computed scalar: text, number, boolean, or null for a blank cell. */
export type CellValue = string | number | boolean | null;

/** Evaluation context: where the formula lives, the workbook around it and the clock. */
export interface EvaluateContext {
  /** Name of the sheet the formula lives on; bare refs (A1) resolve here. */
  sheet?: string;
  /** All sheets by name (resolved case-insensitively): row-major cell text grids. */
  sheets?: Record<string, string[][]>;
  /** Reference time in ms since the epoch for TODAY()/NOW(); defaults to now. */
  now?: number;
  /** Address of the cell the formula lives in (1-based) for COLUMN()/ROW(). */
  cell?: { row: number; column: number };
}

/** Result of one formula: a value XOR an Excel-style error code. */
export interface FormulaResult {
  value: CellValue;
  error: string | null;
}

/** Whole-grid recalculation: display-ready values (errors embedded as "#CODE!" text) plus a diagnostic list. */
export interface RecalcResult {
  values: CellValue[][];
  errors: string[];
}

export const FORMULA_MAX_LENGTH = 2000;
export const FORMULA_MAX_NODES = 5000;
export const FORMULA_MAX_DEPTH = 64;
/** Maximum formula-to-formula dependency hops (a chain longer than this evaluates to #VALUE!). */
export const FORMULA_MAX_CHAIN = 256;
const MAX_TEXT_LENGTH = 32767;
const DAY_MS = 86400000;
/** 1970-01-01 is Excel serial 25569; serials below 61 shift by one for Excel's fake 1900-02-29. */
const SERIAL_UNIX_OFFSET = 25569;

const ERROR_CODES = new Set(["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#CIRC!"]);
const NUMERIC_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const COERCIBLE_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const CELL_REF_TEXT = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const COMPARE_OPS = ["=", "<>", "<", ">", "<=", ">="];

/** True when a computed string is one of the engine's Excel-style error codes. */
export function isFormulaErrorText(text: string): boolean {
  return ERROR_CODES.has(text.trim().toUpperCase());
}

/** Format a computed value as display text: blank -> "", booleans as TRUE/FALSE, numbers without float noise. */
export function formatFormulaValue(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return numberToText(v);
  return v;
}

class FormulaError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new FormulaError(code);
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "word"; v: string }
  | { t: "qsheet"; v: string }
  | { t: "op"; v: string }
  | { t: "punc"; v: "(" | ")" | "," | "!" | ":" };

const TWO_CHAR_OPS = ["<=", ">=", "<>"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\s+/.exec(rest))) {
      i += m[0].length;
      continue;
    }
    if ((m = /^"((?:[^"]|"")*)"/.exec(rest))) {
      tokens.push({ t: "str", v: m[1]!.replace(/""/g, '"') });
      i += m[0].length;
      continue;
    }
    if ((m = /^'((?:[^']|'')*)'/.exec(rest))) {
      tokens.push({ t: "qsheet", v: m[1]!.replace(/''/g, "'") });
      i += m[0].length;
      continue;
    }
    if ((m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))) {
      const n = Number(m[0]);
      if (!Number.isFinite(n)) fail("#VALUE!");
      tokens.push({ t: "num", v: n });
      i += m[0].length;
      continue;
    }
    if ((m = /^[A-Za-z_.$][A-Za-z0-9_.$]*/.exec(rest))) {
      tokens.push({ t: "word", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = TWO_CHAR_OPS.find((op) => rest.startsWith(op));
    if (two) {
      tokens.push({ t: "op", v: two });
      i += two.length;
      continue;
    }
    if ((m = /^[+\-*/^&=<>(),:!]/.exec(rest))) {
      const v = m[0];
      tokens.push("(),:!".includes(v) ? { t: "punc", v: v as "(" | ")" | "," | "!" | ":" } : { t: "op", v });
      i += v.length;
      continue;
    }
    fail("#VALUE!");
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent; Excel precedence: comparisons < & < +- < */ < ^ < unary-)
// ---------------------------------------------------------------------------

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "missing" }
  | { k: "cell"; sheet?: string; row: number; col: number }
  | { k: "range"; sheet?: string; r1: number; c1: number; r2: number; c2: number }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

function columnName(col: number): string {
  let label = "";
  let c = col;
  while (c) {
    c--;
    label = String.fromCharCode(65 + (c % 26)) + label;
    c = Math.floor(c / 26);
  }
  return label;
}

function colNameToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function cellRefParts(word: string): { row: number; col: number } | null {
  const m = CELL_REF_TEXT.exec(word);
  if (!m) return null;
  const row = Number(m[2]!);
  if (!Number.isInteger(row) || row < 1) fail("#VALUE!");
  return { row, col: colNameToIndex(m[1]!) };
}

class Parser {
  private pos = 0;
  /** Nesting depth: parentheses, function-argument expressions and unary sign chains. */
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.comparison();
    if (this.pos !== this.tokens.length) fail("#VALUE!");
    return node;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && t.v === v;
  }
  private isPunc(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "punc" && t.v === v;
  }
  private takePunc(v: string): void {
    if (!this.isPunc(v)) fail("#VALUE!");
    this.pos++;
  }
  private nest(): void {
    if (++this.depth > FORMULA_MAX_DEPTH) fail("#VALUE!");
  }

  private comparison(): Node {
    let left = this.concat();
    for (;;) {
      const t = this.peek();
      const op = t && t.t === "op" && COMPARE_OPS.includes(t.v) ? t.v : null;
      if (!op) break;
      this.pos++;
      left = { k: "bin", op, a: left, b: this.concat() };
    }
    return left;
  }

  private concat(): Node {
    let left = this.additive();
    while (this.isOp("&")) {
      this.pos++;
      left = { k: "bin", op: "&", a: left, b: this.additive() };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (;;) {
      let op: string | null = null;
      if (this.isOp("+")) op = "+";
      else if (this.isOp("-")) op = "-";
      if (!op) break;
      this.pos++;
      left = { k: "bin", op, a: left, b: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.power();
    for (;;) {
      let op: string | null = null;
      if (this.isOp("*")) op = "*";
      else if (this.isOp("/")) op = "/";
      if (!op) break;
      this.pos++;
      left = { k: "bin", op, a: left, b: this.power() };
    }
    return left;
  }

  /** Excel's ^ is left-associative and binds looser than unary minus: -2^2 = 4. */
  private power(): Node {
    let left = this.unary();
    while (this.isOp("^")) {
      this.pos++;
      left = { k: "bin", op: "^", a: left, b: this.unary() };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp("-") || this.isOp("+")) {
      const negative = this.isOp("-");
      this.pos++;
      this.nest();
      try {
        const operand = this.unary();
        return negative ? { k: "neg", a: operand } : operand;
      } finally {
        this.depth--;
      }
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.next();
    if (!t) return fail("#VALUE!");
    if (t.t === "num") return { k: "num", v: t.v as number };
    if (t.t === "str") return { k: "str", v: t.v as string };
    if (t.t === "punc" && t.v === "(") {
      this.nest();
      try {
        const inner = this.comparison();
        this.takePunc(")");
        return inner;
      } finally {
        this.depth--;
      }
    }
    if (t.t === "qsheet") return this.sheetRef(t.v);
    if (t.t === "word") {
      const upper = t.v.toUpperCase();
      if (this.isPunc("(")) return this.call(upper);
      if (this.isPunc("!")) return this.sheetRef(t.v);
      if (upper === "TRUE") return { k: "bool", v: true };
      if (upper === "FALSE") return { k: "bool", v: false };
      const ref = cellRefParts(t.v);
      if (ref) return this.maybeRange(undefined, ref.row, ref.col);
      return fail("#NAME?");
    }
    return fail("#VALUE!");
  }

  private call(name: string): Node {
    this.takePunc("(");
    const args: Node[] = [];
    if (this.isPunc(")")) {
      this.pos++;
      return { k: "call", name, args };
    }
    this.nest();
    try {
      for (;;) {
        // An omitted argument (IF(A1,,2)) evaluates to a blank.
        args.push(this.isPunc(",") || this.isPunc(")") ? { k: "missing" } : this.comparison());
        if (this.isPunc(",")) {
          this.pos++;
          continue;
        }
        this.takePunc(")");
        break;
      }
    } finally {
      this.depth--;
    }
    return { k: "call", name, args };
  }

  /** `Sheet1!A1`, `'Sheet name'!A1:B3`; the leading `!` is still unread. */
  private sheetRef(sheet: string): Node {
    this.takePunc("!");
    const t = this.next();
    if (!t || t.t !== "word") return fail("#REF!");
    const ref = cellRefParts(t.v as string);
    if (!ref) return fail("#REF!");
    return this.maybeRange(sheet, ref.row, ref.col);
  }

  private maybeRange(sheet: string | undefined, row: number, col: number): Node {
    if (this.isPunc(":")) {
      const after = this.peek(1);
      if (after && after.t === "word") {
        const ref2 = cellRefParts(after.v);
        if (ref2) {
          this.pos += 2;
          return {
            k: "range",
            sheet,
            r1: Math.min(row, ref2.row),
            c1: Math.min(col, ref2.col),
            r2: Math.max(row, ref2.row),
            c2: Math.max(col, ref2.col),
          };
        }
      }
      fail("#VALUE!");
    }
    return { k: "cell", sheet, row, col };
  }
}

// ---------------------------------------------------------------------------
// Value coercion (Excel-flavoured)
// ---------------------------------------------------------------------------

function numberToText(n: number): string {
  if (!Number.isFinite(n)) return "#VALUE!";
  if (Object.is(n, -0)) return "0";
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(Number(n.toPrecision(15)));
}

function serialFromMs(ms: number): number {
  const whole = Math.floor(ms / DAY_MS) + SERIAL_UNIX_OFFSET;
  return whole < 61 ? whole - 1 : whole;
}
function msFromSerial(serial: number): number {
  const whole = Math.floor(serial);
  return ((whole < 60 ? whole + 1 : whole) - SERIAL_UNIX_OFFSET) * DAY_MS;
}

/** Excel serial numbers use UTC calendar days. */
function serialFromDateUTC(y: number, m: number, d: number): number {
  const ms = Date.UTC(y, m - 1, d);
  return serialFromMs(ms);
}

function toNumber(v: CellValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return 0;
  const s = v.trim();
  if (s === "") fail("#VALUE!");
  if (COERCIBLE_TEXT.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (ISO_DATE_TEXT.test(v)) {
    const t = Date.parse(v + "T00:00:00Z");
    if (Number.isFinite(t)) return serialFromMs(t);
  }
  return fail("#VALUE!");
}

function toBool(v: CellValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null) return false;
  const s = v.trim().toUpperCase();
  if (s === "TRUE") return true;
  if (s === "FALSE") return false;
  return fail("#VALUE!");
}

function toText(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return numberToText(v);
  return v;
}

/** Excel type ranking for comparisons: numbers < text < booleans. */
function rankOf(v: string | number | boolean): number {
  return typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
}

function compareValues(left: CellValue, right: CellValue): number {
  let a = left;
  let b = right;
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const ra = rankOf(a as string | number | boolean);
  const rb = rankOf(b as string | number | boolean);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toUpperCase();
    const y = b.toUpperCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const x = a as boolean;
  const y = b as boolean;
  return x === y ? 0 : x ? 1 : -1;
}

/** Round half away from zero at `digits` decimal places (Excel display rounding). */
function roundHalfAway(v: number, digits: number): number {
  const p = 10 ** digits;
  const scaled = v * p;
  // Nudge by a few ULPs so values like 2.345 (stored as 2.34499…) still round up.
  const nudged = scaled + Math.sign(scaled) * Math.abs(scaled) * Number.EPSILON * 4;
  const r = nudged < 0 ? -Math.round(-nudged) : Math.round(nudged);
  return r / p;
}
/** Nudge away binary noise so ceil/floor land on the visually expected step. */
function snap(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-9 ? r : v;
}

// ---------------------------------------------------------------------------
// Evaluation engine (memoized cell resolver with cycle detection)
// ---------------------------------------------------------------------------

type ArgValue = { kind: "value"; value: CellValue } | { kind: "range"; grid: CellValue[][] };

interface Engine {
  currentSheet: string;
  sheets: Record<string, string[][]>;
  now: number;
  cell: { row: number; column: number } | undefined;
  cache: Map<string, FormulaResult>;
  visiting: Set<string>;
  chainDepth: number;
}

function createEngine(ctx: EvaluateContext, currentCells?: string[][]): Engine {
  const sheets: Record<string, string[][]> = {};
  for (const [name, grid] of Object.entries(ctx.sheets ?? {})) sheets[name.toLowerCase()] = grid;
  const current = (ctx.sheet ?? "").toLowerCase();
  if (currentCells) sheets[current] = currentCells;
  return {
    currentSheet: current,
    sheets,
    now: ctx.now ?? Date.now(),
    cell: ctx.cell,
    cache: new Map(),
    visiting: new Set(),
    chainDepth: 0,
  };
}

/** Non-formula cell text -> typed value (mirrors the typed studio cell model). */
function literalCell(text: string): FormulaResult {
  if (text === "") return { value: null, error: null };
  const upper = text.trim().toUpperCase();
  if (ERROR_CODES.has(upper)) return { value: null, error: upper };
  if (upper === "TRUE") return { value: true, error: null };
  if (upper === "FALSE") return { value: false, error: null };
  if (NUMERIC_TEXT.test(text)) return { value: Number(text), error: null };
  return { value: text, error: null };
}

function computeCell(engine: Engine, sheetKey: string, row: number, col: number): FormulaResult {
  const grid = engine.sheets[sheetKey];
  if (!grid) {
    // A bare ref on a sheet with no grid reads as blank; a named sheet that
    // does not exist in the workbook is a broken reference.
    if (sheetKey === engine.currentSheet) return { value: null, error: null };
    return { value: null, error: "#REF!" };
  }
  const text = grid[row - 1]?.[col - 1];
  if (text === undefined) return { value: null, error: null };
  if (!(text.startsWith("=") && text.length > 1)) return literalCell(text);

  const key = `${sheetKey}!${row}:${col}`;
  const cached = engine.cache.get(key);
  if (cached) return cached;
  if (engine.visiting.has(key)) return { value: null, error: "#CIRC!" };
  if (engine.chainDepth >= FORMULA_MAX_CHAIN) return { value: null, error: "#VALUE!" };

  engine.chainDepth++;
  engine.visiting.add(key);
  const previousCell = engine.cell;
  engine.cell = { row, column: col };
  let result: FormulaResult;
  try {
    result = evaluateFormula(engine, text);
  } finally {
    engine.cell = previousCell;
    engine.visiting.delete(key);
    engine.chainDepth--;
  }
  engine.cache.set(key, result);
  return result;
}

function resolveCell(engine: Engine, sheetKey: string, row: number, col: number): CellValue {
  const result = computeCell(engine, sheetKey, row, col);
  if (result.error) throw new FormulaError(result.error);
  return result.value;
}

function evaluateFormula(engine: Engine, input: string): FormulaResult {
  if (input.length > FORMULA_MAX_LENGTH) return { value: null, error: "#VALUE!" };
  const text = input.startsWith("=") ? input.slice(1) : input;
  if (text === "") return { value: null, error: null };
  try {
    const ast = new Parser(tokenize(text)).parse();
    const budget = { n: 0 };
    const out = evalNode(engine, ast, budget);
    const value = out.kind === "range" ? (out.grid[0]?.[0] ?? null) : out.value;
    if (typeof value === "number" && !Number.isFinite(value)) return { value: null, error: "#VALUE!" };
    return { value, error: null };
  } catch (e) {
    if (e instanceof FormulaError) return { value: null, error: e.code };
    if (e instanceof RangeError) return { value: null, error: "#VALUE!" };
    throw e;
  }
}

/** Evaluate one formula against a workbook context. `input` may keep or omit the leading "=". */
export function evaluateSheetFormula(input: string, ctx: EvaluateContext = {}): FormulaResult {
  if (typeof input !== "string" || input === "") return { value: null, error: null };
  return evaluateFormula(createEngine(ctx), input);
}

function scalarOf(v: ArgValue): CellValue {
  return v.kind === "value" ? v.value : (v.grid[0]?.[0] ?? null);
}
function asGrid(v: ArgValue): CellValue[][] {
  return v.kind === "range" ? v.grid : [[v.value]];
}
function numericResult(n: number): ArgValue {
  if (!Number.isFinite(n)) fail("#VALUE!");
  return { kind: "value", value: n };
}

function evalNode(engine: Engine, node: Node, budget: { n: number }): ArgValue {
  if (++budget.n > FORMULA_MAX_NODES) fail("#VALUE!");
  switch (node.k) {
    case "num":
      return { kind: "value", value: node.v };
    case "str":
      return { kind: "value", value: node.v };
    case "bool":
      return { kind: "value", value: node.v };
    case "missing":
      return { kind: "value", value: null };
    case "cell":
      return { kind: "value", value: resolveCell(engine, node.sheet?.toLowerCase() ?? engine.currentSheet, node.row, node.col) };
    case "range": {
      const key = node.sheet?.toLowerCase() ?? engine.currentSheet;
      const grid: CellValue[][] = [];
      for (let r = node.r1; r <= node.r2; r++) {
        const row: CellValue[] = [];
        for (let c = node.c1; c <= node.c2; c++) row.push(resolveCell(engine, key, r, c));
        grid.push(row);
      }
      return { kind: "range", grid };
    }
    case "neg":
      return numericResult(-toNumber(scalarOf(evalNode(engine, node.a, budget))));
    case "bin": {
      if (COMPARE_OPS.includes(node.op)) {
        const a = scalarOf(evalNode(engine, node.a, budget));
        const b = scalarOf(evalNode(engine, node.b, budget));
        const cmp = compareValues(a, b);
        const result =
          node.op === "=" ? cmp === 0 : node.op === "<>" ? cmp !== 0 : node.op === "<" ? cmp < 0 : node.op === ">" ? cmp > 0 : node.op === "<=" ? cmp <= 0 : cmp >= 0;
        return { kind: "value", value: result };
      }
      if (node.op === "&") {
        const a = toText(scalarOf(evalNode(engine, node.a, budget)));
        const b = toText(scalarOf(evalNode(engine, node.b, budget)));
        if (a.length + b.length > MAX_TEXT_LENGTH) fail("#VALUE!");
        return { kind: "value", value: a + b };
      }
      const a = toNumber(scalarOf(evalNode(engine, node.a, budget)));
      const b = toNumber(scalarOf(evalNode(engine, node.b, budget)));
      switch (node.op) {
        case "+":
          return numericResult(a + b);
        case "-":
          return numericResult(a - b);
        case "*":
          return numericResult(a * b);
        case "/":
          if (b === 0) fail("#DIV/0!");
          return numericResult(a / b);
        case "^": {
          if (a === 0 && b === 0) fail("#VALUE!");
          return numericResult(a ** b);
        }
        default:
          return fail("#VALUE!");
      }
    }
    case "call":
      return { kind: "value", value: evalCall(engine, node, budget) };
  }
}

// ---------------------------------------------------------------------------
// Function library
// ---------------------------------------------------------------------------

type Fn = (args: ArgValue[], engine: Engine) => CellValue;

function evalCall(engine: Engine, node: Extract<Node, { k: "call" }>, budget: { n: number }): CellValue {
  const name = node.name;
  // Lazy / reference-aware special forms.
  if (name === "IF") {
    if (node.args.length < 2) fail("#VALUE!");
    const cond = toBool(scalarOf(evalNode(engine, node.args[0]!, budget)));
    if (cond) return scalarOf(evalNode(engine, node.args[1]!, budget));
    const alt = node.args[2];
    return alt ? scalarOf(evalNode(engine, alt, budget)) : false;
  }
  if (name === "IFERROR") {
    if (node.args.length < 2) fail("#VALUE!");
    try {
      return scalarOf(evalNode(engine, node.args[0]!, budget));
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      return scalarOf(evalNode(engine, node.args[1]!, budget));
    }
  }
  if (name === "ISERROR") {
    if (node.args.length !== 1) fail("#VALUE!");
    try {
      evalNode(engine, node.args[0]!, budget);
      return false;
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      return true;
    }
  }
  if (name === "COLUMN" || name === "ROW") {
    if (node.args.length > 1) fail("#VALUE!");
    if (node.args.length === 0) {
      if (!engine.cell) return fail("#VALUE!");
      return name === "COLUMN" ? engine.cell.column : engine.cell.row;
    }
    const arg = node.args[0]!;
    if (arg.k === "cell") return name === "COLUMN" ? arg.col : arg.row;
    if (arg.k === "range") return name === "COLUMN" ? arg.c1 : arg.r1;
    fail("#VALUE!");
  }

  const fn = FUNCTIONS[name];
  if (!fn) return fail("#NAME?");
  const args = node.args.map((a) => evalNode(engine, a, budget));
  const value = fn(args, engine);
  if (typeof value === "number" && !Number.isFinite(value)) fail("#VALUE!");
  return value;
}

const value = (args: ArgValue[], i: number): CellValue => scalarOf(args[i] ?? { kind: "value", value: null });
const number1 = (args: ArgValue[], i: number): number => toNumber(value(args, i));

/** Collect numbers Excel-style: ranges contribute only real numbers, direct scalars coerce. */
function collectNumbers(args: ArgValue[]): number[] {
  const out: number[] = [];
  const push = (v: CellValue, direct: boolean): void => {
    if (typeof v === "number") out.push(v);
    else if (typeof v === "boolean") {
      if (direct) out.push(v ? 1 : 0);
    } else if (typeof v === "string") {
      if (direct && COERCIBLE_TEXT.test(v.trim())) out.push(Number(v.trim()));
    } // blanks never contribute
  };
  for (const arg of args) {
    if (arg.kind === "range") {
      for (const row of arg.grid) for (const v of row) push(v, false);
    } else push(arg.value, true);
  }
  return out;
}

const sum = (n: number[]): number => n.reduce((a, b) => a + b, 0);

function variance(nums: number[], sample: boolean): number {
  if (nums.length < (sample ? 2 : 1)) fail("#DIV/0!");
  const mean = sum(nums) / nums.length;
  return nums.reduce((s, x) => s + (x - mean) ** 2, 0) / (nums.length - (sample ? 1 : 0));
}

function makeCriteria(crit: CellValue): (v: CellValue) => boolean {
  if (typeof crit === "string") {
    const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(crit);
    if (m) {
      const op = m[1]!;
      const rest = m[2]!.trim();
      const target: CellValue = rest === "" ? null : COERCIBLE_TEXT.test(rest) ? Number(rest) : rest;
      return (v) => {
        if (target === null) {
          if (op === "=") return v === null || v === "";
          if (op === "<>") return v !== null && v !== "";
          return false;
        }
        if (v === null) return op === "<>";
        const cmp = compareValues(v, target);
        return op === "=" ? cmp === 0 : op === "<>" ? cmp !== 0 : op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
      };
    }
    const needle = crit.trim().toUpperCase();
    return (v) => (typeof v === "string" ? v.trim().toUpperCase() === needle : typeof v === "number" && COERCIBLE_TEXT.test(crit.trim()) ? v === Number(crit.trim()) : false);
  }
  if (typeof crit === "number") return (v) => typeof v === "number" && v === crit;
  if (typeof crit === "boolean") return (v) => typeof v === "boolean" && v === crit;
  return (v) => v === null;
}

function lookupCompare(lookup: CellValue, candidate: CellValue): number {
  return compareValues(candidate, lookup);
}

/** Iterate criteria/sum pairs over a range pair; `visit` receives matching numeric targets. */
function criteriaPairs(args: ArgValue[], visit: (v: CellValue) => void): void {
  const grid = asGrid(args[0] ?? { kind: "value", value: null });
  const targets = args[2] ? asGrid(args[2]) : grid;
  const match = makeCriteria(value(args, 1));
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r]?.length ?? 0); c++) {
      if (!match(grid[r]![c] ?? null)) continue;
      visit(targets[r]?.[c] ?? null);
    }
  }
}

const FUNCTIONS: Record<string, Fn> = {
  // --- aggregates ---
  SUM: (a) => sum(collectNumbers(a)),
  PRODUCT: (a) => collectNumbers(a).reduce((x, y) => x * y, 1),
  AVERAGE: (a) => {
    const n = collectNumbers(a);
    return n.length ? sum(n) / n.length : fail("#DIV/0!");
  },
  MIN: (a) => {
    const n = collectNumbers(a);
    return n.length ? n.reduce((x, y) => (y < x ? y : x)) : 0;
  },
  MAX: (a) => {
    const n = collectNumbers(a);
    return n.length ? n.reduce((x, y) => (y > x ? y : x)) : 0;
  },
  COUNT: (a) => {
    let count = 0;
    for (const arg of a) {
      if (arg.kind === "range") {
        for (const row of arg.grid) for (const v of row) if (typeof v === "number") count++;
      } else if (typeof arg.value === "number" || typeof arg.value === "boolean") count++;
      else if (typeof arg.value === "string" && COERCIBLE_TEXT.test(arg.value.trim())) count++;
    }
    return count;
  },
  COUNTA: (a) => {
    let count = 0;
    for (const arg of a) {
      if (arg.kind === "range") {
        for (const row of arg.grid) for (const v of row) if (v !== null) count++;
      } else if (arg.value !== null) count++;
    }
    return count;
  },
  COUNTBLANK: (a) => {
    let count = 0;
    for (const row of asGrid(a[0] ?? { kind: "value", value: null })) for (const v of row) if (v === null) count++;
    return count;
  },

  // --- math ---
  ABS: (a) => Math.abs(number1(a, 0)),
  SQRT: (a) => {
    const v = number1(a, 0);
    return v < 0 ? fail("#VALUE!") : Math.sqrt(v);
  },
  POWER: (a) => {
    const base = number1(a, 0);
    const exp = number1(a, 1);
    if (base === 0 && exp === 0) fail("#VALUE!");
    const r = base ** exp;
    if (!Number.isFinite(r)) fail("#VALUE!");
    return r;
  },
  MOD: (a) => {
    const x = number1(a, 0);
    const y = number1(a, 1);
    if (y === 0) fail("#DIV/0!");
    return x - y * Math.floor(x / y);
  },
  INT: (a) => Math.floor(number1(a, 0)),
  CEILING: (a) => {
    const x = number1(a, 0);
    const sig = a.length > 1 ? number1(a, 1) : 1;
    if (sig === 0) return 0;
    return sig * Math.ceil(snap(x / sig));
  },
  FLOOR: (a) => {
    const x = number1(a, 0);
    const sig = a.length > 1 ? number1(a, 1) : 1;
    if (sig === 0) return 0;
    return sig * Math.floor(snap(x / sig));
  },
  ROUND: (a) => roundHalfAway(number1(a, 0), a.length > 1 ? Math.trunc(number1(a, 1)) : 0),
  ROUNDUP: (a) => {
    const p = 10 ** (a.length > 1 ? Math.trunc(number1(a, 1)) : 0);
    const x = Math.abs(number1(a, 0));
    return (Math.ceil(snap(x * p)) / p) * (number1(a, 0) < 0 ? -1 : 1);
  },
  ROUNDDOWN: (a) => {
    const p = 10 ** (a.length > 1 ? Math.trunc(number1(a, 1)) : 0);
    const x = Math.abs(number1(a, 0));
    return (Math.floor(snap(x * p)) / p) * (number1(a, 0) < 0 ? -1 : 1);
  },
  EXP: (a) => Math.exp(number1(a, 0)),
  LN: (a) => {
    const v = number1(a, 0);
    return v <= 0 ? fail("#VALUE!") : Math.log(v);
  },
  LOG: (a) => {
    const v = number1(a, 0);
    const base = a.length > 1 ? number1(a, 1) : 10;
    if (v <= 0 || base <= 0 || base === 1) fail("#VALUE!");
    return Math.log(v) / Math.log(base);
  },
  LOG10: (a) => {
    const v = number1(a, 0);
    return v <= 0 ? fail("#VALUE!") : Math.log10(v);
  },
  SIGN: (a) => Math.sign(number1(a, 0)),

  // --- statistics ---
  MEDIAN: (a) => {
    const n = collectNumbers(a).sort((x, y) => x - y);
    if (!n.length) fail("#VALUE!");
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid]! : (n[mid - 1]! + n[mid]!) / 2;
  },
  LARGE: (a) => {
    const n = collectNumbers([a[0] ?? { kind: "value", value: null }]).sort((x, y) => y - x);
    const k = Math.trunc(number1(a, 1));
    return k < 1 || k > n.length ? fail("#VALUE!") : n[k - 1]!;
  },
  SMALL: (a) => {
    const n = collectNumbers([a[0] ?? { kind: "value", value: null }]).sort((x, y) => x - y);
    const k = Math.trunc(number1(a, 1));
    return k < 1 || k > n.length ? fail("#VALUE!") : n[k - 1]!;
  },
  STDEV: (a) => Math.sqrt(variance(collectNumbers(a), true)),
  STDEVP: (a) => Math.sqrt(variance(collectNumbers(a), false)),
  VAR: (a) => variance(collectNumbers(a), true),
  VARP: (a) => variance(collectNumbers(a), false),

  // --- logical ---
  AND: (a) => {
    const flags = logicFlags(a);
    return flags.length ? flags.every(Boolean) : fail("#VALUE!");
  },
  OR: (a) => {
    const flags = logicFlags(a);
    return flags.length ? flags.some(Boolean) : fail("#VALUE!");
  },
  NOT: (a) => !toBool(value(a, 0)),

  // --- information ---
  ISBLANK: (a) => value(a, 0) === null,
  ISNUMBER: (a) => typeof value(a, 0) === "number",
  ISTEXT: (a) => typeof value(a, 0) === "string",

  // --- text ---
  CONCAT: (a) => joinText(a),
  CONCATENATE: (a) => joinText(a),
  LEN: (a) => toText(value(a, 0)).length,
  LEFT: (a) => {
    const t = toText(value(a, 0));
    const n = optionalCount(a, 1, 1);
    return n < 0 ? fail("#VALUE!") : t.slice(0, n);
  },
  RIGHT: (a) => {
    const t = toText(value(a, 0));
    const n = optionalCount(a, 1, 1);
    if (n < 0) fail("#VALUE!");
    return n === 0 ? "" : t.slice(-n);
  },
  MID: (a) => {
    const t = toText(value(a, 0));
    const start = Math.trunc(number1(a, 1));
    const count = Math.trunc(number1(a, 2));
    if (start < 1 || count < 0) fail("#VALUE!");
    return t.slice(start - 1, start - 1 + count);
  },
  UPPER: (a) => toText(value(a, 0)).toUpperCase(),
  LOWER: (a) => toText(value(a, 0)).toLowerCase(),
  TRIM: (a) => toText(value(a, 0)).replace(/ +/g, " ").trim(),
  SUBSTITUTE: (a) => {
    const t = toText(value(a, 0));
    const oldText = toText(value(a, 1));
    const newText = toText(value(a, 2));
    if (a.length > 3) {
      const instance = Math.trunc(number1(a, 3));
      if (instance < 1) fail("#VALUE!");
      if (oldText === "") return t;
      let idx = -1;
      for (let k = 0; k < instance; k++) {
        idx = t.indexOf(oldText, idx + 1);
        if (idx < 0) return t;
      }
      return t.slice(0, idx) + newText + t.slice(idx + oldText.length);
    }
    return oldText === "" ? t : t.split(oldText).join(newText);
  },
  REPLACE: (a) => {
    const t = toText(value(a, 0));
    const start = Math.trunc(number1(a, 1));
    const count = Math.trunc(number1(a, 2));
    const newText = toText(value(a, 3));
    if (start < 1 || count < 0) fail("#VALUE!");
    return t.slice(0, start - 1) + newText + t.slice(start - 1 + count);
  },
  REPEAT: (a) => {
    const t = toText(value(a, 0));
    const n = Math.trunc(number1(a, 1));
    if (n < 0) fail("#VALUE!");
    if (n === 0) return "";
    if (t.length * n > MAX_TEXT_LENGTH) fail("#VALUE!");
    return t.repeat(n);
  },
  FIND: (a) => {
    const needle = toText(value(a, 0));
    const hay = toText(value(a, 1));
    const start = optionalCount(a, 2, 1);
    if (start < 1 || start > hay.length + 1) fail("#VALUE!");
    const idx = hay.indexOf(needle, start - 1);
    return idx < 0 ? fail("#VALUE!") : idx + 1;
  },
  SEARCH: (a) => {
    const needle = toText(value(a, 0));
    const hay = toText(value(a, 1));
    const start = optionalCount(a, 2, 1);
    if (start < 1) fail("#VALUE!");
    const pattern = [...needle].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
    const re = new RegExp("^" + pattern, "i");
    for (let i = start - 1; i < hay.length; i++) if (re.test(hay.slice(i))) return i + 1;
    return fail("#VALUE!");
  },
  VALUE: (a) => {
    const s = toText(value(a, 0)).trim();
    if (COERCIBLE_TEXT.test(s)) return Number(s);
    const percent = /^([+-]?\d+(?:\.\d+)?)%$/.exec(s);
    if (percent) return Number(percent[1]) / 100;
    if (ISO_DATE_TEXT.test(s)) {
      const t = Date.parse(s + "T00:00:00Z");
      if (Number.isFinite(t)) return serialFromMs(t);
    }
    return fail("#VALUE!");
  },
  TEXT: (a) => {
    const n = number1(a, 0);
    const fmt = toText(value(a, 1));
    const m = /^(0+)(?:\.(0+))?(%?)$/.exec(fmt);
    if (!m) return fail("#VALUE!") as never;
    const decimals = m[2] ? m[2].length : 0;
    const scaled = roundHalfAway(n * (m[3] ? 100 : 1), decimals);
    return scaled.toFixed(decimals) + (m[3] ? "%" : "");
  },

  // --- dates (Excel serial numbers, UTC calendar) ---
  TODAY: (_a, e) => serialFromMs(e.now),
  NOW: (_a, e) => {
    const days = Math.floor(e.now / DAY_MS);
    const whole = days + SERIAL_UNIX_OFFSET;
    return (whole < 61 ? whole - 1 : whole) + (e.now - days * DAY_MS) / DAY_MS;
  },
  DATE: (a) => {
    const serial = serialFromDateUTC(Math.trunc(number1(a, 0)), Math.trunc(number1(a, 1)), Math.trunc(number1(a, 2)));
    return serial < 0 ? fail("#VALUE!") : serial;
  },
  YEAR: (a) => datePart(a, "y"),
  MONTH: (a) => datePart(a, "m"),
  DAY: (a) => datePart(a, "d"),

  // --- lookups ---
  VLOOKUP: (a) => hlookupImpl(a, false),
  HLOOKUP: (a) => hlookupImpl(a, true),
  INDEX: (a) => {
    const grid = asGrid(a[0] ?? { kind: "value", value: null });
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    let r = Math.trunc(number1(a, 1));
    let c = a.length > 2 ? Math.trunc(number1(a, 2)) : 0;
    if (a.length <= 2) {
      if (rows === 1 && cols > 1) {
        c = r;
        r = 1;
      } else c = 1;
    }
    if (r < 1 || c < 1 || r > rows || c > cols) fail("#REF!");
    return grid[r - 1]![c - 1] ?? null;
  },
  MATCH: (a) => {
    const target = value(a, 0);
    const grid = asGrid(a[1] ?? { kind: "value", value: null });
    let vec: CellValue[];
    if (grid.length === 1) vec = grid[0]!;
    else if (grid[0]?.length === 1) vec = grid.map((row) => row[0]!);
    else return fail("#VALUE!");
    const type = a.length > 2 ? Math.trunc(number1(a, 2)) : 0;
    if (type === 1) {
      let best = -1;
      for (let i = 0; i < vec.length; i++) {
        if (lookupCompare(target, vec[i]!) <= 0) best = i;
        else break;
      }
      return best < 0 ? fail("#N/A") : best + 1;
    }
    for (let i = 0; i < vec.length; i++) if (lookupCompare(target, vec[i]!) === 0) return i + 1;
    return fail("#N/A");
  },
  COLUMN: () => fail("#VALUE!"), // handled in evalCall (needs the reference)
  ROW: () => fail("#VALUE!"), // handled in evalCall (needs the reference)

  // --- conditional aggregates ---
  SUMIF: (a) => {
    let total = 0;
    criteriaPairs(a, (v) => {
      if (typeof v === "number") total += v;
    });
    return total;
  },
  COUNTIF: (a) => {
    let count = 0;
    criteriaPairs(a, () => {
      count++;
    });
    return count;
  },
  AVERAGEIF: (a) => {
    let total = 0;
    let count = 0;
    criteriaPairs(a, (v) => {
      if (typeof v === "number") {
        total += v;
        count++;
      }
    });
    return count ? total / count : fail("#DIV/0!");
  },
};

function logicFlags(args: ArgValue[]): boolean[] {
  const out: boolean[] = [];
  const push = (v: CellValue, direct: boolean): void => {
    if (typeof v === "boolean") out.push(v);
    else if (typeof v === "number") out.push(v !== 0);
    else if (typeof v === "string" && direct) {
      const s = v.trim().toUpperCase();
      if (s === "TRUE") out.push(true);
      else if (s === "FALSE") out.push(false);
      else if (COERCIBLE_TEXT.test(v.trim())) out.push(Number(v.trim()) !== 0);
      else fail("#VALUE!");
    }
  };
  for (const arg of args) {
    if (arg.kind === "range") {
      for (const row of arg.grid) for (const v of row) push(v, false);
    } else push(arg.value, true);
  }
  return out;
}

function joinText(args: ArgValue[]): string {
  let out = "";
  for (const arg of args) {
    if (arg.kind === "range") {
      for (const row of arg.grid) for (const v of row) out += toText(v);
    } else out += toText(arg.value);
  }
  return out.length > MAX_TEXT_LENGTH ? fail("#VALUE!") : out;
}

function optionalCount(args: ArgValue[], i: number, fallback: number): number {
  if (args.length <= i) return fallback;
  const raw = value(args, i);
  return raw === null ? fallback : Math.trunc(toNumber(raw));
}

function datePart(args: ArgValue[], part: "y" | "m" | "d"): number {
  const serial = number1(args, 0);
  if (!Number.isFinite(serial) || serial < 0) fail("#VALUE!");
  const date = new Date(msFromSerial(serial));
  if (date.getUTCFullYear() < 1900) fail("#VALUE!");
  return part === "y" ? date.getUTCFullYear() : part === "m" ? date.getUTCMonth() + 1 : date.getUTCDate();
}

function hlookupImpl(args: ArgValue[], horizontal: boolean): CellValue {
  const lookup = value(args, 0);
  const grid = asGrid(args[1] ?? { kind: "value", value: null });
  // VLOOKUP scans down the first column of the grid; HLOOKUP scans across the
  // first row, which is the transposed orientation.
  const table = horizontal ? transpose(grid) : grid;
  const index = Math.trunc(number1(args, 2));
  const approx = args.length < 4 ? true : value(args, 3) === null ? true : toBool(value(args, 3));
  if (index < 1) fail("#VALUE!");
  if (!table.length || index > (table[0]?.length ?? 0)) fail("#REF!");
  if (approx) {
    let best = -1;
    for (let r = 0; r < table.length; r++) {
      if (lookupCompare(lookup, table[r]![0]!) <= 0) best = r;
      else break;
    }
    if (best < 0) fail("#N/A");
    return table[best]![index - 1] ?? null;
  }
  for (let r = 0; r < table.length; r++) {
    if (lookupCompare(lookup, table[r]![0]!) === 0) return table[r]![index - 1] ?? null;
  }
  return fail("#N/A");
}

function transpose(grid: CellValue[][]): CellValue[][] {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const out: CellValue[][] = [];
  for (let c = 0; c < cols; c++) {
    const row: CellValue[] = [];
    for (let r = 0; r < rows; r++) row.push(grid[r]![c] ?? null);
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-grid recalculation
// ---------------------------------------------------------------------------

/**
 * Recalculate a full cell grid dependency-aware. Formula cells are computed in
 * dependency order (cycles surface as "#CIRC!"); non-formula cells parse to
 * their typed literal value. Errors are embedded in `values` as their
 * "#CODE!" text and listed in `errors` as "A1: #CODE!" entries.
 */
export function recalcSheet(cells: string[][], opts: EvaluateContext = {}): RecalcResult {
  const engine = createEngine(opts, cells);
  const values: CellValue[][] = [];
  const errors: string[] = [];
  for (let r = 0; r < cells.length; r++) {
    const rowValues: CellValue[] = [];
    const width = cells[r]?.length ?? 0;
    for (let c = 0; c < width; c++) {
      const result = computeCell(engine, engine.currentSheet, r + 1, c + 1);
      if (result.error) {
        rowValues.push(result.error);
        errors.push(`${columnName(c + 1)}${r + 1}: ${result.error}`);
      } else {
        rowValues.push(result.value);
      }
    }
    values.push(rowValues);
  }
  return { values, errors };
}
