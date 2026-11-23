/**
 * Click (Uzbekistan) SHOP-API merchant endpoint.
 * Official protocol: Prepare (action=0) and Complete (action=1).
 * Every request is verified with Click's MD5 sign_string before any state
 * changes. Responses are HTTP 200 with Click's integer error codes.
 * Docs: https://docs.click.uz (Shop API)
 */
import { Router } from "express";
import crypto from "node:crypto";
import { db, now, withTransaction } from "../db.js";
import { config, providerCredentials, SANDBOX } from "../env.js";
import {
  activateSubscriptionForPayment,
  markPaymentFailed,
  logWebhook,
} from "../finalize.js";

export const clickRouter = Router();

const md5hex = (s) => crypto.createHash("md5").update(String(s)).digest("hex");
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
const amountsEqual = (sent, expected) => {
  const a = Number(parseFloat(String(sent)));
  const b = Number(expected);
  return Number.isFinite(a) && Math.round(a * 100) === Math.round(b * 100);
};
const respond = (res, obj) => res.status(200).json(obj);

async function findPaymentByMerchantTransId(id) {
  const rows = await db.execute({
    sql: "SELECT * FROM payments WHERE merchant_trans_id=?",
    args: [String(id)],
  });
  return rows.rows[0] ?? null;
}

/** Verification credentials are chosen by the payment's recorded mode. */
function credsFor(payment) {
  const live = providerCredentials("click");
  if (payment && String(payment.mode) === "sandbox") {
    return { serviceId: SANDBOX.click.serviceId, secretKey: SANDBOX.click.secretKey, sandbox: true };
  }
  if (live) return live;
  // Unknown payment: fall back to whatever is configured so sign check still runs.
  return null;
}

function verifySignature(body, creds, withPrepareId) {
  if (!creds) return false;
  const base =
    String(body.click_trans_id ?? "") +
    String(creds.serviceId) +
    String(creds.secretKey) +
    String(body.merchant_trans_id ?? "") +
    (withPrepareId ? String(body.merchant_prepare_id ?? "") : "") +
    String(body.amount ?? "") +
    String(body.action ?? "") +
    String(body.sign_time ?? "");
  return safeEqual(md5hex(base), String(body.sign_string ?? ""));
}

function optionalIpGuard(req, res) {
  const list = String(process.env.CLICK_ALLOWED_IPS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "")
    .split(",")[0].trim().replace(/^::ffff:/, "");
  if (list.includes(ip)) return true;
  res.status(403).json({ click_trans_id: null, merchant_trans_id: null, error: -8, error_note: "Forbidden" });
  return false;
}

clickRouter.post("/webhooks/click", async (req, res) => {
  if (!optionalIpGuard(req, res)) return;
  const b = req.body ?? {};
  const action = Number(b.action);
  const clickTransId = b.click_trans_id ?? null;
  const merchantTransId = b.merchant_trans_id ?? null;

  const required = ["click_trans_id", "service_id", "merchant_trans_id", "amount", "action", "sign_time", "sign_string"];
  for (const k of required) {
    if (b[k] === undefined || b[k] === null || String(b[k]).trim() === "") {
      await logWebhook("click", `action=${action}`, b, "missing_fields");
      return respond(res, { click_trans_id: clickTransId, merchant_trans_id: merchantTransId, error: -8, error_note: "Error in request from click" });
    }
  }

  const payment = await findPaymentByMerchantTransId(merchantTransId);
  const creds = credsFor(payment);
  const isComplete = action === 1;

  if (!verifySignature(b, creds, isComplete)) {
    await logWebhook("click", `action=${action}`, b, "sign_check_failed");
    return respond(res, { click_trans_id: clickTransId, merchant_trans_id: merchantTransId, error: -1, error_note: "SIGN CHECK FAILED" });
  }
  if (String(b.service_id) !== String(creds.serviceId)) {
    await logWebhook("click", `action=${action}`, b, "service_id_mismatch");
    return respond(res, { click_trans_id: clickTransId, merchant_trans_id: merchantTransId, error: -8, error_note: "Error in request from click" });
  }

  if (action === 0) return handlePrepare(res, b, payment);
  if (action === 1) return handleComplete(res, b, payment);
  await logWebhook("click", `action=${action}`, b, "unknown_action");
  return respond(res, { click_trans_id: clickTransId, merchant_trans_id: merchantTransId, error: -3, error_note: "Action not found" });
});

async function handlePrepare(res, b, payment) {
  const clickTransId = b.click_trans_id;
  const merchantTransId = b.merchant_trans_id;
  const fail = async (error, error_note, result) => {
    await logWebhook("click", "prepare", b, result);
    return respond(res, { click_trans_id: clickTransId, merchant_trans_id: merchantTransId, error, error_note });
  };

  if (!payment) return fail(-5, "User does not exist", "order_not_found");
  if (!amountsEqual(b.amount, payment.amount_uzs)) return fail(-2, "Incorrect amount", "amount_mismatch");

  const clickError = Number(b.error ?? 0);
  if (clickError !== 0) {
    await markPaymentFailed({ uuid: payment.uuid, status: "failed", providerPaymentId: String(clickTransId), errorNote: b.error_note || "Click reported an error" });
    return fail(-9, "Transaction cancelled", "click_error");
  }
  if (payment.status === "paid") return fail(-4, "Already paid", "already_paid");
  if (["cancelled", "failed", "refunded"].includes(payment.status)) return fail(-9, "Transaction cancelled", `payment_${payment.status}`);
  if (payment.provider_payment_id && String(payment.provider_payment_id) !== String(clickTransId)) {
    return fail(-6, "Transaction does not exist", "trans_id_mismatch");
  }

  const t = now();
  await withTransaction(async (tx) => {
    await tx.execute({
      sql: `UPDATE payments SET status='prepared', prepared_at=?, provider_payment_id=?, updated_at=?
            WHERE id=? AND status IN ('created','prepared')`,
      args: [t, String(clickTransId), t, Number(payment.id)],
    });
  });
  await logWebhook("click", "prepare", b, "ok");
  return respond(res, {
    click_trans_id: clickTransId,
    merchant_trans_id: merchantTransId,
    merchant_prepare_id: Number(payment.id),
    error: 0,
    error_note: "Success",
  });
}

async function handleComplete(res, b, payment) {
  const clickTransId = b.click_trans_id;
  const merchantTransId = b.merchant_trans_id;
  const fail = async (error, error_note, result) => {
    await logWebhook("click", "complete", b, result);
    return respond(res, { click_trans_id: clickTransId, merchant_trans_id: merchantTransId, error, error_note });
  };

  if (!payment) return fail(-5, "User does not exist", "order_not_found");
  if (!amountsEqual(b.amount, payment.amount_uzs)) return fail(-2, "Incorrect amount", "amount_mismatch");
  if (Number(b.merchant_prepare_id) !== Number(payment.id)) return fail(-6, "Transaction does not exist", "prepare_id_mismatch");
  if (payment.provider_payment_id && String(payment.provider_payment_id) !== String(clickTransId)) {
    return fail(-6, "Transaction does not exist", "trans_id_mismatch");
  }

  const clickError = Number(b.error ?? 0);
  if (clickError !== 0) {
    await markPaymentFailed({ uuid: payment.uuid, status: "cancelled", providerPaymentId: String(clickTransId), errorNote: b.error_note || "Click reported cancellation" });
    return fail(-9, "Transaction cancelled", "click_error");
  }

  if (payment.status === "paid") return fail(-4, "Already paid", "already_paid");
  if (payment.status === "created") return fail(-6, "Transaction does not exist", "complete_before_prepare");
  if (["cancelled", "failed", "refunded"].includes(payment.status)) return fail(-9, "Transaction cancelled", `payment_${payment.status}`);

  try {
    await activateSubscriptionForPayment({
      uuid: payment.uuid,
      provider: "click",
      providerPaymentId: String(clickTransId),
      expectedAmountUzs: payment.amount_uzs,
    });
  } catch (e) {
    if (e?.code === "AMOUNT_MISMATCH") return fail(-2, "Incorrect amount", "amount_mismatch");
    if (e?.code === "PAYMENT_NOT_OPEN") return fail(-9, "Transaction cancelled", "not_open");
    console.error("[click complete] activation failed:", e);
    return fail(-7, "Failed to update user", "activation_failed");
  }

  await logWebhook("click", "complete", b, "ok");
  return respond(res, {
    click_trans_id: clickTransId,
    merchant_trans_id: merchantTransId,
    merchant_confirm_id: Number(payment.id),
    merchant_prepare_id: Number(payment.id),
    error: 0,
    error_note: "Success",
  });
}
