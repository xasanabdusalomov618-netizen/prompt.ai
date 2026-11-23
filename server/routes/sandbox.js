/**
 * SANDBOX / TEST harness.
 *
 * Exists ONLY when sandbox mode is engaged (no live merchant credentials).
 * It lets the site owner exercise the full payment pipeline end-to-end
 * without money: credentials are the well-known public sandbox values,
 * the requests replay Click's and Payme's real wire formats, and they are
 * dispatched through the SAME signed-webhook code paths as live traffic.
 * Payments created here carry mode='sandbox' forever and receipts are
 * marked TEST. In live mode this router is never mounted (404).
 */
import { Router } from "express";
import crypto from "node:crypto";
import { db } from "../db.js";
import { SANDBOX, sandboxMode, config } from "../env.js";
import { requireAuth, requireClientHeader } from "../auth.js";
import { clickRouter } from "./click.js";
import { paymeRouter } from "./payme.js";
import { toTiyin } from "../plans.js";

export const sandboxRouter = Router();

/** Dispatch a fake provider request through the real router stack. */
function dispatch(router, { headers = {}, body }) {
  return new Promise((resolve) => {
    const req = {
      method: "POST",
      url: router === clickRouter ? "/webhooks/click" : "/webhooks/payme",
      originalUrl: router === clickRouter ? "/api/webhooks/click" : "/api/webhooks/payme",
      headers: {
        "content-type":
          router === clickRouter
            ? "application/x-www-form-urlencoded"
            : "application/json",
        ...headers,
      },
      body,
      socket: { remoteAddress: "127.0.0.1" },
      query: {},
    };
    let statusCode = 200;
    let payload = { error: "no_response" };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve({ statusCode, payload });
    };
    const res = {
      status(code) { statusCode = code; return this; },
      json(obj) { payload = obj; finish(); return this; },
      send(obj) { payload = obj; finish(); return this; },
      setHeader() {}, getHeader() { return undefined; }, removeHeader() {},
      end() { finish(); return this; },
      statusCode: 200,
    };
    try {
      router.handle(req, res, () => finish());
    } catch (e) {
      payload = { error: "dispatch_failed", message: String(e?.message ?? e) };
      finish();
    }
  });
}

const md5hex = (s) => crypto.createHash("md5").update(String(s)).digest("hex");
const CLICK_PAY_URLS = (payment) => String(payment.uuid);

async function ownSandboxPayment(req) {
  const rows = await db.execute({
    sql: "SELECT * FROM payments WHERE uuid=?",
    args: [String(req.body?.paymentUuid ?? "")],
  });
  const p = rows.rows[0];
  if (!p) return { error: [404, { error: "not_found", message: "Payment not found." }] };
  if (String(p.user_id) !== req.user.id) return { error: [403, { error: "forbidden", message: "Not your payment." }] };
  if (String(p.mode) !== "sandbox") return { error: [400, { error: "not_sandbox", message: "This endpoint only works for sandbox payments." }] };
  return { payment: p };
}

sandboxRouter.post("/run", requireClientHeader, requireAuth, async (req, res) => {
  if (!sandboxMode()) return res.status(404).json({ error: "not_found" });

  const { payment, error } = await ownSandboxPayment(req);
  if (error) return res.status(error[0]).json(error[1]);

  const result = String(req.body?.result ?? "success"); // success | fail
  const ok = result === "success";
  const uuid = String(payment.uuid);
  const amountUzs = Number(payment.amount_uzs);
  const provider = String(payment.provider);
  const steps = [];

  if (provider === "click") {
    const secret = SANDBOX.click.serviceId && SANDBOX.click.secretKey;
    const clickTransId = String(Math.floor(1e9 + Math.random() * 9e9));
    const signTime = new Date().toISOString().slice(0, 19).replace("T", " ");
    const mk = (action, merchantPrepareId) => {
      const base =
        clickTransId +
        SANDBOX.click.serviceId +
        SANDBOX.click.secretKey +
        uuid +
        (action === 1 ? String(merchantPrepareId) : "") +
        `${amountUzs}.00` +
        String(action) +
        signTime;
      return {
        click_trans_id: clickTransId,
        service_id: SANDBOX.click.serviceId,
        click_paydoc_id: String(Math.floor(1e9 + Math.random() * 9e9)),
        merchant_trans_id: uuid,
        ...(action === 1 ? { merchant_prepare_id: String(merchantPrepareId) } : {}),
        amount: `${amountUzs}.00`,
        action: String(action),
        error: "0",
        error_note: "Success",
        sign_time: signTime,
        sign_string: md5hex(base),
      };
    };

    const prepare = await dispatch(clickRouter, { body: mk(0) });
    steps.push({ step: "Click → Prepare", response: prepare.payload });
    const prepareId = prepare.payload?.merchant_prepare_id;

    if (prepare.payload?.error === 0) {
      const completeBody = ok
        ? mk(1, prepareId)
        : { ...mk(1, prepareId), error: "-5017", error_note: "Sandbox test cancellation" };
      // re-sign after mutating error field? error is not part of the sign payload — safe.
      const complete = await dispatch(clickRouter, { body: completeBody });
      steps.push({ step: ok ? "Click → Complete" : "Click → Complete (cancelled)", response: complete.payload });
    }
    return res.json({ provider, sandbox: true, ok: steps.every((s) => s.response?.error === 0 || !ok), steps });
  }

  // Payme
  const basic = Buffer.from(`Paycom:${SANDBOX.payme.key}`).toString("base64");
  const headers = { authorization: `Basic ${basic}` };
  const rpc = (method, params) => ({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params });
  const orderId = uuid;
  const amount = toTiyin(amountUzs);
  const paymeId = crypto.randomBytes(12).toString("hex");
  const time = Date.now();

  const call = async (method, params) => {
    const out = await dispatch(paymeRouter, { headers, body: rpc(method, params) });
    steps.push({ step: `Payme → ${method}`, response: out.payload?.result ?? out.payload?.error });
    return out.payload;
  };

  const check = await call("CheckPerformTransaction", { amount, account: { order_id: orderId } });
  if (check?.result) {
    const created = await call("CreateTransaction", { id: paymeId, time, amount, account: { order_id: orderId } });
    if (created?.result) {
      if (ok) {
        await call("PerformTransaction", { id: paymeId });
      } else {
        await call("CancelTransaction", { id: paymeId, reason: 1 });
      }
    }
  }
  return res.json({ provider, sandbox: true, ok, steps });
});
