/**
 * Centralised configuration. Secrets are read ONLY here, from environment
 * variables — never from frontend code, never committed to git.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Minimal .env loader (no dependency). Does NOT override real env vars.
(function loadDotEnv() {
  try {
    const file = path.join(ROOT, ".env");
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* .env is optional */
  }
})();

const bool = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
const clean = (v) => String(v ?? "").trim();

export const config = {
  env: clean(process.env.NODE_ENV) || "development",
  isProd: bool(process.env.VERCEL) || clean(process.env.NODE_ENV) === "production",
  port: Number(process.env.PORT) || 8787,
  appUrl: clean(process.env.APP_URL) || "http://localhost:8787",

  db: {
    // Local default: SQLite file via libsql. On Vercel set DATABASE_URL
    // (e.g. libsql://<db>.turso.io) and DATABASE_AUTH_TOKEN for persistence.
    url: clean(process.env.DATABASE_URL) || `file:${path.join(ROOT, "data", "promptora.db")}`,
    authToken: clean(process.env.DATABASE_AUTH_TOKEN) || undefined,
    ephemeral: !clean(process.env.DATABASE_URL) && bool(process.env.VERCEL),
  },

  session: {
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    cookie: "promptora_sid",
  },

  // Explicit kill-switch for testing. Default: sandbox auto-engages when no
  // live credentials are present.
  sandboxForced: bool(process.env.PAYMENT_SANDBOX),

  click: {
    serviceId: clean(process.env.CLICK_SERVICE_ID),
    merchantId: clean(process.env.CLICK_MERCHANT_ID),
    merchantUserId: clean(process.env.CLICK_MERCHANT_USER_ID),
    secretKey: clean(process.env.CLICK_SECRET_KEY),
    payBase: clean(process.env.CLICK_PAY_BASE) || "https://my.click.uz/services/pay",
  },

  payme: {
    merchantId: clean(process.env.PAYME_MERCHANT_ID),
    key: clean(process.env.PAYME_MERCHANT_KEY || process.env.PAYME_KEY),
    testKey: clean(process.env.PAYME_TEST_KEY),
    testMode: bool(process.env.PAYME_TEST_MODE),
    checkoutBase: clean(process.env.PAYME_CHECKOUT_BASE) || "https://checkout.paycom.uz",
    testCheckoutBase:
      clean(process.env.PAYME_TEST_CHECKOUT_BASE) || "https://test.paycom.uz",
  },

  // Google OAuth 2.0 (Sign in / Sign up with Google).
  // Create a Web application OAuth client at https://console.cloud.google.com
  // and register redirect URI:  ${APP_URL}/api/auth/google/callback
  google: {
    clientId: clean(process.env.GOOGLE_CLIENT_ID),
    clientSecret: clean(process.env.GOOGLE_CLIENT_SECRET),
  },

  // Admin panel (/admin). Disabled unless ADMIN_PASSWORD is set — the API
  // answers 404 so the panel's existence is not advertised when unused.
  admin: {
    password: clean(process.env.ADMIN_PASSWORD),
  },
};

/** Well-known public sandbox credentials. NOT secrets — used only in sandbox mode. */
export const SANDBOX = {
  click: { serviceId: "sandbox-service", secretKey: "sandbox-click-secret" },
  payme: { key: "sandbox-payme-key" },
};

export const clickConfigured = () =>
  Boolean(config.click.serviceId && config.click.merchantId && config.click.secretKey);

export const googleConfigured = () =>
  Boolean(config.google.clientId && config.google.clientSecret);

export const paymeConfigured = () =>
  Boolean(config.payme.merchantId && (config.payme.key || config.payme.testKey));

/** Global sandbox mode: forced by env, or auto when nothing is configured. */
export const sandboxMode = () =>
  config.sandboxForced || (!clickConfigured() && !paymeConfigured());

/**
 * Effective credentials for a provider. In sandbox mode we fall back to the
 * public well-known sandbox credentials so the full signed protocol can be
 * exercised without touching real money. Live mode NEVER falls back.
 */
export function providerCredentials(provider) {
  const sandbox = sandboxMode();
  if (provider === "click") {
    if (clickConfigured())
      return { ...config.click, sandbox: false, secretKey: config.click.secretKey };
    if (sandbox)
      return {
        ...config.click,
        serviceId: SANDBOX.click.serviceId,
        merchantId: "sandbox-merchant",
        secretKey: SANDBOX.click.secretKey,
        sandbox: true,
      };
    return null;
  }
  if (provider === "payme") {
    const key = config.payme.testMode ? config.payme.testKey || config.payme.key : config.payme.key || config.payme.testKey;
    if (paymeConfigured() && key)
      return {
        merchantId: config.payme.merchantId,
        key,
        checkoutBase: config.payme.testMode ? config.payme.testCheckoutBase : config.payme.checkoutBase,
        testMode: config.payme.testMode,
        sandbox: false,
      };
    if (sandbox)
      return {
        merchantId: "sandbox-payme-merchant",
        key: SANDBOX.payme.key,
        checkoutBase: "/payment/sandbox", // never reaches paycom.uz
        testMode: true,
        sandbox: true,
      };
    return null;
  }
  return null;
}

export function publicStatus() {
  return {
    sandbox: sandboxMode(),
    clickConfigured: clickConfigured(),
    paymeConfigured: paymeConfigured(),
    googleConfigured: googleConfigured(),
    paymeTestMode: config.payme.testMode,
    currency: "UZS",
    ephemeralDb: config.db.ephemeral,
  };
}
