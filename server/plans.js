/**
 * Server-authoritative plan catalogue. Prices live ONLY here — the client
 * never dictates amounts to the payment providers.
 */
export const PLANS = {
  free: {
    id: "free",
    name: { en: "Free", uz: "Bepul", ru: "Бесплатный" },
    price: { monthly: 0, yearly: 0 },
    generationsPerDay: 10,
    savedCap: 20,
    proStyles: false,
    premiumStyles: false,
  },
  pro: {
    id: "pro",
    name: { en: "Pro", uz: "Pro", ru: "Про" },
    // UZS, per period
    price: { monthly: 49_000, yearly: 470_000 },
    generationsPerDay: 200,
    savedCap: Infinity,
    proStyles: true,
    premiumStyles: false,
  },
  premium: {
    id: "premium",
    name: { en: "Premium", uz: "Premium", ru: "Премиум" },
    price: { monthly: 99_000, yearly: 950_000 },
    generationsPerDay: Infinity,
    savedCap: Infinity,
    proStyles: true,
    premiumStyles: true,
  },
};

export const YEARLY_DISCOUNT_NOTE = "~20%";

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
