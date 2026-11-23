# Promptora AI — Prompts, Plans & Payments (Click + Payme)

A premium, responsive AI **prompt** generator and discovery site, upgraded with a
**real payment and subscription backend** for the Uzbek market:

- **Click** (https://click.uz) — web checkout + signed SHOP-API server callbacks
- **Payme** (https://payme.uz) — web checkout + JSON-RPC 2.0 Merchant API endpoint

Three plans: **Free** (25 000 so'm/mo — or yearly 292 000 so'm; 100 generations/day, 100 saves), **Pro** (38 000 so'm/mo, 200 generations/day, Ultra HD),
**Premium** (unlimited everything). Payments activate subscriptions **only after a
cryptographically verified provider callback** — never on button clicks, never with
card data touching our servers.

> **No live merchant credentials yet?** The app auto-engages a clearly-marked
> **SANDBOX / TEST mode**: the complete provider protocols (Click MD5-signed
> Prepare/Complete, Payme JSON-RPC with Basic auth) run end-to-end against this
> codebase, payments are permanently flagged `mode='sandbox'`, and every surface
> in the UI shows a TEST badge. Set the merchant environment variables below to
> accept real money — nothing else needs to change.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional — sandbox works with zero config
npm run build             # TypeScript check + optimized build
npm start                 # serves API + frontend on http://localhost:8787
```

Development with hot reload (Vite on :5173, API on :8787 proxied under /api):

```bash
npm run dev:api           # terminal 1 — API + DB on :8787
npm run dev               # terminal 2 — Vite dev server on :5173
```

Open `http://localhost:5173` — sign up (or sign in), go to **Pricing**, pick Pro or
Premium, choose Click or Payme:

- **Sandbox mode (default with no keys):** you land on a clearly-marked
  *TEST CHECKOUT* page. One click replays the provider's real signed
  server-to-server flow — subscription activates, dashboard updates.
- **Live mode (keys set):** you are redirected to Click's / Payme's real hosted
  checkout. After payment the provider calls our webhook; we verify the
  signature/auth, activate the subscription, and the return page confirms it.

## What was built

### Frontend (existing site, design preserved)
- New routes: `/pricing` `/checkout` `/payment/sandbox` `/payment/return` `/dashboard` `/login` `/signup`
- Navbar: **Pricing** link + account button (avatar, plan dot). Footer: pricing/account links + payment security strip.
- **Pricing**: Free 25 000 so'm/mo (or **292 000 so'm/yr ≈ $23** — yearly billing is offered on the Free plan only), Pro 38 000 so'm/mo, Premium 63 000 so'm/mo. Cards show live server prices, sandbox banner, trust strip.
- **Google sign-in / sign-up**: "Continue with Google" on `/login` & `/signup` when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set (OAuth 2.0 authorization-code flow, state-cookie CSRF protection, email-verified check, automatic account linking by verified email). Without credentials the button is hidden — never a fake OAuth.
- **5-generation trial**: every account gets 5 lifetime free generations; after that the paywall ("Free trial finished") points to `/pricing`. Subscribing to ANY plan (Free $2-equivalent and up) unlocks the plan's daily quota (Free 100/day, Pro 200/day, Premium unlimited).
- **Checkout**: order summary, Click/Payme provider selection, secure-redirect note, auth guard, error handling.
- **Dashboard**: current plan, status, expiry date with days-left progress bar, renew/upgrade/cancel-resume, usage meter, **payment history** with receipt modal (invoice id, provider transaction id), member-since and totals. Fully responsive (table → cards on mobile).
- **Generator**: trial-aware limits (unpaid accounts: 5 lifetime generations via `usage_lifetime`; paid plans: daily quota from the catalogue; anonymous: local 5/day counter), saved-prompt caps (trial 20, paid Free 100, Pro/Premium unlimited), tiered quality options with upgrade prompts.
- Uzbek / English / Russian translations for everything new. Dark/light themes untouched.

### Admin panel (`/admin`)
- Disabled unless `ADMIN_PASSWORD` is set (the API answers 404 so the panel is not advertised).
- Login (rate-limited, constant-time compare) issues an HttpOnly admin cookie valid 8 h; token rotates on restart.
- Shows: registered users (total/today/month), revenue this month with Click/Payme split, active subscriptions by plan (incl. yearly $23), all-time revenue separated **live vs TEST**, finished unpaid trials, pending payments; user table with search (plan, status, usage, last payment), full payment history and the webhook audit log.

### Backend (`server/`, Express + libsql/SQLite)
| File | Purpose |
|---|---|
| `env.js` | All config & secrets, sandbox auto-detection |
| `db.js` | Schema: `users`, `sessions`, `subscriptions`, `payments`, `payme_transactions`, `webhook_events`, `usage_counters`, `usage_lifetime` + automatic migrations for legacy databases (rebuilds CHECK constraints, adds `users.google_sub`) |
| `plans.js` | Server-authoritative catalogue & prices (so'm) — client never sets amounts |
| `auth.js` | scrypt password hashing, httpOnly session cookies (SHA-256 at rest), lazy plan expiry |
| `routes/auth.js` | register / login / logout / me (rate-limited) |
| `routes/admin.js` | Admin panel API: password login, stats aggregates, users/payments/webhook log (disabled without `ADMIN_PASSWORD`) |
| `routes/google.js` | "Continue with Google" OAuth 2.0 code flow + `/api/auth/oauth-config` capability probe |
| `routes/billing.js` | plans, checkout creation, payment status/history, subscription cancel/resume, usage metering |
| `routes/click.js` | **Click SHOP-API** Prepare/Complete with MD5 `sign_string` verification, idempotent replay, official error codes |
| `routes/payme.js` | **Payme Merchant API** JSON-RPC: CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction, CheckTransaction, GetStatement — HTTP Basic auth, tiyin amounts, 12 h timeout, full idempotency |
| `routes/sandbox.js` | Sandbox harness — dispatches signed test traffic through the real webhook code path. **404 in live mode** |
| `finalize.js` | The only place subscriptions get activated/revoked; atomic, idempotent, amount-checked |

### Payment flow (exactly what you asked for)
1. User selects a plan → `/checkout`
2. User selects **Click** or **Payme**
3. Click → redirect to `my.click.uz/services/pay?…` (hosted). Payme → redirect to `checkout.paycom.uz/<base64(m=…;ac.order_id=…;a=<tiyin>;c=<return>)>`
4. Provider processes the card payment on **their** PCI-DSS page — card numbers/CVV never touch this app
5. Provider calls our webhook server-to-server → we **verify** (Click MD5 / Payme Basic auth) → we check amount, order state, 12-hour timeout
6. On success the subscription activates **atomically** (renewals extend from the old end date; upgrades supersede)
7. Dashboard & payment history show the verified status (`paid`, provider tx id, TEST/LIVE badge); `/payment/return` polls and confirms

### Security
- No card data anywhere; redirects are SAQ-A style.
- Secrets only in env vars, never in frontend bundles or git (`.env` ignored, `.env.example` documents everything).
- Click: MD5 signature checked in constant time before any state change; `service_id`, amount and `merchant_prepare_id` validated; Prepare replay returns the same `merchant_prepare_id`; Complete replay returns `-4` and never re-extends.
- Payme: Basic auth (password = merchant key) constant-time; state machine 1 → 2 / −1 / −2 enforced; CreateTransaction idempotent by Payme id; competing active transaction → `-31008`; Perform idempotent; Cancel-after-Perform revokes the subscription and downgrades to Free.
- Duplicate processing prevented by DB uniqueness (`merchant_trans_id`, provider tx id) + transactions that re-check payment status inside one write tx.
- Subscriptions activate **only** from verified webhooks; the sandbox path uses the same verification code (with public sandbox keys), so tests are meaningful.
- Sessions: httpOnly + SameSite=Lax + Secure (prod), 30-day expiry, hashed at rest, CSRF client-header check on cookie-authenticated mutations, login rate-limiting.
- SQL: parameterised everywhere. Errors: generic 500s to clients, details logged server-side; webhook payloads mirrored into `webhook_events` for audit.

## Environment variables (see `.env.example`)

```bash
APP_URL=https://your-domain.vercel.app
DATABASE_URL=libsql://…turso.io          # required on Vercel (local file DB otherwise)
DATABASE_AUTH_TOKEN=…
CLICK_SERVICE_ID= CLICK_MERCHANT_ID= CLICK_SECRET_KEY=   # Merchant cabinet → service
PAYME_MERCHANT_ID= PAYME_MERCHANT_KEY=                   # Касса → Настройки
# PAYME_TEST_MODE=true + PAYME_TEST_KEY=… for admin.test.paycom.uz cashier
# PAYMENT_SANDBOX=true to force sandbox even with keys present
GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=                  # optional — enables "Continue with Google"
# Google redirect URI to register in the OAuth client:
#   https://your-domain/api/auth/google/callback
```

### Going live — Click
1. Sign up at merchant.click.uz, register your service (moderation required).
2. In the service settings set the **Prepare/Complete callback URL**: `https://your-domain/api/webhooks/click`
3. Copy `service_id`, `merchant_id`, `secret_key` (and user id if shown) into env vars.
4. (Recommended) Set `CLICK_ALLOWED_IPS` to Click's callback IPs.

### Going live — Payme
1. Create a cashbox at merchant.paycom.uz (or admin.test.paycom.uz for tests).
2. In cashbox settings set the **Merchant API endpoint**: `https://your-domain/api/webhooks/payme` and the account field **`order_id`**.
3. Copy `merchant_id` and the key (test key for test cabinet) into env vars.
4. `PAYME_TEST_MODE=true` routes to `test.paycom.uz`; leave unset/`false` for production.

## Deploy to Vercel

`vercel.json` is included: `npm run build` → `dist/` static + `api/[...slug].js`
catch-all serverless function wrapping the Express app (all `/api/*` behavior
identical to the standalone server). Set the env vars in Project Settings.

**Database persistence on Vercel is mandatory** — serverless filesystems are
ephemeral. Create a free [Turso](https://turso.tech) database (libsql — same
dialect) and set `DATABASE_URL`/`DATABASE_AUTH_TOKEN`. Without them the app boots
with a loud warning and data will not survive invocations.

## API reference (all JSON, same-origin)

```
GET  /api/health                            → { ok, sandbox }
POST /api/auth/register|login|logout        (cookie session; x-promptora-client: 1)
GET  /api/auth/me                           → user, subscription, usage, paymentMode
GET  /api/billing/plans                     → public plan catalogue + sandbox flag
POST /api/billing/checkout                  → { payment, checkoutUrl } (auth)
GET  /api/billing/payments                  → my payment history (auth)
GET  /api/billing/payments/:uuid/status     → polling endpoint (auth)
GET  /api/billing/subscription              → current plan + history (auth)
POST /api/billing/subscription/cancel       → { cancel: bool } (auth)
POST /api/billing/usage                     → generation metering (auth optional)
POST /api/webhooks/click                    → Click SHOP-API (form-urlencoded)
POST /api/webhooks/payme                    → Payme JSON-RPC merchant endpoint
POST /api/sandbox/run                       → sandbox harness (404 outside sandbox mode)
```

## Tests

```bash
npx playwright install chromium   # UI e2e (Chromium required)
npm test
```

Backend flows were verified end-to-end during development (register → checkout →
signed Click Prepare/Complete and full Payme CheckPerform→Create→Perform cycle →
activation → dashboard → cancel/refund revocation), including replay attacks,
forged signatures, amount tampering and double-processing guards.

## Notes & limitations

- The prompt generator is a local template builder (no LLM call) — that is the
  site's original design and remains unchanged; plan gating is enforced for
  signed-in users against server-side counters and for guests locally.
- Expiry is applied lazily on read (no cron required).
- Homepage statistics are illustrative. Photos and illustrations are inspiration
  previews, not guaranteed outputs.
- Uzbekistan fiscal-receipt (KKM/OFD) integration is out of scope; it can be added
  behind `server/integrations` when needed.
