export default function HeroCenteredBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 py-24 text-center">
        <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground">
          Now in public beta
        </span>
        <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Ship focused work without the noise
        </h1>
        <p className="max-w-xl text-base leading-7 text-muted-foreground">
          Loam gives every task its own workspace, tools and context so small
          teams can move faster with fewer mistakes.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a
            href="#start"
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Get started
          </a>
          <a
            href="#docs"
            className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground"
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}
