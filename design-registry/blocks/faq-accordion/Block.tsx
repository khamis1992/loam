const faqs = [
  {
    q: "Does Loam run offline?",
    a: "Yes. The core agent runs on your machine, so your work continues without a network connection.",
  },
  {
    q: "Where is my data stored?",
    a: "Everything stays in your local workspace. Nothing is uploaded unless you explicitly connect a cloud service.",
  },
  {
    q: "Can I bring my own model?",
    a: "Yes. Loam supports local models and OpenAI-compatible endpoints, including a bring-your-own-key option.",
  },
  {
    q: "How do I undo a change?",
    a: "Every change is recorded. Open the history panel to review and revert any step.",
  },
];

export default function FaqAccordionBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          Frequently asked questions
        </h2>
        <div className="mt-8 divide-y divide-border rounded-lg border border-border">
          {faqs.map((faq) => (
            <details key={faq.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground">
                {faq.q}
                <span className="ml-4 text-muted-foreground transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
