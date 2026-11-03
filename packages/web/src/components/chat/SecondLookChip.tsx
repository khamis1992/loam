export function SecondLookChip({ verdict, findings }: { verdict: string; findings?: string }) {
  return (
    <aside dir="auto" className="my-2 rounded-control border border-border-main bg-fill-tsp px-3 py-2 text-sm text-text-primary">
      <div className="text-xs font-medium text-text-secondary">Second Look</div>
      <div>{verdict === 'findings' ? findings : verdict}</div>
    </aside>
  );
}
