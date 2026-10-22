export default function HeroSplitBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-20 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Every task, in its own focused workspace
          </h1>
          <p className="max-w-md text-base leading-7 text-muted-foreground">
            Give each job the tools and context it needs and nothing it does not.
            Loam keeps the rest of your project out of the way.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="#start"
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Start free
            </a>
            <a
              href="#tour"
              className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground"
            >
              Take the tour
            </a>
          </div>
        </div>
        <img
          src="/images/hero-workspace.jpg"
          alt="A Loam workspace showing a focused task with its tool panel"
          className="w-full rounded-lg border border-border object-cover"
        />
      </div>
    </section>
  );
}
