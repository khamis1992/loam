export default function CtaBannerBlock() {
  return (
    <section className="bg-background px-6 py-16">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 rounded-xl border border-border bg-card p-10 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-card-foreground">
          Ready to get focused?
        </h2>
        <p className="max-w-xl text-base text-muted-foreground">
          Create your first workspace today and see how much clearer the work
          becomes when the tooling gets out of the way.
        </p>
        <a
          href="#start"
          className="mt-2 inline-flex h-11 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground"
        >
          Get started free
        </a>
      </div>
    </section>
  );
}
