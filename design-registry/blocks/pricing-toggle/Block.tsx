import { useState } from "react";

const plans = [
  { name: "Pro", monthly: 12, yearly: 10, features: ["Unlimited workspaces", "All tools"] },
  { name: "Team", monthly: 29, yearly: 24, features: ["Shared memory", "Role-based access"] },
];

export default function PricingToggleBlock() {
  const [yearly, setYearly] = useState(true);

  return (
    <section className="bg-background">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="text-sm text-muted-foreground">Monthly</span>
          <button
            type="button"
            role="switch"
            aria-checked={yearly}
            onClick={() => setYearly((v) => !v)}
            className="relative h-6 w-11 rounded-full bg-muted"
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition-all ${
                yearly ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
          <span className="text-sm text-muted-foreground">
            Yearly <span className="text-primary">save 17%</span>
          </span>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          {plans.map((plan) => {
            const price = yearly ? plan.yearly : plan.monthly;
            return (
              <div key={plan.name} className="rounded-lg border border-border p-6">
                <h3 className="text-lg font-medium text-foreground">{plan.name}</h3>
                <p className="mt-4 text-4xl font-semibold text-foreground">
                  ${price}
                  <span className="text-base font-normal text-muted-foreground">/mo</span>
                </p>
                <ul className="mt-6 flex flex-col gap-2 text-sm text-muted-foreground">
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <a
                  href="#"
                  className="mt-8 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
                >
                  Choose {plan.name}
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
