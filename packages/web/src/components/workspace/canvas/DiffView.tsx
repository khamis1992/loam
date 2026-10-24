'use client';

/**
 * Neo N13: the line diff view for a document node's versions.
 *
 * `src/graph/versions.ts` computes an exact LCS diff on the server and returns a
 * flat list of aligned lines. This component only *renders* that list: each line
 * is coloured by its op and shows its line number in whichever version it belongs
 * to, so a removed line keeps its old number and an added line its new one.
 *
 * The alignment is the point of the component. A naive side-by-side of two
 * versions cannot tell an edit from a rewrite; the aligned list shows it in one
 * scroll. Everything user-visible goes through `tr`, and line text is `dir="auto"`
 * because a diff of a right-to-left document must not be forced left-to-right.
 */
import { useMemo } from 'react';
import type { CanvasDiff, CanvasDiffLine } from './nodeActions';

export interface DiffViewProps {
  diff: CanvasDiff;
  /** Translate a key for this panel's locale. */
  tr: (key: string, vars?: Record<string, string | number>) => string;
}

/** The row class for one aligned line. */
const OP_CLASS: Record<CanvasDiffLine['op'], string> = {
  equal: 'bg-bg-main text-text-secondary',
  delete: 'bg-function-error-tsp text-function-error',
  insert: 'bg-function-success-tsp text-function-success',
};

/** The gutter glyph for one aligned line. */
const OP_GLYPH: Record<CanvasDiffLine['op'], string> = {
  equal: ' ',
  delete: '-',
  insert: '+',
};

export function DiffView({ diff, tr }: DiffViewProps) {
  const totals = useMemo(
    () => ({
      added: diff.added,
      removed: diff.removed,
      unchanged: diff.unchanged,
    }),
    [diff.added, diff.removed, diff.unchanged],
  );

  return (
    <div className="flex flex-col gap-1" data-testid="canvas-diff" data-from={diff.from} data-to={diff.to}>
      <p className="text-[11px] text-text-tertiary">
        {tr('Compare versions')}: {diff.from} → {diff.to}
      </p>
      <div className="flex flex-wrap gap-2 text-[11px] tabular-nums">
        <span className="text-function-success" data-testid="canvas-diff-added">
          +{totals.added} {tr('Added')}
        </span>
        <span className="text-function-error" data-testid="canvas-diff-removed">
          −{totals.removed} {tr('Removed')}
        </span>
        <span className="text-text-tertiary" data-testid="canvas-diff-unchanged">
          {totals.unchanged} {tr('Unchanged')}
        </span>
      </div>

      {diff.lines.length === 0 ? (
        <p className="text-[11px] text-text-tertiary" data-testid="canvas-diff-empty">
          {diff.empty ? tr('No differences between these versions.') : tr('This node carries no text.')}
        </p>
      ) : (
        <ol className="flex flex-col gap-0.5 font-mono text-[11px]">
          {diff.lines.map((line, index) => (
            <li
              key={`${line.op}-${line.oldLine ?? 'x'}-${line.newLine ?? 'y'}-${index}`}
              className={`flex gap-1 rounded-control px-1.5 py-0.5 ${OP_CLASS[line.op]}`}
            >
              <span className="w-6 shrink-0 select-none text-end text-text-quaternary" aria-hidden="true">
                {line.oldLine ?? ''}
              </span>
              <span className="w-6 shrink-0 select-none text-end text-text-quaternary" aria-hidden="true">
                {line.newLine ?? ''}
              </span>
              <span className="shrink-0 select-none" aria-hidden="true">
                {OP_GLYPH[line.op]}
              </span>
              <span dir="auto" className="min-w-0 flex-1 whitespace-pre-wrap break-all">
                {line.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
