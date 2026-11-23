import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  Zap,
  Crown,
  Leaf,
  LogOut,
  CalendarClock,
  Sparkles,
  Receipt,
  X,
  ShieldCheck,
  ArrowUpRight,
  RotateCcw,
  Ban,
  ChevronRight,
  AlertTriangle,
  FlaskConical,
} from "lucide-react";
import { useApp } from "../context";
import {
  api,
  ApiError,
  daysLeft,
  formatDate,
  formatSom,
  type PaymentRecord,
} from "../lib/api";

export default function Dashboard() {
  const { t, lang, user, subscription, plan, usage, paymentMode, authReady, logout, refreshAuth } = useApp();
  const navigate = useNavigate();
  const [payments, setPayments] = useState<PaymentRecord[] | null>(null);
  const [receipt, setReceipt] = useState<PaymentRecord | null>(null);
  const [cancelState, setCancelState] = useState<"idle" | "confirm" | "busy">("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const d = await api.get<{ payments: PaymentRecord[] }>("/api/billing/payments?limit=50");
      setPayments(d.payments);
    } catch {
      setPayments([]);
    }
  }, []);

  useEffect(() => {
    refreshAuth().finally(loadHistory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authReady && !user) navigate("/login?next=/dashboard", { replace: true });
  }, [authReady, user, navigate]);

  const paidTotal = useMemo(
    () => (payments ?? []).filter((p) => p.status === "paid").reduce((s, p) => s + p.amountUzs, 0),
    [payments],
  );

  if (!authReady || !user) {
    return (
      <div className="dashboard container">
        <div className="dash-loading"><Sparkles size={26} className="pulse" /></div>
      </div>
    );
  }

  const sub = subscription;
  const isPaidPlan = plan !== "free";
  const activePaid = sub?.status === "active" && sub.currentPeriodEnd > Date.now();
  const days = sub ? daysLeft(sub.currentPeriodEnd) : 0;
  const periodFraction = sub
    ? Math.min(1, Math.max(0, (sub.currentPeriodEnd - Date.now()) / Math.max(1, sub.currentPeriodEnd - sub.currentPeriodStart)))
    : 0;
  const isSandboxSub = sub?.mode === "sandbox" || paymentMode?.sandbox;

  const planIcon =
    plan === "premium" ? <Crown size={22} /> : plan === "pro" ? <Zap size={22} /> : <Leaf size={22} />;

  const toggleCancel = async (cancel: boolean) => {
    setCancelState("busy");
    setCancelError(null);
    try {
      await api.post("/api/billing/subscription/cancel", { cancel });
      await refreshAuth();
      setCancelState("idle");
    } catch (e) {
      setCancelError(e instanceof ApiError ? e.message : t("genericAuthError"));
      setCancelState("idle");
    }
  };

  const renewHref = `/checkout?plan=${isPaidPlan ? plan : "pro"}&billing=${sub?.billing ?? "monthly"}`;

  return (
    <div className="dashboard container">
      <div className="dash-top">
        <div>
          <span className="eyebrow">{t("account").toUpperCase()}</span>
          <h1>{t("dashboard")}</h1>
          <p className="dash-email">{user.email}</p>
        </div>
        <button
          className="btn btn-secondary dash-signout"
          onClick={async () => {
            await logout();
            navigate("/");
          }}
        >
          <LogOut size={16} />
          {t("signOut")}
        </button>
      </div>

      {isSandboxSub && (
        <div className="sandbox-banner compact" role="status">
          <FlaskConical size={16} />
          <div>
            <strong>{t("sandboxBannerTitle")}</strong>
            <span>{t("sandboxHonesty")}</span>
          </div>
        </div>
      )}

      <div className="dash-grid">
        {/* Current subscription */}
        <section className={`plan-hero plan-hero-${plan}`}>
          <div className="plan-hero-head">
            <div className={`plan-icon plan-icon-${plan} large`}>{planIcon}</div>
            <div>
              <span className="summary-label">{t("currentPlanLabel")}</span>
              <h2>
                {t(plan === "free" ? "planFree" : plan === "pro" ? "planPro" : "planPremium")}
                {isSandboxSub && <span className="mode-badge test">{t("testMode")}</span>}
              </h2>
            </div>
            <span className={`status-pill ${activePaid ? (sub?.cancelAtPeriodEnd ? "warn" : "ok") : plan === "free" ? "neutral" : "bad"}`}>
              {plan === "free"
                ? t("planFree")
                : sub?.cancelAtPeriodEnd
                  ? t("cancelAtPeriodEnd")
                  : activePaid
                    ? "Active"
                    : t("statusFailed")}
            </span>
          </div>

          {activePaid && sub ? (
            <>
              <div className="plan-hero-dates">
                <CalendarClock size={16} />
                <span>
                  {sub.cancelAtPeriodEnd ? t("cancelAtPeriodEndText") : `${t("expiresOn")}: ${formatDate(sub.currentPeriodEnd, lang)}`}
                </span>
                <strong className="days-left">{days} {t("daysLeft")}</strong>
              </div>
              <div className="days-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(periodFraction * 100)}%` }} />
              </div>
              <div className="plan-hero-meta">
                <span>{sub.provider === "click" ? "Click" : "Payme"}</span>
                <span>·</span>
                <span>{sub.billing === "yearly" ? t("yearly") : t("monthly")}</span>
                <span>·</span>
                <span>{sub.provider ? (sub.provider === "click" ? "CLICK" : "Payme") : ""}</span>
              </div>
            </>
          ) : (
            <p className="plan-hero-free-copy">{t("pricingSub")}</p>
          )}

          <div className="plan-hero-actions">
            {plan !== "premium" && (
              <button className="btn btn-primary" onClick={() => navigate("/pricing")}>
                <ArrowUpRight size={16} />
                {t("upgradeNow")}
              </button>
            )}
            {isPaidPlan && activePaid && (
              <button className="btn btn-secondary" onClick={() => navigate(renewHref)}>
                <RotateCcw size={16} />
                {t("renewNow")}
              </button>
            )}
            {activePaid && !sub?.cancelAtPeriodEnd && (
              <button className="btn btn-ghost-danger" onClick={() => setCancelState("confirm")}>
                <Ban size={16} />
                {t("cancelSubscription")}
              </button>
            )}
            {activePaid && sub?.cancelAtPeriodEnd && (
              <button className="btn btn-secondary" onClick={() => toggleCancel(false)} disabled={cancelState === "busy"}>
                {t("resumeSubscription")}
              </button>
            )}
          </div>
          {cancelError && <p className="form-error" role="alert">{cancelError}</p>}

          {cancelState === "confirm" && (
            <div className="cancel-confirm" role="dialog" aria-modal="true" aria-label={t("cancelConfirmTitle")}>
              <div className="cancel-confirm-card">
                <AlertTriangle size={22} />
                <h3>{t("cancelConfirmTitle")}</h3>
                <p>{t("cancelConfirmText")}</p>
                <div className="cancel-confirm-actions">
                  <button className="btn btn-ghost-danger" onClick={() => toggleCancel(true)}>
                    {t("cancelConfirm")}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setCancelState("idle")}>
                    {t("keepSubscription")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Stats */}
        <aside className="dash-stats">
          <div className="stat-card">
            <Sparkles size={17} />
            <span className="stat-label">{t("generationsLeft")}</span>
            <strong>
              {usage?.unlimited ? t("unlimited") : Math.max(0, (usage?.limit ?? 10) - (usage?.generationsToday ?? 0))}
            </strong>
          </div>
          <div className="stat-card">
            <CalendarClock size={17} />
            <span className="stat-label">{t("memberSince")}</span>
            <strong>{user.createdAt ? formatDate(user.createdAt, lang) : "—"}</strong>
          </div>
          <div className="stat-card">
            <Receipt size={17} />
            <span className="stat-label">{t("paymentHistory")}</span>
            <strong>{payments ? `${payments.length} · ${formatSom(paidTotal)}` : "—"}</strong>
          </div>
        </aside>
      </div>

      {/* Payment history */}
      <section className="history-card">
        <div className="history-head">
          <h2>{t("paymentHistory")}</h2>
        </div>
        {payments === null ? (
          <div className="dash-loading small"><Sparkles size={20} className="pulse" /></div>
        ) : payments.length === 0 ? (
          <div className="history-empty">
            <Receipt size={34} strokeWidth={1.3} />
            <p>{t("noPaymentsYet")}</p>
            <Link to="/pricing" className="btn btn-primary">
              {t("upgradeNow")}
              <ChevronRight size={15} />
            </Link>
          </div>
        ) : (
          <div className="history-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>{t("date")}</th>
                  <th>{t("planLabel")}</th>
                  <th>{t("amount")}</th>
                  <th>{t("provider")}</th>
                  <th>{t("status")}</th>
                  <th aria-label={t("receipt")} />
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.uuid}>
                    <td data-label={t("date")}>{formatDate(p.createdAt, lang)}</td>
                    <td data-label={t("planLabel")}>
                      {p.plan.toUpperCase()}
                      <span className="history-billing">{p.billing === "yearly" ? t("yearly") : t("monthly")}</span>
                    </td>
                    <td data-label={t("amount")}>{formatSom(p.amountUzs)}</td>
                    <td data-label={t("provider")}>
                      <span className={`provider-badge small ${p.provider === "click" ? "provider-click" : "provider-payme"}`}>
                        {p.provider === "click" ? "CLICK" : "Payme"}
                      </span>
                    </td>
                    <td data-label={t("status")}>
                      <span className={`status-dot status-${p.status}`}>
                        {t(
                          p.status === "paid"
                            ? "statusPaid"
                            : p.status === "created"
                              ? "statusCreated"
                              : p.status === "prepared"
                                ? "statusPrepared"
                                : p.status === "cancelled"
                                  ? "statusCancelled"
                                  : p.status === "failed"
                                    ? "statusFailed"
                                    : "statusRefunded",
                        )}
                      </span>
                      {p.mode === "sandbox" && <span className="mode-badge test">{t("testMode")}</span>}
                    </td>
                    <td>
                      <button className="icon-btn receipt-open" aria-label={t("receipt")} onClick={() => setReceipt(p)}>
                        <Receipt size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="dash-security">
        <ShieldCheck size={14} />
        {t("securePayments")}
      </p>

      {/* Receipt modal */}
      {receipt && (
        <div className="receipt-overlay" role="dialog" aria-modal="true" aria-label={t("receipt")} onClick={() => setReceipt(null)}>
          <div className="receipt-card" onClick={(e) => e.stopPropagation()}>
            <div className="receipt-head">
              <h3>{t("receipt")}</h3>
              <button className="icon-btn" onClick={() => setReceipt(null)} aria-label={t("close")}>
                <X size={17} />
              </button>
            </div>
            <dl className="receipt-rows">
              <div><dt>{t("invoiceId")}</dt><dd className="mono">{receipt.uuid}</dd></div>
              <div><dt>{t("planLabel")}</dt><dd>{receipt.plan.toUpperCase()} · {receipt.billing === "yearly" ? t("yearly") : t("monthly")}</dd></div>
              <div><dt>{t("amount")}</dt><dd>{formatSom(receipt.amountUzs)}</dd></div>
              <div><dt>{t("provider")}</dt><dd>{receipt.provider === "click" ? "Click" : "Payme"}</dd></div>
              {receipt.providerPaymentId && (
                <div><dt>{t("providerTx")}</dt><dd className="mono">{receipt.providerPaymentId}</dd></div>
              )}
              <div><dt>{t("status")}</dt><dd>{t(receipt.status === "paid" ? "statusPaid" : receipt.status === "cancelled" ? "statusCancelled" : receipt.status === "failed" ? "statusFailed" : receipt.status === "refunded" ? "statusRefunded" : "statusPending")}</dd></div>
              <div><dt>{t("date")}</dt><dd>{formatDate(receipt.paidAt ?? receipt.createdAt, lang)}</dd></div>
              <div><dt>Mode</dt><dd>{receipt.mode === "sandbox" ? t("testMode") : t("liveMode")}</dd></div>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
