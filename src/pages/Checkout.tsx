import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import {
  Lock,
  ArrowLeft,
  ShieldCheck,
  Zap,
  Crown,
  Leaf,
  Loader2,
  AlertCircle,
  Info,
} from "lucide-react";
import { useApp } from "../context";
import {
  api,
  ApiError,
  formatSom,
  type CheckoutResponse,
  type PaymentProvider,
} from "../lib/api";

const PLAN_META = {
  free: { icon: <Leaf size={18} />, nameKey: "planFree" as const, monthly: 25000, yearly: 292000 as number | null },
  pro: { icon: <Zap size={18} />, nameKey: "planPro" as const, monthly: 38000, yearly: null },
  premium: { icon: <Crown size={18} />, nameKey: "planPremium" as const, monthly: 63000, yearly: null },
};

export default function Checkout() {
  const { t, user, plan: currentPlan, subscription, paymentMode, refreshAuth } = useApp();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const planParamRaw = params.get("plan");
  const planParam = planParamRaw === "premium" || planParamRaw === "free" ? planParamRaw : "pro";
  const billing = params.get("billing") === "yearly" ? "yearly" : "monthly";
  const [provider, setProvider] = useState<PaymentProvider>("click");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = PLAN_META[planParam];
  const yearlyAllowed = meta.yearly != null;
  const effectiveBilling = billing === "yearly" && yearlyAllowed ? "yearly" : "monthly";
  const amount = effectiveBilling === "monthly" ? meta.monthly : (meta.yearly as number);
  const yearlySaving = meta.yearly != null ? meta.monthly * 12 - meta.yearly : 0;
  const sandbox = paymentMode?.sandbox ?? false;
  const clickAvailable = sandbox || Boolean(paymentMode?.clickConfigured);
  const paymeAvailable = sandbox || Boolean(paymentMode?.paymeConfigured);
  const providerAvailable = provider === "click" ? clickAvailable : paymeAvailable;

  useEffect(() => {
    if (!clickAvailable && paymeAvailable) setProvider("payme");
    if (clickAvailable && !paymeAvailable) setProvider("click");
  }, [clickAvailable, paymeAvailable]);

  const planName = t(meta.nameKey);
  const isSamePlan = currentPlan === planParam;
  const sub = subscription;

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<CheckoutResponse>("/api/billing/checkout", {
        plan: planParam,
        billing: effectiveBilling,
        provider,
      });
      await refreshAuth();
      window.location.assign(res.checkoutUrl);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? e.message : t("genericAuthError"));
    }
  };

  return (
    <div className="checkout-page container">
      <Link to="/pricing" className="back-link">
        <ArrowLeft size={15} />
        {t("backToPricing")}
      </Link>
      <div className="checkout-head">
        <span className="eyebrow">{t("checkout").toUpperCase()}</span>
        <h1>{planParam === "free" ? t("choosePlanHeader") : t("orderSummary")}</h1>
      </div>

      {sandbox && (
        <div className="sandbox-banner compact" role="status">
          <Lock size={16} />
          <div>
            <strong>{t("sandboxBannerTitle")}</strong>
            <span>{t("sandboxBannerText")}</span>
          </div>
        </div>
      )}

      {!user ? (
        <div className="checkout-card auth-required">
          <Lock size={26} />
          <h2>{t("signInToContinue")}</h2>
          <p>{t("notLoggedIn")}</p>
          <button
            className="btn btn-primary"
            onClick={() =>
              navigate(`/login?next=${encodeURIComponent(`/checkout?plan=${planParam}&billing=${effectiveBilling}`)}`)
            }
          >
            {t("signIn")}
          </button>
        </div>
      ) : (
        <div className="checkout-grid">
          {/* Order summary */}
          <div className="checkout-card summary-card">
            <div className="summary-plan">
              <div className={`plan-icon plan-icon-${planParam}`}>{meta.icon}</div>
              <div>
                <span className="summary-label">{t("planLabel")}</span>
                <strong>{planName}</strong>
              </div>
            </div>

            <div className="billing-toggle small" role="tablist" aria-label={t("billingLabel")}>
              <button role="tab" aria-selected={effectiveBilling === "monthly"} className={effectiveBilling === "monthly" ? "active" : ""} onClick={() => setParams({ plan: planParam, billing: "monthly" })}>
                {t("monthly")}
              </button>
              {yearlyAllowed && (
                <button role="tab" aria-selected={effectiveBilling === "yearly"} className={effectiveBilling === "yearly" ? "active" : ""} onClick={() => setParams({ plan: planParam, billing: "yearly" })}>
                  {t("yearly")}
                  <em>{t("yearlySave")}</em>
                </button>
              )}
            </div>
            {!yearlyAllowed && billing === "yearly" && (
              <p className="summary-note muted">{t("yearlyOnlyNote")}</p>
            )}

            <dl className="summary-rows">
              <div className="summary-row">
                <dt>{t("planLabel")}</dt>
                <dd>{planName} — {effectiveBilling === "monthly" ? t("monthly") : t("yearly")}</dd>
              </div>
              {effectiveBilling === "yearly" && yearlySaving > 0 && (
                <div className="summary-row saving">
                  <dt>{t("yearlySave")}</dt>
                  <dd>−{formatSom(yearlySaving)}</dd>
                </div>
              )}
              <div className="summary-row total">
                <dt>{t("total")}</dt>
                <dd>
                  {formatSom(amount)}
                  <span className="summary-period">{effectiveBilling === "monthly" ? t("perMonth") : t("perYear")}</span>
                </dd>
              </div>
            </dl>

            {isSamePlan && sub?.status === "active" && (
              <p className="summary-note">
                <Info size={14} />
                {t("renewsOn")}: {new Date(sub.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
            <p className="summary-note muted">
              <ShieldCheck size={14} />
              {t("autoRenewNote")}
            </p>
          </div>

          {/* Payment method */}
          <div className="checkout-card pay-card">
            <h2>{t("paymentMethod")}</h2>
            <div className="provider-list" role="radiogroup" aria-label={t("paymentMethod")}>
              <button
                className={`provider-card ${provider === "click" ? "active" : ""}`}
                role="radio"
                aria-checked={provider === "click"}
                disabled={!clickAvailable}
                onClick={() => setProvider("click")}
              >
                <span className="provider-badge provider-click big">CLICK</span>
                <span className="provider-meta">
                  <strong>Click</strong>
                  <small>{t("clickDesc")}</small>
                </span>
                <span className="provider-radio" aria-hidden="true" />
              </button>
              <button
                className={`provider-card ${provider === "payme" ? "active" : ""}`}
                role="radio"
                aria-checked={provider === "payme"}
                disabled={!paymeAvailable}
                onClick={() => setProvider("payme")}
              >
                <span className="provider-badge provider-payme big">Payme</span>
                <span className="provider-meta">
                  <strong>Payme</strong>
                  <small>{t("paymeDesc")}</small>
                </span>
                <span className="provider-radio" aria-hidden="true" />
              </button>
            </div>

            {error && (
              <div className="form-error" role="alert">
                <AlertCircle size={16} />
                {error}
              </div>
            )}

            <button className="btn btn-primary pay-button" onClick={pay} disabled={busy || !providerAvailable}>
              {busy ? <Loader2 size={18} className="spin" /> : <Lock size={17} />}
              {t("payNow")}: {formatSom(amount)}
            </button>
            <p className="secure-note">
              <ShieldCheck size={14} />
              {t("secureCheckoutNote")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
