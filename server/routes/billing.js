import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { db, now, withTransaction } from "../db.js";
import { config, publicStatus, providerCredentials, sandboxMode } from "../env.js";
import {
  requireAuth, requireClientHeader, currentSubscription, resolveEffectivePlan,
} from "../auth.js";
import { PLANS, planPrice, toTiyin, TRIAL_GENERATION_LIMIT } from "../plans.js";
import { serializePayment, serializeSubscription } from "../finalize.js";

export const billingRouter = Router();

/** Yearly billing is offered for the Free plan only ($23/yr). */
const PLAN_ERROR_YEARLY_CHECK = (planId, billing) =>
  billing === "yearly" && PLANS[planId]?.price?.yearly == null;

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_attempts", message: "Too many checkout attempts. Try again later." },
});

/** Public plan catalogue + payment capabilities (no secrets). */
billingRouter.get("/plans", (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      yearlyAvailable: p.price.yearly != null,
      generationsPerDay: p.generationsPerDay === Infinity ? null : p.generationsPerDay,
      unlimitedGenerations: p.generationsPerDay === Infinity,
      savedCap: p.savedCap === Infinity ? null : p.savedCap,
      proStyles: p.proStyles,
      premiumStyles: p.premiumStyles,
    })),
    billing: ["monthly", "yearly"],
    trialLimit: TRIAL_GENERATION_LIMIT,
    currency: "UZS",
    payments: publicStatus(),
  });
});

/** Create a pending payment + provider checkout URL. */
billingRouter.post("/checkout", requireClientHeader, requireAuth, checkoutLimiter, async (req, res) => {
  const planId = String(req.body?.plan ?? "");
  const billing = req.body?.billing === "yearly" ? "yearly" : "monthly";
  const provider = String(req.body?.provider ?? "");
  if (!["free", "pro", "premium"].includes(planId)) {
    return res.status(400).json({ error: "invalid_plan", message: "Unknown plan." });
  }
  if (PLAN_ERROR_YEARLY_CHECK(planId, billing)) {
    return res.status(400).json({
      error: "invalid_billing",
      message: "Yearly billing is available for the Free plan only.",
    });
  }
  if (!["click", "payme"].includes(provider)) {
    return res.status(400).json({ error: "invalid_provider", message: "Choose Click or Payme." });
  }
  const creds = providerCredentials(provider);
  if (!creds) {
    return res.status(503).json({
      error: "provider_not_configured",
      message: `${provider === "click" ? "Click" : "Payme"} is not configured. Set merchant credentials or enable sandbox mode.`,
    });
  }

  const { amount } = planPrice(planId, billing);
  if (amount == null) {
    return res.status(400).json({ error: "invalid_billing", message: "Yearly billing is available for the Free plan only." });
  }
  const t = now();
  const uuid = crypto.randomUUID();
  const mode = creds.sandbox ? "sandbox" : "live";

  await db.execute({
    sql: `INSERT INTO payments
          (uuid, user_id, plan, billing, amount_uzs, currency, provider, status, mode,
           merchant_trans_id, created_at, updated_at)
          VALUES (?,?,?,?,?,'UZS',?,'created',?,?,?,?)`,
    args: [uuid, req.user.id, planId, billing, amount, provider, mode, uuid, t, t],
  });

  const returnUrl = `${config.appUrl}/payment/return?payment=${encodeURIComponent(uuid)}`;
  let checkoutUrl;
  if (provider === "click") {
    if (mode === "sandbox") {
      checkoutUrl = `/payment/sandbox?payment=${uuid}&provider=click`;
    } else {
      const q = new URLSearchParams({
        service_id: creds.serviceId,
        merchant_id: creds.merchantId,
        amount: String(amount),
        transaction_param: uuid,
        return_url: returnUrl,
      });
      if (creds.merchantUserId) q.set("merchant_user_id", creds.merchantUserId);
      checkoutUrl = `${creds.payBase}?${q.toString()}`;
    }
  } else {
    if (mode === "sandbox") {
      checkoutUrl = `/payment/sandbox?payment=${uuid}&provider=payme`;
    } else {
      // Official Payme GET checkout: base64("m=<id>;ac.order_id=<uuid>;a=<tiyin>;c=<return>;l=en")
      const params = `m=${creds.merchantId};ac.order_id=${uuid};a=${toTiyin(amount)};c=${encodeURIComponent(returnUrl)};l=en`;
      checkoutUrl = `${creds.checkoutBase}/${Buffer.from(params).toString("base64")}`;
    }
  }

  return res.status(201).json({
    payment: { uuid, plan: planId, billing, amountUzs: amount, provider, mode },
    checkoutUrl,
    sandbox: mode === "sandbox",
  });
});

/** Payment status polling (owner only). */
billingRouter.get("/payments/:uuid/status", requireAuth, async (req, res) => {
  const rows = await db.execute({
    sql: "SELECT * FROM payments WHERE uuid=?",
    args: [String(req.params.uuid)],
  });
  const p = rows.rows[0];
  if (!p || String(p.user_id) !== req.user.id) {
    return res.status(404).json({ error: "not_found", message: "Payment not found." });
  }
  res.json({ payment: serializePayment(p) });
});

/** Payment history (owner only). */
billingRouter.get("/payments", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = await db.execute({
    sql: "SELECT * FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    args: [req.user.id, limit, offset],
  });
  const total = await db.execute({ sql: "SELECT COUNT(*) c FROM payments WHERE user_id=?", args: [req.user.id] });
  res.json({ payments: rows.rows.map(serializePayment), total: Number(total.rows[0]?.c ?? 0) });
});

/** Current subscription + effective plan (lazy expiry applied). */
billingRouter.get("/subscription", requireAuth, async (req, res) => {
  const { plan, subscription } = await resolveEffectivePlan(req.user.id);
  const all = await currentSubscription(req.user.id);
  res.json({
    plan,
    subscription,
    history: all.slice(0, 10).map(serializeSubscription),
    payments: publicStatus(),
  });
});

/** Toggle cancel-at-period-end / resume renewal. */
billingRouter.post("/subscription/cancel", requireClientHeader, requireAuth, async (req, res) => {
  const cancel = req.body?.cancel !== false; // default true
  const t = now();
  const result = await withTransaction(async (tx) => {
    const rows = await tx.execute({
      sql: "SELECT * FROM subscriptions WHERE user_id=? AND status='active' AND current_period_end > ? ORDER BY current_period_end DESC LIMIT 1",
      args: [req.user.id, t],
    });
    const s = rows.rows[0];
    if (!s) return null;
    await tx.execute({
      sql: "UPDATE subscriptions SET cancel_at_period_end=?, updated_at=? WHERE id=?",
      args: [cancel ? 1 : 0, t, Number(s.id)],
    });
    return { ...s, cancel_at_period_end: cancel ? 1 : 0 };
  });
  if (!result) return res.status(404).json({ error: "no_active_subscription", message: "No active subscription to cancel." });
  res.json({ subscription: serializeSubscription(result) });
});

/**
 * Track a generation for plan-limit accounting.
 *
 * Trial rule: every account that has no ACTIVE subscription gets a lifetime
 * allowance of TRIAL_GENERATION_LIMIT generations (5). After that, generation
 * is refused with { allowed:false, trial:true, code:"trial_exhausted" } until
 * the user subscribes to any plan (Free $2-equivalent and up).
 *
 * Paid subscriptions are rate-limited per day according to the plan catalogue
 * (Free: 100/day, Pro: 200/day, Premium: unlimited).
 */
billingRouter.post("/usage", requireClientHeader, async (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  if (!req.user) {
    return res.json({ plan: "free", limit: TRIAL_GENERATION_LIMIT, used: null, anonymous: true, trialLimit: TRIAL_GENERATION_LIMIT });
  }
  const { plan, subscription } = await resolveEffectivePlan(req.user.id);
  const hasPaidSubscription = Boolean(
    subscription && subscription.status === "active" && subscription.currentPeriodEnd > now(),
  );

  if (!hasPaidSubscription) {
    // Lifetime trial — atomic cap-check against usage_lifetime.
    const result = await withTransaction(async (tx) => {
      await tx.execute({ sql: "INSERT INTO usage_lifetime (user_id, count) VALUES (?,0) ON CONFLICT(user_id) DO NOTHING", args: [req.user.id] });
      const cur = await tx.execute({ sql: "SELECT count FROM usage_lifetime WHERE user_id=?", args: [req.user.id] });
      const usedLifetime = Number(cur.rows[0]?.count ?? 0);
      if (usedLifetime >= TRIAL_GENERATION_LIMIT) {
        return { allowed: false, used: usedLifetime, limit: TRIAL_GENERATION_LIMIT, trial: true, code: "trial_exhausted" };
      }
      await tx.execute({ sql: "UPDATE usage_lifetime SET count=count+1 WHERE user_id=?", args: [req.user.id] });
      return { allowed: true, used: usedLifetime + 1, limit: TRIAL_GENERATION_LIMIT, trial: true };
    });
    return res.json({ plan: "free", unlimited: false, ...result });
  }

  const limit = PLANS[plan].generationsPerDay;
  if (limit === Infinity) {
    await db.execute({ sql: "INSERT INTO usage_counters (user_id, day, count) VALUES (?,?,1) ON CONFLICT(user_id, day) DO UPDATE SET count=count+1", args: [req.user.id, day] });
    return res.json({ plan, limit: null, unlimited: true, used: null });
  }
  // Atomic increment with cap check.
  const result = await withTransaction(async (tx) => {
    await tx.execute({ sql: "INSERT INTO usage_counters (user_id, day, count) VALUES (?,?,0) ON CONFLICT(user_id, day) DO NOTHING", args: [req.user.id, day] });
    const cur = await tx.execute({ sql: "SELECT count FROM usage_counters WHERE user_id=? AND day=?", args: [req.user.id, day] });
    const used = Number(cur.rows[0]?.count ?? 0);
    if (used >= limit) return { allowed: false, used, limit, trial: false };
    await tx.execute({ sql: "UPDATE usage_counters SET count=count+1 WHERE user_id=? AND day=?", args: [req.user.id, day] });
    return { allowed: true, used: used + 1, limit, trial: false };
  });
  res.json({ plan, unlimited: false, ...result });
});
