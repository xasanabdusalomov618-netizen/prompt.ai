/**
 * Admin panel API — statistics, users, payments, webhook log.
 *
 * Access model:
 *   - The whole router is DISABLED unless ADMIN_PASSWORD is set. Disabled
 *     state answers 404 so the panel's existence is never advertised.
 *   - Login compares the password in constant time (sha256 + timingSafeEqual)
 *     and is rate-limited (8 attempts / 10 min per IP).
 *   - The admin session is a random 256-bit token kept in an HttpOnly,
 *     SameSite=Lax cookie (Secure in production), valid 8 h. The token
 *     rotates on every server restart, invalidating outstanding sessions.
 *   - Every endpoint recomputes the numbers server-side; no secrets and no
 *     raw webhook payloads are returned.
 */
import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { db, now } from "../db.js";
import { config } from "../env.js";
import { requireClientHeader } from "../auth.js";

export const adminRouter = Router();

const ADMIN_COOKIE = "promptora_admin";
const ADMIN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
/** Rotates on restart → all admin sessions expire with the process. */
const sessionToken = crypto.randomBytes(32).toString("base64url");

const adminEnabled = () => Boolean(config.admin.password);

/** Length-independent constant-time comparison (hash both sides first). */
function timingSafeEq(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const adminCookie = () =>
  `${ADMIN_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ADMIN_TTL_MS / 1000)}${config.isProd ? "; Secure" : ""}`;

const notFound = (res) => res.status(404).json({ error: "not_found", message: "Unknown API endpoint." });

/** Middleware: enabled + valid admin cookie, no-store on success. */
function requireAdmin(req, res, next) {
  if (!adminEnabled()) return notFound(res);
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token || !timingSafeEq(token, sessionToken)) {
    return res.status(401).json({ error: "admin_auth_required", message: "Admin sign-in required." });
  }
  res.setHeader("Cache-Control", "no-store");
  next();
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_attempts", message: "Too many attempts. Try again in a few minutes." },
});

/** Capability probe: { enabled, authed } — safe to expose, no secrets. */
adminRouter.get("/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const authed =
    adminEnabled() && timingSafeEq(readCookie(req, ADMIN_COOKIE) ?? "", sessionToken);
  res.json({ enabled: adminEnabled(), authed });
});

adminRouter.post("/login", requireClientHeader, loginLimiter, (req, res) => {
  if (!adminEnabled()) return notFound(res);
  const given = String(req.body?.password ?? "");
  if (!given || !timingSafeEq(given, config.admin.password)) {
    return res.status(401).json({ error: "admin_wrong_password", message: "Wrong password." });
  }
  res.setHeader("Set-Cookie", adminCookie());
  res.json({ ok: true });
});

adminRouter.post("/logout", requireClientHeader, requireAdmin, (req, res) => {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.isProd ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});

/* ── helpers ─────────────────────────────────────────────────────────── */

const num = (v) => Number(v ?? 0);
const startOfTodayUtc = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const startOfMonthUtc = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const one = async (sql, args = []) => {
  const r = await db.execute({ sql, args });
  return r.rows[0] ?? {};
};
const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;

/* ── statistics ──────────────────────────────────────────────────────── */

adminRouter.get("/stats", requireAdmin, async (_req, res) => {
  const t = now();
  const day0 = startOfTodayUtc();
  const month0 = startOfMonthUtc();

  const [usersTotal, usersToday, usersMonth] = await Promise.all([
    one("SELECT COUNT(*) c FROM users"),
    one("SELECT COUNT(*) c FROM users WHERE created_at >= ?", [day0]),
    one("SELECT COUNT(*) c FROM users WHERE created_at >= ?", [month0]),
  ]);

  const userPlans = await rows("SELECT plan, COUNT(*) c FROM users GROUP BY plan");
  const activeSubs = await rows(
    "SELECT plan, COUNT(*) c FROM subscriptions WHERE status='active' AND current_period_end > ? GROUP BY plan",
    [t],
  );
  const yearlyActive = await one(
    "SELECT COUNT(*) c FROM subscriptions WHERE status='active' AND billing='yearly' AND current_period_end > ?",
    [t],
  );

  const paidMonth = await one(
    "SELECT COUNT(*) c, COALESCE(SUM(amount_uzs),0) s FROM payments WHERE status='paid' AND paid_at >= ?",
    [month0],
  );
  const monthByProvider = await rows(
    "SELECT provider, COUNT(*) c, COALESCE(SUM(amount_uzs),0) s FROM payments WHERE status='paid' AND paid_at >= ? GROUP BY provider",
    [month0],
  );
  const paidAll = await one(
    "SELECT COUNT(*) c, COALESCE(SUM(amount_uzs),0) s FROM payments WHERE status='paid'",
  );
  const byMode = await rows(
    "SELECT mode, COUNT(*) c, COALESCE(SUM(amount_uzs),0) s FROM payments WHERE status='paid' GROUP BY mode",
  );
  const trialDone = await one(
    `SELECT COUNT(*) c FROM usage_lifetime l
     WHERE l.count >= 5 AND NOT EXISTS (
       SELECT 1 FROM subscriptions s WHERE s.user_id = l.user_id
         AND s.status='active' AND s.current_period_end > ?)`,
    [t],
  );
  const pendingPayments = await one(
    "SELECT COUNT(*) c FROM payments WHERE status IN ('created','prepared')",
  );

  const modeRow = (m) => byMode.find((r) => String(r.mode) === m);
  const test = modeRow("sandbox");
  const live = modeRow("live");

  res.json({
    generatedAt: t,
    users: {
      total: num(usersTotal.c),
      today: num(usersToday.c),
      thisMonth: num(usersMonth.c),
      byPlan: Object.fromEntries(userPlans.map((r) => [String(r.plan), num(r.c)])),
    },
    subscriptions: {
      activeByPlan: Object.fromEntries(activeSubs.map((r) => [String(r.plan), num(r.c)])),
      activeTotal: activeSubs.reduce((a, r) => a + num(r.c), 0),
      yearly: num(yearlyActive.c),
      trialFinishedUnpaid: num(trialDone.c),
    },
    payments: {
      thisMonth: { count: num(paidMonth.c), sumUzs: num(paidMonth.s) },
      monthByProvider: Object.fromEntries(
        monthByProvider.map((r) => [String(r.provider), { count: num(r.c), sumUzs: num(r.s) }]),
      ),
      allTime: { count: num(paidAll.c), sumUzs: num(paidAll.s) },
      allTimeLive: { count: num(live?.c ?? 0), sumUzs: num(live?.s ?? 0) },
      allTimeTest: { count: num(test?.c ?? 0), sumUzs: num(test?.s ?? 0) },
      pending: num(pendingPayments.c),
    },
  });
});

/* ── users ───────────────────────────────────────────────────────────── */

adminRouter.get("/users", requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  const t = now();
  const day = new Date().toISOString().slice(0, 10);

  const where = q ? "WHERE u.email LIKE ? OR u.name LIKE ?" : "";
  const like = `%${q}%`;
  const args = q ? [like, like] : [];

  const total = await one(`SELECT COUNT(*) c FROM users u ${where}`, args);
  const list = await rows(
    `SELECT u.id, u.email, u.name, u.plan, u.created_at,
       (SELECT l.count FROM usage_lifetime l WHERE l.user_id = u.id) AS lifetime_used,
       (SELECT uc.count FROM usage_counters uc WHERE uc.user_id = u.id AND uc.day = ?) AS today_used,
       (SELECT MAX(p.paid_at) FROM payments p WHERE p.user_id = u.id AND p.status='paid') AS last_paid_at,
       (SELECT p.amount_uzs FROM payments p WHERE p.user_id = u.id AND p.status='paid'
          ORDER BY p.paid_at DESC LIMIT 1) AS last_paid_amount,
       EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id = u.id
         AND s.status='active' AND s.current_period_end > ?) AS has_active
     FROM users u ${where}
     ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    // Placeholder order follows the SQL text: the two correlated subquery
    // placeholders (day, now) appear before the WHERE/LIMIT ones.
    q ? [day, t, like, like, limit, offset] : [day, t, limit, offset],
  );

  res.json({
    total: num(total.c),
    users: list.map((r) => ({
      id: String(r.id),
      email: String(r.email),
      name: String(r.name ?? ""),
      plan: String(r.plan),
      createdAt: Number(r.created_at),
      lifetimeUsed: r.lifetime_used == null ? 0 : num(r.lifetime_used),
      todayUsed: r.today_used == null ? 0 : num(r.today_used),
      lastPaidAt: r.last_paid_at == null ? null : Number(r.last_paid_at),
      lastPaidAmount: r.last_paid_amount == null ? null : Number(r.last_paid_amount),
      hasActiveSubscription: num(r.has_active) === 1,
    })),
  });
});

/* ── payments ────────────────────────────────────────────────────────── */

adminRouter.get("/payments", requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  const where = q ? "WHERE u.email LIKE ? OR p.uuid LIKE ?" : "";
  const like = `%${q}%`;
  const args = q ? [like, like] : [];

  const total = await one(
    `SELECT COUNT(*) c FROM payments p LEFT JOIN users u ON u.id = p.user_id ${where}`,
    args,
  );
  const list = await rows(
    `SELECT p.uuid, p.plan, p.billing, p.amount_uzs, p.provider, p.status, p.mode,
            p.created_at, p.paid_at, u.email
     FROM payments p LEFT JOIN users u ON u.id = p.user_id ${where}
     ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  res.json({
    total: num(total.c),
    payments: list.map((r) => ({
      uuid: String(r.uuid),
      email: r.email ? String(r.email) : "—",
      plan: String(r.plan),
      billing: String(r.billing),
      amountUzs: num(r.amount_uzs),
      provider: String(r.provider),
      status: String(r.status),
      mode: String(r.mode),
      createdAt: Number(r.created_at),
      paidAt: r.paid_at == null ? null : Number(r.paid_at),
    })),
  });
});

/* ── webhook audit log (latest events, no payloads) ──────────────────── */

adminRouter.get("/webhooks", requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const list = await rows(
    "SELECT provider, event_type, result, created_at FROM webhook_events ORDER BY created_at DESC LIMIT ?",
    [limit],
  );
  res.json({
    events: list.map((r) => ({
      provider: String(r.provider),
      eventType: String(r.event_type ?? ""),
      result: String(r.result ?? "").slice(0, 200),
      createdAt: Number(r.created_at),
    })),
  });
});
