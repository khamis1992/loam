const logos = ["Northwind", "Acme", "Globex", "Initech", "Umbrella"];

export default function LogosBandBlock() {
  return (
    <section className="border-y border-border bg-background">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Trusted by teams at
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
          {logos.map((logo) => (
            <span key={logo} className="text-lg font-semibold text-muted-foreground/70">
              {logo}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
