const quotes = [
  {
    quote: "Our review cycle dropped from days to hours once the context stopped getting lost.",
    name: "Dana R.",
    role: "Engineering lead",
  },
  {
    quote: "The first tool that stays out of the way and still keeps everything organised.",
    name: "Priya S.",
    role: "Founder",
  },
  {
    quote: "I trust the output because I can see exactly what it changed and why.",
    name: "Tomas B.",
    role: "Product manager",
  },
];

export default function TestimonialsBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          Teams that ship with Loam
        </h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {quotes.map((item) => (
            <figure key={item.name} className="flex flex-col rounded-lg border border-border p-6">
              <blockquote className="flex-1 text-sm leading-6 text-foreground">
                “{item.quote}”
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-muted" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-foreground">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.role}</p>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
