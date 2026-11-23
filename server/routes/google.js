/**
 * "Continue with Google" — OAuth 2.0 Authorization Code flow.
 *
 * Enabled only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set
 * (Google Cloud Console → APIs & Services → Credentials → OAuth client,
 * type "Web application", authorised redirect URI:
 *   ${APP_URL}/api/auth/google/callback).
 *
 * Security properties:
 *   - `state` is a random 128-bit value stored in an HttpOnly, SameSite=Lax
 *     cookie and compared on callback (CSRF protection).
 *   - The ID token / access token never reaches the browser — we only use
 *     the access token server-side to call Google's userinfo endpoint.
 *   - The client secret is read only here, never shipped to the frontend.
 *   - No Google credentials are stored — we keep only `sub` (stable account
 *     id) and the verified email.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { db, now } from "../db.js";
import { config, googleConfigured } from "../env.js";
import { createSession } from "../auth.js";

export const googleRouter = Router();

const STATE_COOKIE = "promptora_oauth_state";
const NEXT_COOKIE = "promptora_oauth_next";
const isProd = config.isProd;

const cookie = (name, value, maxAge) =>
  [
    `${name}=${value}`,
    "Path=/api/auth/google",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(isProd ? ["Secure"] : []),
  ].join("; ");

const clearCookie = (name) =>
  `${name}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? "; Secure" : ""}`;

const redirectUri = () => `${config.appUrl.replace(/\/$/, "")}/api/auth/google/callback`;
const safeNext = (v) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v.slice(0, 200) : "/dashboard");

/** Public capabilities probe (never exposes ids or secrets). */
googleRouter.get("/oauth-config", (_req, res) => {
  res.json({ google: googleConfigured() });
});

const errorRedirect = (res, code) =>
  res.redirect(`/login?error=${encodeURIComponent(code)}`);

/** Step 1 — send the user to Google's consent screen. */
googleRouter.get("/google", (req, res) => {
  if (!googleConfigured()) {
    return res.redirect("/login?error=google_unavailable");
  }
  const next = safeNext(typeof req.query.next === "string" ? req.query.next : "/dashboard");
  const state = crypto.randomBytes(16).toString("base64url");
  res.setHeader("Set-Cookie", [cookie(STATE_COOKIE, state, 600), cookie(NEXT_COOKIE, next, 600)]);
  const q = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`);
});

/** Step 2 — Google redirects back; exchange the code and sign the user in. */
googleRouter.get("/google/callback", async (req, res) => {
  const done = (code) => {
    res.setHeader("Set-Cookie", [clearCookie(STATE_COOKIE), clearCookie(NEXT_COOKIE)]);
    return errorRedirect(res, code);
  };
  if (!googleConfigured()) return done("google_unavailable");

  const readCookie = (name) => {
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === name) return decodeURIComponent(rest.join("="));
    }
    return null;
  };

  const state = String(req.query.state ?? "");
  const expected = readCookie(STATE_COOKIE);
  if (!state || !expected || state.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
    return done("oauth_state");
  }
  const code = String(req.query.code ?? "");
  if (!code) return done("oauth_denied");
  const next = safeNext(readCookie(NEXT_COOKIE) ?? "/dashboard");

  try {
    // Exchange the authorization code for tokens (server-to-server).
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      console.error("[google-oauth] token exchange failed:", tokenRes.status);
      return done("google_failed");
    }
    const tokens = await tokenRes.json();
    const accessToken = tokens?.access_token;
    if (!accessToken) return done("google_failed");

    // Fetch the verified profile (avoids local JWT verification of id_token).
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!infoRes.ok) return done("google_failed");
    const info = await infoRes.json();
    const sub = String(info?.sub ?? "");
    const email = String(info?.email ?? "").trim().toLowerCase();
    const emailVerified = info?.email_verified === true || info?.email_verified === "true";
    const name = String(info?.name ?? "").trim().slice(0, 80) || email.split("@")[0] || "User";
    if (!sub || !email || !emailVerified) return done("google_email");

    const t = now();
    // 1) known Google account?
    let rows = await db.execute({ sql: "SELECT id FROM users WHERE google_sub=?", args: [sub] });
    let userId = rows.rows[0] ? String(rows.rows[0].id) : null;

    if (!userId) {
      // 2) existing email account → link Google to it
      rows = await db.execute({ sql: "SELECT id FROM users WHERE email=?", args: [email] });
      if (rows.rows[0]) {
        userId = String(rows.rows[0].id);
        await db.execute({
          sql: "UPDATE users SET google_sub=?, updated_at=? WHERE id=? AND google_sub IS NULL",
          args: [sub, t, userId],
        });
      } else {
        // 3) brand-new account — unusable random password, Google is the key.
        userId = crypto.randomUUID();
        await db.execute({
          sql: `INSERT INTO users (id, email, name, password_hash, google_sub, plan, created_at, updated_at)
                VALUES (?,?,?,?,?, 'free', ?, ?)`,
          args: [userId, email, name, `!google:${crypto.randomBytes(32).toString("hex")}`, sub, t, t],
        });
      }
    }

    const token = await createSession(userId);
    res.setHeader("Set-Cookie", [
      `${config.session.cookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.session.ttlMs / 1000)}${isProd ? "; Secure" : ""}`,
      clearCookie(STATE_COOKIE),
      clearCookie(NEXT_COOKIE),
    ]);
    return res.redirect(next);
  } catch (err) {
    console.error("[google-oauth] callback error:", err?.message);
    return done("google_failed");
  }
});
