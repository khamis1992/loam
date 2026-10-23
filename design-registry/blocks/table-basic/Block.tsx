const rows = [
  { name: "Atlas", owner: "Maya", status: "Active", tasks: 42 },
  { name: "Beacon", owner: "Omar", status: "Paused", tasks: 7 },
  { name: "Cinder", owner: "Lena", status: "Active", tasks: 18 },
];

export default function TableBasicBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-4xl px-6 py-16">
        <h2 className="text-xl font-semibold text-foreground">Workspaces</h2>
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Owner</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Tasks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.name} className={index % 2 === 0 ? "bg-background" : "bg-muted/40"}>
                  <td className="px-4 py-3 text-foreground">{row.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.owner}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-foreground">{row.tasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
