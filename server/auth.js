/**
 * Authentication: email + password (scrypt), httpOnly session cookies.
 * Passwords are never stored in plain text; session tokens are stored
 * only as SHA-256 hashes. No card data ever touches this app.
 */
import crypto from "node:crypto";
import { config } from "./env.js";
import { db, withTransaction, now } from "./db.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    .toString("hex");
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, hash] = String(stored).split(":");
    if (scheme !== "scrypt") return false;
    const candidate = crypto.scryptSync(password, salt, Buffer.from(hash, "hex").length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function newUserId() {
  return crypto.randomUUID();
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const t = now();
  await db.execute({
    sql: "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
    args: [sha256(token), userId, t, t + config.session.ttlMs],
  });
  return token;
}

export async function destroySession(token) {
  if (!token) return;
  await db.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [sha256(token)] });
}

export async function resolveSession(token) {
  if (!token) return null;
  const t = now();
  const row = await db.execute({
    sql: `SELECT s.token_hash, s.expires_at, u.id, u.email, u.name, u.plan, u.created_at
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
    args: [sha256(token)],
  });
  const r = row.rows[0];
  if (!r) return null;
  if (Number(r.expires_at) <= t) {
    await destroySession(token);
    return null;
  }
  return {
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    plan: String(r.plan),
    createdAt: Number(r.created_at),
  };
}

/** Parse the session cookie without extra dependencies. */
export function readSessionCookie(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === config.session.cookie) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function setSessionCookie(res, token) {
  const parts = [
    `${config.session.cookie}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(config.session.ttlMs / 1000)}`,
  ];
  if (config.isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${config.session.cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

/** Express middleware — populates req.user when a valid session cookie exists. */
export async function attachUser(req, _res, next) {
  try {
    req.user = await resolveSession(readSessionCookie(req));
  } catch {
    req.user = null;
  }
  next();
}

/** Require an authenticated user. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "auth_required", message: "Please sign in to continue." });
  next();
}

/**
 * CSRF defence-in-depth for cookie-authenticated mutations:
 * same-origin SPA sends this header; cross-site forms cannot.
 */
export function requireClientHeader(req, res, next) {
  if (req.headers["x-promptora-client"] !== "1") {
    return res.status(403).json({ error: "bad_request", message: "Missing client header." });
  }
  next();
}

/** Subscription helpers — lazy expiry keeps state correct without a cron. */
export async function currentSubscription(userId) {
  const t = now();
  const rows = await db.execute({
    sql: `SELECT id, plan, status, provider, billing, current_period_start,
                 current_period_end, cancel_at_period_end, mode, created_at
          FROM subscriptions
          WHERE user_id = ?
          ORDER BY current_period_end DESC, id DESC`,
    args: [userId],
  });
  return rows.rows.map((r) => ({
    id: Number(r.id),
    plan: String(r.plan),
    status: String(r.status),
    provider: r.provider ? String(r.provider) : null,
    billing: String(r.billing),
    currentPeriodStart: Number(r.current_period_start),
    currentPeriodEnd: Number(r.current_period_end),
    cancelAtPeriodEnd: Number(r.cancel_at_period_end) === 1,
    mode: String(r.mode),
  }));
}

/**
 * Reconcile the user's effective plan with subscription reality.
 * ANY call path that mutates or reads entitlement state should go through
 * this so expiry is applied lazily and consistently.
 */
export async function resolveEffectivePlan(userId) {
  const t = now();
  const subs = await currentSubscription(userId);
  const active = subs.find((s) => s.status === "active");
  if (active && active.currentPeriodEnd > t) {
    return { plan: active.plan, subscription: active, subs };
  }
  if (active && active.currentPeriodEnd <= t) {
    await withTransaction(async (tx) => {
      await tx.execute({ sql: "UPDATE subscriptions SET status='expired', updated_at=? WHERE id=? AND status='active'", args: [t, active.id] });
      await tx.execute({ sql: "UPDATE users SET plan='free', updated_at=? WHERE id=?", args: [t, userId] });
    });
    const subs2 = await currentSubscription(userId);
    const expired = { ...active, status: "expired" };
    return { plan: "free", subscription: expired, subs: subs2.map(s => s.id === active.id ? expired : s) };
  }
  return { plan: "free", subscription: null, subs };
}
