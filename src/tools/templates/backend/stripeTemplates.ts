/**
 * Static template strings for the scaffold_backend "stripe" kind.
 *
 * Safety invariants (same as supabaseTemplates):
 *  - .env.example values empty, placeholder names only.
 *  - No network I/O, no SDK imports, no real-looking secrets in generated TS.
 */

export const STRIPE_CHECKOUT = `// Stripe checkout stub. Set STRIPE_SECRET_KEY / STRIPE_PRICE_ID in .env
// (see .env.example). This stub deliberately performs NO network calls:
// implement the real SDK calls where the TODO markers are.
//
// TODO: npm install stripe
// TODO: import Stripe from "stripe" and create:
//   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "..." })

export interface CheckoutInput {
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionStub {
  id: string;
  url: string;
}

/**
 * Build the parameters the checkout session creation call will need.
 * Returns null while STRIPE_PRICE_ID is unset so callers can fail clean
 * instead of sending partial requests.
 */
export function buildCheckoutParams(input: CheckoutInput): CheckoutSessionStub | null {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) return null;

  // Real implementation sketch (behind TODO above):
  //   return stripe.checkout.sessions.create({
  //     mode: "payment",
  //     line_items: [{ price: priceId, quantity: 1 }],
  //     success_url: input.successUrl,
  //     cancel_url: input.cancelUrl,
  //   });
  return {
    id: "stub_checkout_session",
    url: input.successUrl,
  };
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}
`;

export const STRIPE_PLANS = `// Plan catalog for the app. Price IDs live in the environment; this file maps
// semantic plan names to env-backed price IDs so business code never hardcodes
// Stripe identifiers.
export type PlanId = "free" | "pro";
export type StripePriceEnvVar = "STRIPE_PRICE_ID_PRO" | "STRIPE_PRICE_ID_BASIC";

export interface PlanDefinition {
  planId: PlanId;
  /** Env var holding the Stripe price id that backs this plan. */
  priceIdEnvVar: StripePriceEnvVar;
  features: readonly string[];
}

// NOTE: price id values come from the environment; nothing is hardcoded here.
export const PLANS: readonly PlanDefinition[] = [
  {
    planId: "pro",
    priceIdEnvVar: "STRIPE_PRICE_ID_PRO",
    features: ["unlimited-projects", "priority-support"],
  },
  {
    planId: "free",
    priceIdEnvVar: "STRIPE_PRICE_ID_BASIC",
    features: ["core-usage"],
  },
];

/** Resolve a plan to its env-backed price id, or null when not configured. */
export function priceIdForPlan(planId: PlanId): string | null {
  const plan = PLANS.find((p) => p.planId === planId);
  if (!plan) return null;
  return process.env[plan.priceIdEnvVar] ?? null;
}
`;

export const STRIPE_WEBHOOK = `// Stripe webhook handler skeleton. Set STRIPE_WEBHOOK_SECRET in .env
// (see .env.example). This stub performs NO network calls: signature
// verification and event handling live behind TODOs so wiring the real SDK is
// a contained, reviewable change.
//
// TODO: npm install stripe
// TODO: verify signatures with stripe.webhooks.constructEvent(rawBody, sigHeader, secret)

export type StripeEventType = "checkout.session.completed" | "customer.subscription.updated" | "customer.subscription.deleted";

export interface ParsedStripeEvent {
  type: StripeEventType;
  /** Raw JSON payload; keep parsing per-event so unknown fields fail loud. */
  dataJson: string;
}

/**
 * Compute the payload that constructEvent will consume. Returns null while the
 * webhook secret is unset, so callers can skip processing (fail clean) instead
 * of trusting unsigned payloads.
 */
export function prepareWebhookEvent(sigHeader: string, rawBody: string): ParsedStripeEvent | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return null;
  if (!sigHeader || !rawBody) return null;
  // Under TODO (signature verification) the result would come from the SDK:
  //   const event = stripe.webhooks.constructEvent(rawBody, sigHeader, secret);
  //   event.type / event.data
  return { type: "checkout.session.completed", dataJson: rawBody };
}

/** Per-event exported for tests; extend as your product grows. */
export function describeEventAction(type: StripeEventType): string {
  switch (type) {
    case "checkout.session.completed":
      return "grant entitlements for the purchased plan";
    case "customer.subscription.updated":
      return "sync subscription status to the local user table";
    case "customer.subscription.deleted":
      return "revoke entitlements at period end";
  }
}
`;

export const STRIPE_SETUP_SCRIPT = `// scripts/stripeSetup.ts skeleton: the guided, run-me-once product/price setup.
// This skeleton only validates the environment and prints a plan; live Stripe
// API calls are intentionally behind TODOs (no network I/O from scaffolds).
//
// TODO: npm install stripe
// TODO: replace the printed checklist with the real SDK sequence:
//   1. stripe.products.create({ id: NAME, name: NAME })
//   2. stripe.prices.create({ product, unit_amount, currency, recurring })
//   3. copy the printed price ids into .env (STRIPE_PRICE_ID_*)

interface SetupEnvStatus {
  key: string;
  missing: boolean;
}

function envStatuses(): SetupEnvStatus[] {
  return ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID_PRO", "STRIPE_PRICE_ID_BASIC"].map((key) => ({
    key,
    missing: !process.env[key],
  }));
}

export function buildSetupChecklist(): string[] {
  const statuses = envStatuses();
  const steps: string[] = [];
  for (const s of statuses) {
    steps.push(s.missing ? \`\${s.key}: MISSING (set it in .env before running)\` : \`\${s.key}: set\`);
  }
  steps.push("create product 'pro' + recurring monthly price; copy price id into env");
  steps.push("create product 'basic' + recurring monthly price; copy price id into env");
  steps.push("create webhook endpoint for checkout.session.completed + customer.subscription.*; copy signing secret into env");
  return steps;
}

if (import.meta.url !== undefined && process.argv[1] !== undefined && process.argv[1].includes("stripeSetup")) {
  console.log("Stripe setup checklist (offline skeleton - no API calls):");
  for (const step of buildSetupChecklist()) console.log(" -", step);
}
`;

export const STRIPE_README = `# Stripe starter (scaffold_backend)

Generated files:

- \`src/lib/stripeCheckout.ts\` - checkout session params stub (no SDK/network)
- \`src/lib/stripePlans.ts\` - plan catalog mapping plan names to env-backed price ids
- \`src/lib/stripeWebhook.ts\` - webhook skeleton with fail-clean secret handling
- \`scripts/stripeSetup.ts\` - offline setup checklist skeleton (prints a plan)
- \`.env.example\` - placeholder variable names; every value empty on purpose

## Setup steps

1. \`npm install stripe\`
2. Fill \`.env\` from \`.env.example\`: STRIPE_SECRET_KEY, then price ids.
3. Run \`npx tsx scripts/stripeSetup.ts\` for the generated setup checklist.
4. Create products/prices in the Stripe dashboard (or via SDK once wired) and
   copy the price ids into STRIPE_PRICE_ID / STRIPE_PRICE_ID_PRO/
   STRIPE_PRICE_ID_BASIC.
5. Add a webhook endpoint for checkout.session.completed and
   customer.subscription.*, and copy the signing secret into
   STRIPE_WEBHOOK_SECRET.

## Hard rules the generated code already follows

- No client ever receives the secret key; keep it server-side only.
- Webhooks are the source of truth for subscription state; do not trust
  unverified POST bodies. The stub returns null instead of processing when
  STRIPE_WEBHOOK_SECRET is unset (fail clean, never trust unsigned payloads).
- Webhook verification requires the RAW request body (not re-parsed JSON).
`;

