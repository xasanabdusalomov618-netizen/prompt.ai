import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowLeft,
  ShieldCheck,
} from "lucide-react";
import { useApp } from "../context";
import { api, ApiError, formatSom, type PaymentRecord } from "../lib/api";

type Phase = "verifying" | "paid" | "pending" | "failed" | "notfound";

export default function PaymentReturn() {
  const { t, refreshAuth } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const uuid = params.get("payment") ?? "";
  const [phase, setPhase] = useState<Phase>("verifying");
  const [payment, setPayment] = useState<PaymentRecord | null>(null);
  const attempts = useRef(0);
  const stopped = useRef(false);

  const poll = useCallback(async () => {
    if (!uuid) {
      setPhase("notfound");
      return;
    }
    try {
      const d = await api.get<{ payment: PaymentRecord }>(`/api/billing/payments/${uuid}/status`);
      setPayment(d.payment);
      const st = d.payment.status;
      if (st === "paid") {
        stopped.current = true;
        setPhase("paid");
        refreshAuth();
        return;
      }
      if (st === "cancelled" || st === "failed" || st === "refunded") {
        stopped.current = true;
        setPhase("failed");
        return;
      }
      // created | prepared → keep waiting briefly
      attempts.current += 1;
      if (attempts.current >= 30) {
        stopped.current = true;
        setPhase("pending");
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        stopped.current = true;
        setPhase("notfound");
        return;
      }
      attempts.current += 1;
      if (attempts.current >= 30) {
        stopped.current = true;
        setPhase("pending");
      }
    }
  }, [uuid]);

  useEffect(() => {
    poll();
    const timer = setInterval(() => {
      if (!stopped.current) poll();
    }, 1500);
    return () => clearInterval(timer);
  }, [poll]);

  const refresh = () => {
    attempts.current = 0;
    stopped.current = false;
    setPhase("verifying");
    poll();
  };

  return (
    <div className="payment-return container">
      <div className={`return-card return-${phase}`}>
        {phase === "verifying" && (
          <>
            <div className="return-orb"><Loader2 size={40} className="spin" /></div>
            <h1>{t("verifying")}</h1>
            {payment && (
              <p className="return-amount">
                {payment.plan.toUpperCase()} · {formatSom(payment.amountUzs)}
              </p>
            )}
            <p className="muted">{t("paymentPendingText")}</p>
          </>
        )}
        {phase === "paid" && (
          <>
            <div className="return-orb ok"><CheckCircle2 size={44} /></div>
            <h1>{t("paymentConfirmed")}</h1>
            <p>{t("paymentActivated")}</p>
            {payment && (
              <p className="return-amount">
                {payment.plan.toUpperCase()} · {formatSom(payment.amountUzs)}
                {payment.mode === "sandbox" && <span className="mode-badge test">{t("testMode")}</span>}
              </p>
            )}
            <button className="btn btn-primary" onClick={() => navigate("/dashboard")}>
              {t("goToDashboard")}
            </button>
          </>
        )}
        {phase === "pending" && (
          <>
            <div className="return-orb pending"><Clock size={40} /></div>
            <h1>{t("paymentPending")}</h1>
            <p>{t("paymentPendingText")}</p>
            <div className="return-actions">
              <button className="btn btn-primary" onClick={refresh}>{t("refreshStatus")}</button>
              <button className="btn btn-secondary" onClick={() => navigate("/dashboard")}>{t("goToDashboard")}</button>
            </div>
          </>
        )}
        {phase === "failed" && (
          <>
            <div className="return-orb fail"><XCircle size={44} /></div>
            <h1>{t("paymentFailed")}</h1>
            <p>{t("paymentFailedText")}</p>
            <div className="return-actions">
              <Link className="btn btn-primary" to="/pricing">{t("tryAgain")}</Link>
              <button className="btn btn-secondary" onClick={() => navigate("/dashboard")}>{t("goToDashboard")}</button>
            </div>
          </>
        )}
        {phase === "notfound" && (
          <>
            <div className="return-orb fail"><XCircle size={44} /></div>
            <h1>{t("paymentNotFound")}</h1>
            <div className="return-actions">
              <Link className="btn btn-primary" to="/pricing">{t("backToPricing")}</Link>
            </div>
          </>
        )}
        <p className="return-secure">
          <ShieldCheck size={13} />
          {t("securePayments")}
        </p>
      </div>
    </div>
  );
}
