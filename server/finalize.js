/**
 * Shared payment-finalisation logic.
 * Called ONLY after a provider callback has been cryptographically
 * verified (Click MD5 sign_string / Payme HTTP Basic + JSON-RPC state
 * machine). Never callable from the public internet without that proof.
 */
import { db, withTransaction, now } from "./db.js";
import { planPrice, periodMs } from "./plans.js";

export async function logWebhook(provider, eventType, payload, result) {
  try {
    let safe;
    try { safe = JSON.stringify(payload)?.slice(0, 8000); } catch { safe = String(payload).slice(0, 8000); }
    await db.execute({
      sql: "INSERT INTO webhook_events (provider, event_type, payload, result, created_at) VALUES (?,?,?,?,?)",
      args: [provider, String(eventType ?? ""), safe, String(result ?? "").slice(0, 500), now()],
    });
  } catch (e) {
    console.error("[webhook-log] failed:", e?.message);
  }
}

/**
 * Core activation, executed inside the caller's transaction so providers
 * can atomically couple it with their own bookkeeping rows.
 */
export async function activateWithTx(tx, { uuid, provider, providerPaymentId, expectedAmountUzs }) {
  const t = now();
  const found = await tx.execute({ sql: "SELECT * FROM payments WHERE uuid = ?", args: [uuid] });
  const p = found.rows[0];
  if (!p) {
    const err = new Error("payment_not_found");
    err.code = "PAYMENT_NOT_FOUND";
    throw err;
  }
  if (expectedAmountUzs != null && Number(p.amount_uzs) !== Number(expectedAmountUzs)) {
    const err = new Error("amount_mismatch");
    err.code = "AMOUNT_MISMATCH";
    throw err;
  }
  if (p.status === "paid") {
    const subs = await tx.execute({
      sql: "SELECT * FROM subscriptions WHERE last_payment_id = ? LIMIT 1",
      args: [Number(p.id)],
    });
    return {
      payment: serializePayment(p),
      subscription: subs.rows[0] ? serializeSubscription(subs.rows[0]) : null,
      alreadyPaid: true,
    };
  }
  if (p.status === "refunded" || p.status === "cancelled" || p.status === "failed") {
    const err = new Error(`payment_${p.status}`);
    err.code = "PAYMENT_NOT_OPEN";
    throw err;
  }

  const { amount } = planPrice(String(p.plan), String(p.billing));
  const billing = String(p.billing);
  const period = periodMs(billing);

  await tx.execute({
    sql: `UPDATE payments SET status='paid', paid_at=?,
          provider_payment_id=COALESCE(?, provider_payment_id),
          error_note=NULL, updated_at=? WHERE id=?`,
    args: [t, providerPaymentId ?? null, t, Number(p.id)],
  });

  await tx.execute({
    sql: "UPDATE subscriptions SET status='superseded', updated_at=? WHERE user_id=? AND status='active'",
    args: [t, String(p.user_id)],
  });

  // Renewal semantics: same plan still has time → extend from old end date.
  const ext = await tx.execute({
    sql: `SELECT MAX(current_period_end) AS end_of
          FROM subscriptions WHERE user_id=? AND status='superseded' AND plan=?`,
    args: [String(p.user_id), String(p.plan)],
  });
  const previousEnd = Number(ext.rows[0]?.end_of ?? 0) || 0;
  const start = Math.max(t, previousEnd);
  const end = start + period;

  const ins = await tx.execute({
    sql: `INSERT INTO subscriptions
          (user_id, plan, status, provider, billing, current_period_start, current_period_end,
           cancel_at_period_end, last_payment_id, mode, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`,
    args: [String(p.user_id), String(p.plan), "active", provider, billing, start, end, Number(p.id), String(p.mode), t, t],
  });
  const subscriptionId = Number(ins.lastInsertRowid);

  await tx.execute({ sql: "UPDATE users SET plan=?, updated_at=? WHERE id=?", args: [String(p.plan), t, String(p.user_id)] });

  return {
    alreadyPaid: false,
    payment: { ...serializePayment({ ...p, status: "paid", paid_at: t, provider_payment_id: providerPaymentId ?? p.provider_payment_id }), provider },
    subscription: {
      id: subscriptionId,
      userId: String(p.user_id),
      plan: String(p.plan),
      status: "active",
      provider,
      billing,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      mode: String(p.mode),
    },
  };
}

/** Standalone wrapper: one payment activated atomically. */
export async function activateSubscriptionForPayment(args) {
  return withTransaction((tx) => activateWithTx(tx, args));
}

export async function markPaymentFailed({ uuid, status, providerPaymentId, errorNote }) {
  const t = now();
  await db.execute({
    sql: `UPDATE payments SET status=?, error_note=?,
          provider_payment_id=COALESCE(?, provider_payment_id), updated_at=?
          WHERE uuid=? AND status NOT IN ('paid','refunded')`,
    args: [status, String(errorNote ?? "").slice(0, 300), providerPaymentId ?? null, t, uuid],
  });
}

/** Revoke a paid subscription after provider-confirmed cancellation/refund. */
export async function revokeForPayment({ uuid, providerPaymentId, reason }) {
  const t = now();
  return withTransaction(async (tx) => {
    const found = await tx.execute({ sql: "SELECT * FROM payments WHERE uuid=?", args: [uuid] });
    const p = found.rows[0];
    if (!p) return { ok: false, reason: "payment_not_found" };
    if (p.status === "refunded") return { ok: true, already: true };
    await tx.execute({
      sql: "UPDATE payments SET status='refunded', provider_payment_id=COALESCE(?, provider_payment_id), error_note=?, updated_at=? WHERE id=?",
      args: [providerPaymentId ?? null, String(reason ?? "cancelled_by_provider").slice(0, 300), t, Number(p.id)],
    });
    await tx.execute({
      sql: "UPDATE subscriptions SET status='canceled', current_period_end=?, updated_at=? WHERE last_payment_id=? AND status='active'",
      args: [t, t, Number(p.id)],
    });
    const other = await tx.execute({
      sql: "SELECT COUNT(*) AS c FROM subscriptions WHERE user_id=? AND status='active' AND current_period_end > ?",
      args: [String(p.user_id), t],
    });
    if (Number(other.rows[0]?.c ?? 0) === 0) {
      await tx.execute({ sql: "UPDATE users SET plan='free', updated_at=? WHERE id=?", args: [t, String(p.user_id)] });
    }
    return { ok: true };
  });
}

export function serializePayment(p) {
  return {
    id: Number(p.id),
    uuid: String(p.uuid),
    plan: String(p.plan),
    billing: String(p.billing),
    amountUzs: Number(p.amount_uzs),
    currency: String(p.currency ?? "UZS"),
    provider: String(p.provider),
    status: String(p.status),
    mode: String(p.mode),
    merchantTransId: String(p.merchant_trans_id),
    providerPaymentId: p.provider_payment_id ? String(p.provider_payment_id) : null,
    errorNote: p.error_note ? String(p.error_note) : null,
    createdAt: Number(p.created_at),
    paidAt: p.paid_at != null ? Number(p.paid_at) : null,
  };
}

export function serializeSubscription(s) {
  return {
    id: Number(s.id),
    plan: String(s.plan),
    status: String(s.status),
    provider: s.provider ? String(s.provider) : null,
    billing: String(s.billing),
    currentPeriodStart: Number(s.current_period_start),
    currentPeriodEnd: Number(s.current_period_end),
    cancelAtPeriodEnd: Number(s.cancel_at_period_end) === 1,
    mode: String(s.mode),
  };
}
