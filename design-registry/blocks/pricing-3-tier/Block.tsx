const plans = [
  {
    name: "Starter",
    price: "$0",
    blurb: "For trying Loam on a single project.",
    features: ["1 workspace", "Core tools", "Community support"],
    cta: "Start for free",
    featured: false,
  },
  {
    name: "Pro",
    price: "$12",
    blurb: "For professionals shipping every week.",
    features: ["Unlimited workspaces", "All tools", "Priority support", "History export"],
    cta: "Start Pro",
    featured: true,
  },
  {
    name: "Team",
    price: "$29",
    blurb: "For teams that need shared context.",
    features: ["Everything in Pro", "Shared memory", "Role-based access", "Audit log"],
    cta: "Contact sales",
    featured: false,
  },
];

export default function PricingThreeTierBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            Simple pricing that scales with you
          </h2>
          <p className="mt-3 text-muted-foreground">
            Start free and upgrade when your work outgrows a single workspace.
          </p>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`flex flex-col rounded-lg border p-6 ${
                plan.featured ? "border-primary bg-card" : "border-border"
              }`}
            >
              <h3 className="text-lg font-medium text-foreground">{plan.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{plan.blurb}</p>
              <p className="mt-4 text-4xl font-semibold text-foreground">{plan.price}</p>
              <ul className="mt-6 flex flex-col gap-2 text-sm text-muted-foreground">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <a
                href="#"
                className={`mt-8 inline-flex h-10 items-center justify-center rounded-md text-sm font-medium ${
                  plan.featured
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-foreground"
                }`}
              >
                {plan.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
