const features = [
  { title: "Isolated context", body: "Each task only sees what it needs." },
  { title: "Focused tools", body: "The toolset matches the job at hand." },
  { title: "History", body: "Every change is recorded and reversible." },
  { title: "Review", body: "Work is checked before it is accepted." },
  { title: "Memory", body: "Recalled context across related tasks." },
  { title: "Local first", body: "Runs on your machine, keeps data yours." },
];

export default function FeaturesGridBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            Built for focused work
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            A small set of capabilities that work together instead of a large set
            that gets in the way.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, index) => (
            <div key={feature.title} className="rounded-lg border border-border p-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="sr-only">Feature {index + 1}</span>
              </div>
              <h3 className="mt-4 text-base font-medium text-foreground">{feature.title}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
