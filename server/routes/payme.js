/**
 * Payme (Uzbekistan) Merchant API — JSON-RPC 2.0 over HTTPS.
 * Single endpoint. Payme/Play Market test & production cabinets both call it.
 * Auth: HTTP Basic — login "Paycom", password = merchant key
 *       (legacy login "<merchantId>" also accepted). Constant-time compare.
 * Amounts are in TIYIN. Times are unix millis. Transactions expire after
 * 12 hours (state 1 → auto-cancel with reason 4), per Payme protocol.
 * Responses are ALWAYS HTTP 200 with either {result: …} or {error: …}.
 * Docs: https://developer.payme.uz (Merchant API)
 */
import { Router } from "express";
import crypto from "node:crypto";
import { db, now, withTransaction } from "../db.js";
import { config, sandboxMode, SANDBOX } from "../env.js";
import {
  activateSubscriptionForPayment,
  revokeForPayment,
  logWebhook,
} from "../finalize.js";
import { toTiyin } from "../plans.js";

export const paymeRouter = Router();

const TX_TIMEOUT_MS = 12 * 60 * 60 * 1000;

const L = (ru, uz, en) => ({ ru, uz, en });
const ERR = {
  parse: { code: -32700, message: L("Ошибка разбора JSON", "JSON tahlil xatosi", "Parse error") },
  invalidRequest: { code: -32600, message: L("Неверный запрос", "Noto'g'ri so'rov", "Invalid request") },
  methodNotFound: { code: -32601, message: L("Метод не найден", "Metod topilmadi", "Method not found") },
  insufficient: { code: -32504, message: L("Недостаточно привилегий", "Ruxsat yetarli emas", "Insufficient privileges") },
  internal: { code: -32400, message: L("Внутренняя системная ошибка", "Ichki tizim xatosi", "Internal system error") },
  wrongAmount: { code: -31001, message: L("Неверная сумма", "Noto'g'ri summa", "Incorrect amount") },
  txNotFound: { code: -31003, message: L("Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found") },
  cannotOperate: { code: -31008, message: L("Невозможно выполнить операцию", "Amaliyotni bajarib bo'lmaydi", "Cannot perform this operation") },
  accountNotFound: { code: -31050, message: L("Заказ не найден", "Buyurtma topilmadi", "Order not found") },
};

function acceptedKeys() {
  if (sandboxMode() && !(config.payme.merchantId && (config.payme.key || config.payme.testKey))) {
    // No live credentials: only the well-known sandbox key is accepted.
    return [{ login: "Paycom", key: SANDBOX.payme.key }];
  }
  const keys = [];
  if (config.payme.key) keys.push({ login: "Paycom", key: config.payme.key });
  if (config.payme.testMode && config.payme.testKey) keys.push({ login: "Paycom", key: config.payme.testKey });
  return keys.length ? keys : [{ login: "Paycom", key: SANDBOX.payme.key }];
}

function authorized(req) {
  const header = String(req.headers.authorization ?? "");
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const login = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  for (const { login: l, key } of acceptedKeys()) {
    const lb = Buffer.from(login);
    const kb = Buffer.from(pass);
    const loginOk = lb.length === Buffer.from(l).length && crypto.timingSafeEqual(lb, Buffer.from(l));
    // Also accept legacy "<merchantId>" login when merchantId is set
    const legacyOk = config.payme.merchantId
      ? (lb.length === Buffer.from(config.payme.merchantId).length && crypto.timingSafeEqual(lb, Buffer.from(config.payme.merchantId)))
      : false;
    const keyBuf = Buffer.from(key);
    const keyOk = kb.length === keyBuf.length && crypto.timingSafeEqual(kb, keyBuf);
    if (keyOk && (loginOk || legacyOk)) return true;
  }
  return false;
}

const rpcResult = (res, id, result) => res.status(200).json({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (res, id, err) => res.status(200).json({ jsonrpc: "2.0", id: id ?? null, error: { code: err.code, message: err.message, data: err.data } });

async function findPaymentByOrderId(orderId, executor = db) {
  const rows = await executor.execute({ sql: "SELECT * FROM payments WHERE uuid=?", args: [String(orderId)] });
  return rows.rows[0] ?? null;
}
const paymeAccount = (p) => ({ order_id: String(p.uuid) });

async function getPaymeTx(txOrDb, id) {
  const rows = await txOrDb.execute({ sql: "SELECT * FROM payme_transactions WHERE payme_id=?", args: [String(id)] });
  return rows.rows[0] ?? null;
}

paymeRouter.post("/webhooks/payme", async (req, res) => {
  const id = req.body?.id ?? null;

  if (!authorized(req)) {
    await logWebhook("payme", String(req.body?.method ?? "unknown"), { id }, "insufficient_privileges");
    return rpcError(res, id, ERR.insufficient);
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(res, id, ERR.parse);
  const method = String(body.method ?? "");
  const params = body.params ?? {};

  try {
    switch (method) {
      case "CheckPerformTransaction": return await checkPerform(res, id, params);
      case "CreateTransaction": return await createTransaction(res, id, params);
      case "PerformTransaction": return await performTransaction(res, id, params);
      case "CancelTransaction": return await cancelTransaction(res, id, params);
      case "CheckTransaction": return await checkTransaction(res, id, params);
      case "GetStatement": return await getStatement(res, id, params);
      default:
        await logWebhook("payme", method, params, "method_not_found");
        return rpcError(res, id, ERR.methodNotFound);
    }
  } catch (e) {
    console.error("[payme] unexpected error in", method, e);
    await logWebhook("payme", method, params, `internal:${e?.message ?? e}`);
    return rpcError(res, id, ERR.internal);
  }
});

function requestedOrderId(params) {
  const acc = params?.account ?? {};
  return acc.order_id ?? acc.orderId ?? null;
}

async function checkPerform(res, id, params) {
  const orderId = requestedOrderId(params);
  const amount = Number(params?.amount);
  if (!orderId || !Number.isFinite(amount)) {
    return rpcError(res, id, { ...ERR.accountNotFound, data: "params.account.order_id and params.amount are required" });
  }
  const p = await findPaymentByOrderId(orderId);
  if (!p) {
    await logWebhook("payme", "CheckPerformTransaction", params, "order_not_found");
    return rpcError(res, id, ERR.accountNotFound);
  }
  if (amount !== toTiyin(Number(p.amount_uzs))) {
    return rpcError(res, id, ERR.wrongAmount);
  }
  if (!["created", "prepared"].includes(String(p.status))) {
    return rpcError(res, id, ERR.cannotOperate);
  }
  await logWebhook("payme", "CheckPerformTransaction", params, "ok");
  return rpcResult(res, id, { allow: true });
}

async function createTransaction(res, id, params) {
  const orderId = requestedOrderId(params);
  const amount = Number(params?.amount);
  const paymeId = params?.id != null ? String(params.id) : null;
  const time = Number(params?.time);
  if (!orderId || !Number.isFinite(amount) || !paymeId || !Number.isFinite(time)) {
    return rpcError(res, id, { ...ERR.invalidRequest, data: "id, time, amount and account.order_id are required" });
  }

  const t = now();
  const outcome = await withTransaction(async (tx) => {
    const p = await findPaymentByOrderId(orderId, tx);
    if (!p) return { error: ERR.accountNotFound, result: "order_not_found" };
    if (amount !== toTiyin(Number(p.amount_uzs))) return { error: ERR.wrongAmount, result: "amount_mismatch" };

    // Idempotency: same Payme transaction id → return stored state.
    const existing = await getPaymeTx(tx, paymeId);
    if (existing) {
      if (Number(existing.payment_id) !== Number(p.id)) return { error: ERR.cannotOperate, result: "id_conflict" };
      return {
        result: "ok_idempotent",
        payload: { create_time: Number(existing.create_time), transaction: Number(p.id), state: Number(existing.state) },
      };
    }

    // One ACTIVE transaction per order: cancel stale ones (>12h), else refuse.
    const actives = await tx.execute({
      sql: "SELECT * FROM payme_transactions WHERE payment_id=? AND state=1",
      args: [Number(p.id)],
    });
    for (const row of actives.rows) {
      const ct = Number(row.create_time);
      if (t - ct >= TX_TIMEOUT_MS) {
        await tx.execute({
          sql: "UPDATE payme_transactions SET state=-1, cancel_time=?, reason=4 WHERE id=?",
          args: [t, Number(row.id)],
        });
      } else {
        return { error: ERR.cannotOperate, result: "active_tx_exists" };
      }
    }

    if (!["created", "prepared"].includes(String(p.status))) {
      return { error: ERR.cannotOperate, result: `payment_${p.status}` };
    }

    await tx.execute({
      sql: `INSERT INTO payme_transactions
            (payme_id, payment_id, time, amount, account, state, create_time, raw, created_at)
            VALUES (?,?,?,?,?,1,?,?,?)`,
      args: [paymeId, Number(p.id), time, amount, JSON.stringify(paymeAccount(p)), time, JSON.stringify(params).slice(0, 2000), t],
    });
    await tx.execute({
      sql: "UPDATE payments SET status='prepared', prepared_at=?, provider_payment_id=COALESCE(provider_payment_id, ?), updated_at=? WHERE id=? AND status='created'",
      args: [t, paymeId, t, Number(p.id)],
    });
    return { result: "ok", payload: { create_time: time, transaction: Number(p.id), state: 1 } };
  });

  if (outcome.error) {
    await logWebhook("payme", "CreateTransaction", params, outcome.result);
    return rpcError(res, id, outcome.error);
  }
  await logWebhook("payme", "CreateTransaction", params, outcome.result);
  return rpcResult(res, id, outcome.payload);
}

async function performTransaction(res, id, params) {
  const paymeId = params?.id != null ? String(params.id) : null;
  if (!paymeId) return rpcError(res, id, { ...ERR.invalidRequest, data: "params.id is required" });
  const t = now();

  const txRow = await getPaymeTx(db, paymeId);
  if (!txRow) {
    await logWebhook("payme", "PerformTransaction", params, "tx_not_found");
    return rpcError(res, id, ERR.txNotFound);
  }
  const state = Number(txRow.state);
  if (state === 2) {
    return rpcResult(res, id, { transaction: Number(txRow.payment_id), perform_time: Number(txRow.perform_time), state: 2 });
  }
  if (state < 0) {
    await logWebhook("payme", "PerformTransaction", params, "tx_cancelled");
    return rpcError(res, id, ERR.cannotOperate);
  }
  if (t - Number(txRow.create_time) >= TX_TIMEOUT_MS) {
    await db.execute({
      sql: "UPDATE payme_transactions SET state=-1, cancel_time=?, reason=4 WHERE id=? AND state=1",
      args: [t, Number(txRow.id)],
    });
    await logWebhook("payme", "PerformTransaction", params, "tx_expired");
    return rpcError(res, id, ERR.cannotOperate);
  }

  const pay = await db.execute({ sql: "SELECT * FROM payments WHERE id=?", args: [Number(txRow.payment_id)] });
  const p = pay.rows[0];
  if (!p) return rpcError(res, id, ERR.internal);

  try {
    await activateSubscriptionForPayment({
      uuid: String(p.uuid),
      provider: "payme",
      providerPaymentId: paymeId,
      expectedAmountUzs: Number(p.amount_uzs),
    });
  } catch (e) {
    console.error("[payme] activation failed for", paymeId, e);
    await logWebhook("payme", "PerformTransaction", params, `activation_failed:${e?.message ?? e}`);
    return rpcError(res, id, ERR.internal);
  }

  await db.execute({
    sql: "UPDATE payme_transactions SET state=2, perform_time=?, raw=? WHERE id=? AND state=1",
    args: [t, JSON.stringify(params).slice(0, 2000), Number(txRow.id)],
  });
  await logWebhook("payme", "PerformTransaction", params, "ok");
  return rpcResult(res, id, { transaction: Number(txRow.payment_id), perform_time: t, state: 2 });
}

async function cancelTransaction(res, id, params) {
  const paymeId = params?.id != null ? String(params.id) : null;
  const reason = Number.isFinite(Number(params?.reason)) ? Number(params.reason) : null;
  if (!paymeId) return rpcError(res, id, { ...ERR.invalidRequest, data: "params.id is required" });
  const t = now();

  const txRow = await getPaymeTx(db, paymeId);
  if (!txRow) {
    await logWebhook("payme", "CancelTransaction", params, "tx_not_found");
    return rpcError(res, id, ERR.txNotFound);
  }
  const state = Number(txRow.state);
  if (state === -1 || state === -2) {
    return rpcResult(res, id, { transaction: Number(txRow.payment_id), cancel_time: Number(txRow.cancel_time), state });
  }

  const pay = await db.execute({ sql: "SELECT * FROM payments WHERE id=?", args: [Number(txRow.payment_id)] });
  const p = pay.rows[0];

  if (state === 1) {
    // Never performed → cancel cleanly.
    await withTransaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE payme_transactions SET state=-1, cancel_time=?, reason=? WHERE id=? AND state=1",
        args: [t, reason, Number(txRow.id)],
      });
      await tx.execute({
        sql: "UPDATE payments SET status='cancelled', error_note=?, updated_at=? WHERE id=? AND status NOT IN ('paid','refunded')",
        args: [`payme_cancel_reason_${reason ?? "unknown"}`, t, Number(txRow.payment_id)],
      });
    });
    await logWebhook("payme", "CancelTransaction", params, "ok_state_minus1");
    return rpcResult(res, id, { transaction: Number(txRow.payment_id), cancel_time: t, state: -1 });
  }

  // state === 2 → refund: revoke the subscription this payment activated.
  try {
    await revokeForPayment({
      uuid: String(p?.uuid ?? ""),
      providerPaymentId: paymeId,
      reason: `payme_cancel_reason_${reason ?? "unknown"}`,
    });
  } catch (e) {
    console.error("[payme] revoke failed for", paymeId, e);
    await logWebhook("payme", "CancelTransaction", params, `revoke_failed:${e?.message ?? e}`);
    return rpcError(res, id, ERR.internal);
  }
  await db.execute({
    sql: "UPDATE payme_transactions SET state=-2, cancel_time=?, reason=? WHERE id=? AND state=2",
    args: [t, reason, Number(txRow.id)],
  });
  await logWebhook("payme", "CancelTransaction", params, "ok_state_minus2");
  return rpcResult(res, id, { transaction: Number(txRow.payment_id), cancel_time: t, state: -2 });
}

async function checkTransaction(res, id, params) {
  const paymeId = params?.id != null ? String(params.id) : null;
  if (!paymeId) return rpcError(res, id, { ...ERR.invalidRequest, data: "params.id is required" });
  const txRow = await getPaymeTx(db, paymeId);
  if (!txRow) return rpcError(res, id, ERR.txNotFound);
  return rpcResult(res, id, {
    create_time: Number(txRow.create_time),
    perform_time: Number(txRow.perform_time),
    cancel_time: Number(txRow.cancel_time),
    transaction: Number(txRow.payment_id),
    state: Number(txRow.state),
    reason: txRow.reason == null ? null : Number(txRow.reason),
  });
}

async function getStatement(res, id, params) {
  const from = Number(params?.from);
  const to = Number(params?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return rpcError(res, id, { ...ERR.invalidRequest, data: "params.from and params.to (unix millis) are required" });
  }
  const rows = await db.execute({
    sql: "SELECT * FROM payme_transactions WHERE time BETWEEN ? AND ? ORDER BY time ASC LIMIT 1000",
    args: [from, to],
  });
  const transactions = rows.rows.map((r) => {
    let account = {};
    try { account = JSON.parse(String(r.account)); } catch { /* keep {} */ }
    return {
      id: String(r.payme_id),
      time: Number(r.time),
      amount: Number(r.amount),
      account,
      create_time: Number(r.create_time),
      perform_time: Number(r.perform_time),
      cancel_time: Number(r.cancel_time),
      transaction: Number(r.payment_id),
      state: Number(r.state),
      reason: r.reason == null ? null : Number(r.reason),
    };
  });
  return rpcResult(res, id, { transactions });
}
