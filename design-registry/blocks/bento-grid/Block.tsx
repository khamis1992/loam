const features = [
  {
    title: "Isolated workspaces",
    body: "Each task gets its own files, tools and history so nothing bleeds between jobs.",
    span: "lg:col-span-2",
  },
  { title: "Focused tools", body: "Only the tools a task can use are exposed." },
  { title: "Built-in review", body: "Every change is checked before it ships." },
];

export default function BentoGridBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-10 max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            A workspace that adapts to the work
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            The layout leads with the capability that matters most and lets the
            supporting pieces fall into place around it.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className={`rounded-lg border border-border bg-card p-6 ${feature.span}`}
            >
              <h3 className="text-lg font-medium text-card-foreground">{feature.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
