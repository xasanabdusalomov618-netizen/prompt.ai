/**
 * Server-authoritative plan catalogue. Prices live ONLY here — the client
 * never dictates amounts to the payment providers.
 *
 * Pricing (UZS — Click and Payme settle in so'm only):
 *   Free     25 000 so'm/mo   — or yearly subscription 292 000 so'm/yr (≈ $23)
 *   Pro      38 000 so'm/mo   — monthly billing only
 *   Premium  63 000 so'm/mo   — monthly billing only
 *
 * Every account starts with a 5-generation lifetime trial on the Free
 * plan. After that, generation requires an active subscription
 * (Free tier or higher). See server/routes/billing.js (/usage).
 */
export const PLANS = {
  free: {
    id: "free",
    name: { en: "Free", uz: "Bepul", ru: "Бесплатный" },
    price: { monthly: 25_000, yearly: 292_000 },
    generationsPerDay: 100,
    savedCap: 100,
    proStyles: false,
    premiumStyles: false,
  },
  pro: {
    id: "pro",
    name: { en: "Pro", uz: "Pro", ru: "Про" },
    // UZS, per period. Yearly billing is offered for the Free plan only.
    price: { monthly: 38_000, yearly: null },
    generationsPerDay: 200,
    savedCap: Infinity,
    proStyles: true,
    premiumStyles: false,
  },
  premium: {
    id: "premium",
    name: { en: "Premium", uz: "Premium", ru: "Премиум" },
    price: { monthly: 63_000, yearly: null },
    generationsPerDay: Infinity,
    savedCap: Infinity,
    proStyles: true,
    premiumStyles: true,
  },
};

export const TRIAL_GENERATION_LIMIT = 5;
export const YEARLY_DISCOUNT_NOTE = "~$23/yr";

export function planPrice(planId, billing) {
  const plan = PLANS[planId];
  if (!plan) return null;
  const amount = plan.price[billing === "yearly" ? "yearly" : "monthly"];
  return { plan, amount };
}

export function periodMs(billing) {
  return billing === "yearly"
    ? 365 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
}

export function toTiyin(amountUzs) {
  return Math.round(amountUzs) * 100;
}
