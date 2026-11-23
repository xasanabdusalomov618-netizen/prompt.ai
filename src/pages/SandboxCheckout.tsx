import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import {
  FlaskConical,
  ShieldCheck,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Terminal,
  ChevronRight,
} from "lucide-react";
import { useApp } from "../context";
import { api, ApiError, formatSom, type PaymentRecord } from "../lib/api";

interface Step {
  step: string;
  response: unknown;
}

export default function SandboxCheckout() {
  const { t, refreshAuth } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const uuid = params.get("payment") ?? "";
  const [payment, setPayment] = useState<PaymentRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"success" | "fail" | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [outcome, setOutcome] = useState<"success" | "cancelled" | null>(null);

  useEffect(() => {
    if (!uuid) return;
    api.get<{ payment: PaymentRecord }>(`/api/billing/payments/${uuid}/status`)
      .then((d) => {
        setPayment(d.payment);
        if (d.payment.mode !== "sandbox") {
          navigate(`/payment/return?payment=${uuid}`, { replace: true });
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t("paymentNotFound")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid]);

  const run = async (result: "success" | "fail") => {
    setBusy(result);
    setError(null);
    setSteps(null);
    setOutcome(null);
    try {
      const res = await api.post<{ provider: string; ok: boolean; steps: Step[] }>(
        "/api/sandbox/run",
        { paymentUuid: uuid, result },
      );
      setSteps(res.steps);
      setOutcome(result === "success" ? "success" : "cancelled");
      await refreshAuth();
      const status = await api.get<{ payment: PaymentRecord }>(`/api/billing/payments/${uuid}/status`);
      setPayment(status.payment);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("genericAuthError"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sandbox-checkout container">
      <Link to="/pricing" className="back-link">
        <ArrowLeft size={15} />
        {t("backToPricing")}
      </Link>

      <div className="sandbox-shell">
        <div className="sandbox-header">
          <span className="sandbox-flask">
            <FlaskConical size={26} />
          </span>
          <div>
            <span className="eyebrow amber">{t("sandboxCheckoutTitle")}</span>
            <h1>{payment ? `${t("checkout")} · ${formatSom(payment.amountUzs)}` : t("checkout")}</h1>
          </div>
        </div>

        <p className="sandbox-text">{t("sandboxCheckoutText")}</p>

        {payment && (
          <div className="sandbox-summary">
            <div><span>{t("planLabel")}</span><strong>{payment.plan.toUpperCase()}</strong></div>
            <div><span>{t("billingLabel")}</span><strong>{payment.billing === "yearly" ? t("yearly") : t("monthly")}</strong></div>
            <div><span>{t("provider")}</span><strong>{payment.provider === "click" ? "Click" : "Payme"}</strong></div>
            <div><span>{t("amount")}</span><strong>{formatSom(payment.amountUzs)}</strong></div>
          </div>
        )}

        {error && <div className="form-error" role="alert">{error}</div>}

        {!outcome ? (
          <div className="sandbox-actions">
            <button className="btn btn-primary sandbox-run" disabled={busy !== null} onClick={() => run("success")}>
              {busy === "success" ? <Loader2 size={18} className="spin" /> : <CheckCircle2 size={18} />}
              {t("sandboxRunSuccess")}
            </button>
            <button className="btn btn-secondary sandbox-run" disabled={busy !== null} onClick={() => run("fail")}>
              {busy === "fail" ? <Loader2 size={18} className="spin" /> : <XCircle size={18} />}
              {t("sandboxRunFail")}
            </button>
          </div>
        ) : (
          <div className={`sandbox-result ${outcome}`}>
            {outcome === "success" ? <CheckCircle2 size={30} /> : <XCircle size={30} />}
            <div>
              <strong>{outcome === "success" ? t("sandboxSuccess") : t("sandboxCancelled")}</strong>
              <p>{t("sandboxHonesty")}</p>
              <div className="sandbox-result-actions">
                {outcome === "success" && (
                  <button className="btn btn-primary" onClick={() => navigate("/dashboard")}>
                    {t("goToDashboard")}
                    <ChevronRight size={16} />
                  </button>
                )}
                <button className="btn btn-secondary" onClick={() => { setOutcome(null); setSteps(null); }}>
                  {t("tryAgain")}
                </button>
              </div>
            </div>
          </div>
        )}

        {steps && (
          <div className="steps-log">
            <div className="steps-log-head">
              <Terminal size={15} />
              {t("sandboxSteps")}
            </div>
            {steps.map((s, i) => (
              <div key={i} className="steps-log-row">
                <span className="steps-log-step">{s.step}</span>
                <pre>{JSON.stringify(s.response, null, 2)}</pre>
              </div>
            ))}
          </div>
        )}

        <p className="sandbox-footer">
          <ShieldCheck size={14} />
          {t("sandboxHonesty")}
        </p>
      </div>
    </div>
  );
}
