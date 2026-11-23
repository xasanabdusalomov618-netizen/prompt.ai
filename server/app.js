/**
 * Express app factory — mounts the whole /api surface and, when a built
 * frontend exists, serves it as a static SPA with client-side routing.
 *
 * Used by:
 *   - server/index.js      (standalone Node server, local + VPS)
 *   - api/[...slug].js     (Vercel serverless function)
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, db } from "./db.js";
import { config, sandboxMode } from "./env.js";
import { attachUser } from "./auth.js";
import { authRouter } from "./routes/auth.js";
import { billingRouter } from "./routes/billing.js";
import { clickRouter } from "./routes/click.js";
import { paymeRouter } from "./routes/payme.js";
import { sandboxRouter } from "./routes/sandbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist");

export async function createApp() {
  await initDb();
  if (config.db.ephemeral) {
    console.warn(
      "[promptora] WARNING: DATABASE_URL is not set — using ephemeral /tmp-style storage. " +
        "Set DATABASE_URL (libsql://…) and DATABASE_AUTH_TOKEN for persistence on Vercel.",
    );
  }
  if (sandboxMode()) {
    console.warn("[promptora] PAYMENT SANDBOX MODE — no live merchant credentials detected. All payments are TEST-only.");
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Vercel/ proxies: needed for secure cookies + rate-limit IPs

  // Modest, non-breaking security headers (no frame denial — previews embed the site).
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  // Body parsing — Click posts form-urlencoded, Payme posts JSON-RPC.
  app.use("/api/webhooks/click", express.urlencoded({ extended: false, limit: "64kb" }));
  app.use("/api/webhooks/payme", express.json({ limit: "256kb" }));
  app.use(express.json({ limit: "128kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  app.use(attachUser);

  // Health check (no auth).
  app.get("/api/health", async (_req, res) => {
    try {
      await db.execute("SELECT 1");
      res.json({ ok: true, sandbox: sandboxMode() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use("/api/auth", authRouter);
  app.use("/api/billing", billingRouter);
  app.use("/api", clickRouter);
  app.use("/api", paymeRouter);
  // Sandbox harness — real verification code path, TEST-labelled, 404 in live mode.
  app.use("/api/sandbox", sandboxRouter);

  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found", message: "Unknown API endpoint." }));

  // Static frontend (production build).
  if (fs.existsSync(path.join(DIST, "index.html"))) {
    app.use(
      express.static(DIST, {
        index: "index.html",
        maxAge: "1h",
        setHeaders(res, file) {
          if (/\.(js|css|jpg|jpeg|png|webp|svg|woff2?)$/.test(file)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );
    // SPA fallback for client-side routes (anything not /api).
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(DIST, "index.html"));
    });
  }

  // Central error handler — never leak internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("[promptora] unhandled error:", err?.message);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message: "Something went wrong on our side." });
  });

  return app;
}
