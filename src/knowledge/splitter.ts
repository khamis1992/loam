/**
 * Neo N3: seed splitting.
 *
 * A document becomes a list of seeds. Two strategies:
 *
 *  - "fixed" is the deterministic fallback: cut on headings/paragraphs, pack
 *    into chunks of at most `maxChars`, title each chunk from its first line.
 *    It never needs a model, so ingestion always succeeds.
 *  - "smart" asks the reasoning model to read the text and return one JSON
 *    object per seed ({title, body, tags}[]). When the model is unavailable or
 *    its reply is unusable, `smartSplit` degrades to the fixed strategy and
 *    reports `usedFallback: true`, so a caller can tell the user the LLM path
 *    was skipped without failing the import.
 *
 * N21: the fixed splitter is script-aware. Arabic sentences are closed by `.` `!`
 * `?` `؟` and the Asian full stop `۔`, and are separated by the Arabic comma
 * `،`, which must never become a cut point. A short Arabic sentence is not a
 * heading, so a paragraph of them stays one block and is cut on its own marks.
 */
import { SPLIT_RUN, isHeadingLine } from "./text.js";

export interface SeedChunk {
  title: string;
  body: string;
  tags: string[];
  /** True when produced by the LLM smart splitter. */
  smart?: boolean;
}

export interface SmartSplitOptions {
  model: string;
  signal?: AbortSignal;
}

export interface SmartSplitter {
  split(text: string, opts: SmartSplitOptions): Promise<SeedChunk[]>;
}

export interface SplitOptions {
  /** Characters per fixed chunk before the heading/paragraph packer grows it. */
  maxChars?: number;
  /** Lines above this are treated as headings when cutting fixed chunks. */
  headingLines?: number;
}

const DEFAULT_MAX_CHARS = 2400;
const MIN_CHUNK_CHARS = 80;

/** Extract the first JSON array of {title, body, tags} from a model reply. */
export function parseSeedChunks(raw: string): SeedChunk[] | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const chunks: SeedChunk[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (!body) continue;
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : firstLineTitle(body);
    const tags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === "string") : [];
    chunks.push({ title, body, tags: tags.slice(0, 12), smart: true });
  }
  return chunks.length > 0 ? chunks : null;
}

/** A title from the first non-empty line, bounded. */
function firstLineTitle(body: string): string {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const cleaned = line.replace(/^#{1,6}\s*/, "");
  return cleaned.length > 0 ? (cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned) : "Untitled";
}

/**
 * Fixed, model-free splitting. Cuts on blank-line paragraphs, keeps markdown
 * headings attached to the block that follows them, then packs blocks into
 * chunks of at most `maxChars`. A block longer than the cap is split on
 * sentence boundaries so no seed is ever unbounded, and every seed closes on a
 * sentence mark rather than mid-phrase.
 */
export function fixedSplit(text: string, opts: SplitOptions = {}): SeedChunk[] {
  const maxChars = Math.max(MIN_CHUNK_CHARS, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const source = text.replace(/\r\n/g, "\n").trim();
  if (!source) return [];

  const blocks = new Map<string, string>();
  const lines = source.split("\n");
  let current = "";
  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    if (isBlank) {
      if (current.trim()) blocks.set(`b${blocks.size}`, current.trim());
      current = "";
      continue;
    }
    const heading = isHeadingLine(line, opts.headingLines ?? 90);
    if (heading && current.trim()) {
      blocks.set(`b${blocks.size}`, current.trim());
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) blocks.set(`b${blocks.size}`, current.trim());

  if (blocks.size === 0) return [{ title: firstLineTitle(source), body: source, tags: [] }];

  const chunks: SeedChunk[] = [];
  let buffer = "";
  const flush = (): void => {
    const body = buffer.trim();
    if (!body) return;
    for (const piece of splitOversized(body, maxChars)) {
      chunks.push({ title: firstLineTitle(piece), body: piece, tags: [] });
    }
    buffer = "";
  };
  for (const block of blocks.values()) {
    if (buffer && buffer.length + block.length + 1 > maxChars) flush();
    buffer = buffer ? `${buffer}\n\n${block}` : block;
    if (buffer.length >= maxChars) flush();
  }
  flush();

  return chunks.length > 0 ? chunks : [{ title: firstLineTitle(source), body: source, tags: [] }];
}

/**
 * Split one oversized block into pieces <= maxChars, always on sentence marks.
 *
 * A block below the chunk floor is kept whole: shredding a 43-character Arabic
 * paragraph into two 20-character seeds would make each seed meaningless. The
 * run-based splitter prefers whole sentences and only cuts mid-phrase as a last
 * resort, when a single sentence is itself longer than the cap.
 */
function splitOversized(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) return [body];

  const runs = body.match(SPLIT_RUN) ?? [body];
  const pieces: string[] = [];
  let current = "";

  const pushRun = (run: string): void => {
    const trimmed = run.trim();
    if (!trimmed) return;
    // A single run longer than the cap has no sentence boundary to cut on.
    if (trimmed.length > maxChars) {
      if (current.trim()) {
        pieces.push(current.trim());
        current = "";
      }
      pieces.push(...hardCut(trimmed, maxChars));
      return;
    }
    if (current && current.length + trimmed.length + 1 > maxChars) {
      pieces.push(current.trim());
      current = trimmed;
    } else {
      current = current ? `${current} ${trimmed}` : trimmed;
    }
  };

  for (const run of runs) pushRun(run);
  if (current.trim()) pieces.push(current.trim());
  return pieces.length > 0 ? pieces : [body.slice(0, maxChars)];
}

/** Cut a single long run on spaces, only after the minimum chunk length. */
function hardCut(run: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = run;
  while (rest.length > maxChars) {
    const cut = rest.lastIndexOf(" ", maxChars);
    if (cut < MIN_CHUNK_CHARS) {
      out.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars).trim();
    } else {
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Smart splitting with a deterministic fallback. Returns the model's chunks when
 * they parse, else the fixed split; `usedFallback` tells the caller which.
 */
export async function smartSplit(
  text: string,
  splitter: SmartSplitter | undefined,
  opts: SplitOptions & { smartOptions?: SmartSplitOptions } = {},
): Promise<{ chunks: SeedChunk[]; usedFallback: boolean }> {
  if (splitter && opts.smartOptions) {
    try {
      const chunks = await splitter.split(text, opts.smartOptions);
      if (chunks.length > 0) return { chunks, usedFallback: false };
    } catch {
      // Fall through to the fixed strategy: ingestion must not fail on a model error.
    }
  }
  return { chunks: fixedSplit(text, opts), usedFallback: true };
}
