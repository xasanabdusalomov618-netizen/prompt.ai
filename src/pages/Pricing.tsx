import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Sparkles,
  ShieldCheck,
  Zap,
  Crown,
  Leaf,
  Lock,
} from "lucide-react";
import { useApp } from "../context";
import { api, formatSom } from "../lib/api";

type Billing = "monthly" | "yearly";

export default function Pricing() {
  const { t, plan, paymentMode, user } = useApp();
  const [billing, setBilling] = useState<Billing>("monthly");
  const [sandbox, setSandbox] = useState<boolean>(false);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .get<{ payments: { sandbox: boolean } }>("/api/billing/plans")
      .then((d) => setSandbox(Boolean(d?.payments?.sandbox)))
      .catch(() => setSandbox(paymentMode?.sandbox ?? false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plans = [
    {
      id: "free" as const,
      tagline: t("freeTagline"),
      icon: <Leaf size={20} />,
      monthly: 0,
      yearly: 0,
      features: [t("feat_free_1"), t("feat_free_2"), t("feat_free_3"), t("feat_free_4")],
      cta: !user ? t("signUp") : plan === "free" ? t("currentPlan") : t("planFree"),
      highlight: false,
      isCurrent: plan === "free",
      disabled: Boolean(user) && plan === "free",
      action: () => navigate(user ? "/generator" : "/signup"),
    },
    {
      id: "pro" as const,
      tagline: t("proTagline"),
      icon: <Zap size={20} />,
      monthly: 49000,
      yearly: 470000,
      features: [t("feat_pro_1"), t("feat_pro_2"), t("feat_pro_3"), t("feat_pro_4"), t("feat_pro_5")],
      cta: plan === "pro" ? t("renewNow") : plan === "premium" ? t("included") : t("upgradeNow"),
      highlight: true,
      isCurrent: plan === "pro",
      disabled: plan === "premium",
      action: () => navigate(`/checkout?plan=pro&billing=${billing}`),
    },
    {
      id: "premium" as const,
      tagline: t("premiumTagline"),
      icon: <Crown size={20} />,
      monthly: 99000,
      yearly: 950000,
      features: [t("feat_premium_1"), t("feat_premium_2"), t("feat_premium_3"), t("feat_premium_4")],
      cta: plan === "premium" ? t("renewNow") : t("getPremium"),
      highlight: false,
      isCurrent: plan === "premium",
      disabled: false,
      action: () => navigate(`/checkout?plan=premium&billing=${billing}`),
    },
  ];

  return (
    <div className="pricing-page">
      <section className="container pricing-hero">
        <span className="eyebrow">{t("pricing").toUpperCase()}</span>
        <h1>{t("pricingTitle")}</h1>
        <p>{t("pricingSub")}</p>

        {sandbox && (
          <div className="sandbox-banner" role="status">
            <Lock size={18} />
            <div>
              <strong>{t("sandboxBannerTitle")}</strong>
              <span>{t("sandboxBannerText")}</span>
            </div>
          </div>
        )}

        <div className="billing-toggle" role="tablist" aria-label={t("billingLabel")}>
          <button
            role="tab"
            aria-selected={billing === "monthly"}
            className={billing === "monthly" ? "active" : ""}
            onClick={() => setBilling("monthly")}
          >
            {t("monthly")}
          </button>
          <button
            role="tab"
            aria-selected={billing === "yearly"}
            className={billing === "yearly" ? "active" : ""}
            onClick={() => setBilling("yearly")}
          >
            {t("yearly")}
            <em>{t("yearlySave")}</em>
          </button>
        </div>
      </section>

      <section className="container plan-grid" id="plans">
        {plans.map((p) => (
          <article
            key={p.id}
            className={`plan-card ${p.highlight ? "popular" : ""}`}
          >
            {p.highlight && <span className="plan-popular">{t("mostPopular")}</span>}
            {p.isCurrent && plan !== "free" && <span className="plan-current">{t("currentPlan")}</span>}
            <div className={`plan-icon plan-icon-${p.id}`}>{p.icon}</div>
            <h2>{t(p.id === "free" ? "planFree" : p.id === "pro" ? "planPro" : "planPremium")}</h2>
            <p className="plan-tagline">{p.tagline}</p>
            <div className="plan-price">
              <strong>{p.monthly === 0 ? "0" : formatSom(billing === "monthly" ? p.monthly : p.yearly).replace(" so'm", "")}</strong>
              {p.monthly > 0 && <span className="plan-currency">so'm</span>}
              {p.monthly === 0 && <span className="plan-currency">so'm</span>}
              <span className="plan-period">{p.monthly === 0 ? "" : billing === "monthly" ? t("perMonth") : t("perYear")}</span>
            </div>
            {p.monthly > 0 && billing === "yearly" && (
              <p className="plan-billed-note">≈ {formatSom(Math.round(p.yearly / 12))} {t("perMonth")}</p>
            )}
            <ul className="plan-features">
              {p.features.map((f, i) => (
                <li key={i}>
                  <Check size={15} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <button
              className={`btn ${p.highlight ? "btn-primary" : "btn-secondary"} plan-cta`}
              disabled={p.disabled}
              onClick={p.action}
            >
              {p.cta}
            </button>
          </article>
        ))}
      </section>

      <section className="container trust-strip">
        <div className="trust-payments">
          <span className="provider-badge provider-click">CLICK</span>
          <span className="provider-badge provider-payme">Payme</span>
        </div>
        <div className="trust-copy">
          <p>
            <ShieldCheck size={15} />
            {t("securePayments")}
          </p>
          <p className="muted">{t("autoRenewNote")}</p>
          <p className="muted">{t("vatNote")}</p>
        </div>
      </section>
    </div>
  );
}
