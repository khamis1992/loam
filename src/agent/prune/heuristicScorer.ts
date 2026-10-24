import { bm25Score, buildBm25Index, tokenize } from "../contextSelector.js";
import type { PairScore, PruneScorer, ScorerInput, ToolPair } from "./types.js";

export const DEFAULT_SIDE_EFFECT_TOOLS: readonly string[] = [
  "file_write", "file_edit", "file_multi_edit", "find_and_edit", "shell_run",
  "office_import", "office_export", "office_edit", "office_craft",
];

const MAX_BODY_SCAN = 20_000;
const MAX_IDENTIFIERS = 200;
const IDENT_RE = /[\p{L}_][\p{L}\p{N}_./\\-]{5,}/gu;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Identifiers worth looking for in later assistant text: long and not a plain word. */
function identifiers(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.slice(0, MAX_BODY_SCAN).matchAll(IDENT_RE)) {
    const s = m[0];
    if (/[_./\\-]/.test(s) || /[a-z][A-Z]/.test(s)) out.add(s);
    if (out.size >= MAX_IDENTIFIERS) break;
  }
  return [...out];
}

function isReferenced(pair: ToolPair, body: string, later: string): boolean {
  if (!later) return false;
  if (pair.path && later.includes(pair.path)) return true;
  return identifiers(body).some(id => later.includes(id));
}

/** Deterministic, offline scorer: recency, supersession, error state and BM25 relevance. */
export class HeuristicScorer implements PruneScorer {
  readonly name = "heuristic";
  private readonly sideEffect: ReadonlySet<string>;

  constructor(sideEffectTools: Iterable<string> = DEFAULT_SIDE_EFFECT_TOOLS) {
    this.sideEffect = new Set(sideEffectTools);
  }

  async score(input: ScorerInput): Promise<Map<string, PairScore>> {
    const { pairs, bodies } = input;
    const bodyOf = (p: ToolPair): string => bodies.get(p.id) ?? "";

    const index = buildBm25Index(pairs.map(p => tokenize(bodyOf(p))));
    const terms = tokenize(input.query || input.goal);
    const raw = pairs.map((_, i) => (terms.length ? bm25Score(index, i, terms) : 0));
    const top = raw.reduce((a, b) => Math.max(a, b), 0);

    const out = new Map<string, PairScore>();
    pairs.forEach((p, i) => {
      let samePathLater = false, identicalLater = false, okSameLater = false;
      for (let j = i + 1; j < pairs.length; j++) {
        const q = pairs[j]!;
        if (p.path !== undefined && q.path === p.path) samePathLater = true;
        if (q.tool === p.tool && q.argsJson === p.argsJson) identicalLater = true;
        if (q.ok && q.tool === p.tool && q.path === p.path) okSameLater = true;
      }
      const superseded = samePathLater || identicalLater;
      const errLatest = !p.ok && !okSameLater;
      const errFixed = !p.ok && okSameLater;

      let keepResult: number;
      if (errLatest) keepResult = 0.9;
      else if (superseded) keepResult = 0.1;
      else if (errFixed) keepResult = 0.2;
      else {
        const r = top > 0 ? raw[i]! / top : 0;
        const referenced = isReferenced(p, bodyOf(p), input.laterAssistantText(p.id));
        keepResult = clamp01(
          0.15 + 0.6 * r * 0.97 ** p.stepsAgo + (referenced ? 0.25 : 0) - (p.resultChars > 8000 ? 0.1 : 0),
        );
      }

      const keepCall = this.sideEffect.has(p.tool) ? 0.8 : superseded && identicalLater ? 0.2 : 0.55;
      out.set(p.id, { keepCall, keepResult });
    });
    return out;
  }
}
