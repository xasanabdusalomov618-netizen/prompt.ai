import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { db, now } from "../db.js";
import { config, publicStatus } from "../env.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie, readSessionCookie, resolveSession,
  requireAuth, requireClientHeader, resolveEffectivePlan,
} from "../auth.js";
import { PLANS, TRIAL_GENERATION_LIMIT } from "../plans.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_attempts", message: "Too many attempts. Try again in a few minutes." },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = (v) => String(v ?? "").trim().toLowerCase().slice(0, 254);

function publicUser(u) {
  return {
    id: String(u.id),
    email: String(u.email),
    name: String(u.name),
    plan: String(u.plan),
    createdAt: u.created_at != null ? Number(u.created_at) : undefined,
  };
}

async function mePayload(userId) {
  const row = await db.execute({ sql: "SELECT id, email, name, plan, created_at FROM users WHERE id=?", args: [userId] });
  const u = row.rows[0];
  if (!u) return null;
  const { plan, subscription } = await resolveEffectivePlan(userId);
  const hasPaidSubscription = Boolean(
    subscription && subscription.status === "active" && subscription.currentPeriodEnd > now(),
  );
  const usage = await db.execute({
    sql: "SELECT count FROM usage_counters WHERE user_id=? AND day=?",
    args: [userId, new Date().toISOString().slice(0, 10)],
  });
  const generationsToday = Number(usage.rows[0]?.count ?? 0);
  const planDef = PLANS[plan] ?? PLANS.free;

  if (!hasPaidSubscription) {
    // Trial account — report lifetime trial consumption instead of daily quota.
    const lifetime = await db.execute({ sql: "SELECT count FROM usage_lifetime WHERE user_id=?", args: [userId] });
    const trialUsed = Number(lifetime.rows[0]?.count ?? 0);
    return {
      user: { ...publicUser(u), plan },
      subscription,
      usage: {
        day: new Date().toISOString().slice(0, 10),
        generationsToday,
        limit: TRIAL_GENERATION_LIMIT,
        unlimited: false,
        trial: true,
        trialLimit: TRIAL_GENERATION_LIMIT,
        trialUsed,
      },
      paymentMode: publicStatus(),
    };
  }
  return {
    user: { ...publicUser(u), plan },
    subscription,
    usage: {
      day: new Date().toISOString().slice(0, 10),
      generationsToday,
      limit: planDef.generationsPerDay === Infinity ? null : planDef.generationsPerDay,
      unlimited: planDef.generationsPerDay === Infinity,
      trial: false,
    },
    paymentMode: publicStatus(),
  };
}

authRouter.post("/register", requireClientHeader, async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password ?? "");
  if (!name) return res.status(400).json({ error: "invalid_name", message: "Please enter your name." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email", message: "Please enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "weak_password", message: "Password must be at least 8 characters." });
  if (password.length > 256) return res.status(400).json({ error: "weak_password", message: "Password is too long." });

  const existing = await db.execute({ sql: "SELECT id FROM users WHERE email=?", args: [email] });
  if (existing.rows.length) {
    return res.status(409).json({ error: "email_taken", message: "An account with this email already exists." });
  }
  const t = now();
  const id = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO users (id, email, name, password_hash, plan, created_at, updated_at) VALUES (?,?,?,?, 'free', ?, ?)",
    args: [id, email, name, hashPassword(password), t, t],
  });
  const token = await createSession(id);
  setSessionCookie(res, token);
  return res.status(201).json(await mePayload(id));
});

authRouter.post("/login", requireClientHeader, loginLimiter, async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password ?? "");
  const generic = { error: "invalid_credentials", message: "Invalid email or password." };
  if (!email || !password) return res.status(400).json(generic);
  const rows = await db.execute({ sql: "SELECT id, password_hash FROM users WHERE email=?", args: [email] });
  const u = rows.rows[0];
  // Always run a verification to reduce user-enumeration timing signal.
  const ok = u ? verifyPassword(password, String(u.password_hash)) : (verifyPassword(password, "scrypt:16384:8:1:" + "0".repeat(32) + ":" + "0".repeat(128)), false);
  if (!ok) return res.status(401).json(generic);
  const token = await createSession(String(u.id));
  setSessionCookie(res, token);
  return res.json(await mePayload(String(u.id)));
});

authRouter.post("/logout", requireClientHeader, async (req, res) => {
  await destroySession(readSessionCookie(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "auth_required" });
  const payload = await mePayload(req.user.id);
  if (!payload) return res.status(401).json({ error: "auth_required" });
  res.json(payload);
});
