const stats = [
  { value: "12k+", label: "Workspaces created" },
  { value: "98%", label: "Tasks completed" },
  { value: "40k", label: "Hours saved" },
  { value: "4.9", label: "Average rating" },
];

export default function StatsBandBlock() {
  return (
    <section className="bg-muted/40">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-16 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="text-center">
            <p className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
              {stat.value}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
