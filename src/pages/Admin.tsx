import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ShieldCheck,
  ShieldOff,
  Lock,
  LogOut,
  Loader2,
  AlertCircle,
  Users,
  CreditCard,
  Activity,
  Search,
  Sparkles,
  Leaf,
  Zap,
  Crown,
  Webhook,
} from "lucide-react";
import { useApp } from "../context";
import { api, ApiError, formatSom, formatDate } from "../lib/api";

type AdminSession = { enabled: boolean; authed: boolean };

interface AdminStats {
  generatedAt: number;
  users: { total: number; today: number; thisMonth: number; byPlan: Record<string, number> };
  subscriptions: {
    activeByPlan: Record<string, number>;
    activeTotal: number;
    yearly: number;
    trialFinishedUnpaid: number;
  };
  payments: {
    thisMonth: { count: number; sumUzs: number };
    monthByProvider: Record<string, { count: number; sumUzs: number }>;
    allTime: { count: number; sumUzs: number };
    allTimeLive: { count: number; sumUzs: number };
    allTimeTest: { count: number; sumUzs: number };
    pending: number;
  };
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  plan: string;
  createdAt: number;
  lifetimeUsed: number;
  todayUsed: number;
  lastPaidAt: number | null;
  lastPaidAmount: number | null;
  hasActiveSubscription: boolean;
}

interface AdminPayment {
  uuid: string;
  email: string;
  plan: string;
  billing: string;
  amountUzs: number;
  provider: string;
  status: string;
  mode: string;
  createdAt: number;
  paidAt: number | null;
}

interface WebhookEvent {
  provider: string;
  eventType: string;
  result: string;
  createdAt: number;
}

const planIcon = (plan: string) =>
  plan === "premium" ? <Crown size={13} /> : plan === "pro" ? <Zap size={13} /> : <Leaf size={13} />;

export default function Admin() {
  const { t, lang, notify } = useApp();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [tab, setTab] = useState<"users" | "payments" | "webhooks">("users");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [usersTotal, setUsersTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [payments, setPayments] = useState<AdminPayment[] | null>(null);
  const [events, setEvents] = useState<WebhookEvent[] | null>(null);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api.get<AdminSession>("/api/admin/session"));
    } catch {
      setSession({ enabled: false, authed: false });
    }
  }, []);

  const loadAll = useCallback(async () => {
    const [s, u, p, w] = await Promise.allSettled([
      api.get<AdminStats>("/api/admin/stats"),
      api.get<{ total: number; users: AdminUser[] }>("/api/admin/users?limit=50"),
      api.get<{ total: number; payments: AdminPayment[] }>("/api/admin/payments?limit=50"),
      api.get<{ events: WebhookEvent[] }>("/api/admin/webhooks?limit=30"),
    ]);
    if (s.status === "fulfilled") setStats(s.value);
    if (u.status === "fulfilled") {
      setUsers(u.value.users);
      setUsersTotal(u.value.total);
    }
    if (p.status === "fulfilled") setPayments(p.value.payments);
    if (w.status === "fulfilled") setEvents(w.value.events);
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (session?.authed) loadAll();
  }, [session?.authed, loadAll]);

  // Debounced user search.
  useEffect(() => {
    if (!session?.authed || tab !== "users") return;
    const id = setTimeout(async () => {
      try {
        const q = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : "";
        const res = await api.get<{ total: number; users: AdminUser[] }>(`/api/admin/users?limit=50${q}`);
        setUsers(res.users);
        setUsersTotal(res.total);
      } catch {
        /* keep previous list */
      }
    }, 300);
    return () => clearTimeout(id);
  }, [query, tab, session?.authed]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/admin/login", { password });
      setPassword("");
      await loadSession();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "admin_wrong_password" ? t("adminWrongPassword") : t("adminWrongPassword"));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api.post("/api/admin/logout");
    } catch {
      /* ignore */
    }
    setStats(null);
    setUsers(null);
    setPayments(null);
    setEvents(null);
    await loadSession();
    notify(t("adminLogout"));
  };

  if (!session) {
    return (
      <div className="admin-page container">
        <div className="dash-loading"><Sparkles size={22} className="pulse" /></div>
      </div>
    );
  }

  /* ── disabled ── */
  if (!session.enabled) {
    return (
      <div className="admin-page container">
        <div className="checkout-card auth-required admin-login-card">
          <ShieldOff size={28} />
          <h1>{t("adminDisabledTitle")}</h1>
          <p>{t("adminDisabledHint")}</p>
          <pre className="admin-env-hint">ADMIN_PASSWORD=your-secret-password</pre>
          <Link to="/" className="btn btn-secondary">{t("home")}</Link>
        </div>
      </div>
    );
  }

  /* ── login ── */
  if (!session.authed) {
    return (
      <div className="admin-page container">
        <form className="checkout-card admin-login-card" onSubmit={login}>
          <Lock size={26} />
          <h1>{t("adminLoginTitle")}</h1>
          <p>{t("adminLoginHint")}</p>
          <label className="form-field">
            <span>{t("adminPassword")}</span>
            <div className="input-icon">
              <Lock size={16} />
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </label>
          {error && (
            <div className="form-error" role="alert">
              <AlertCircle size={16} />
              {error}
            </div>
          )}
          <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
            {busy && <Loader2 size={17} className="spin" />}
            {t("adminSignIn")}
          </button>
        </form>
      </div>
    );
  }

  const providerSplit = (obj: Record<string, { count: number; sumUzs: number }>) =>
    ["click", "payme"].filter((k) => obj[k]).map((k) => `${k === "click" ? "Click" : "Payme"} · ${obj[k].count}`).join("  ·  ");

  return (
    <div className="admin-page container">
      <div className="admin-head">
        <div>
          <span className="eyebrow">{t("adminTitle").toUpperCase()}</span>
          <h1>{t("adminTitle")}</h1>
          <p className="admin-sub">{t("adminSub")}</p>
        </div>
        <button className="btn btn-secondary admin-logout" onClick={logout}>
          <LogOut size={15} />
          {t("adminLogout")}
        </button>
      </div>

      {/* ── statistics ── */}
      {!stats ? (
        <div className="dash-loading small"><Sparkles size={20} className="pulse" /></div>
      ) : (
        <section className="admin-stats-grid">
          <div className="stat-card">
            <Users size={17} />
            <span className="stat-label">{t("statUsers")}</span>
            <strong>{stats.users.total}</strong>
            <small className="stat-hint">
              {t("statToday")}: +{stats.users.today} · {t("statThisMonth")}: +{stats.users.thisMonth}
            </small>
          </div>
          <div className="stat-card">
            <CreditCard size={17} />
            <span className="stat-label">{t("statRevenueMonth")}</span>
            <strong>{formatSom(stats.payments.thisMonth.sumUzs)}</strong>
            <small className="stat-hint">
              {stats.payments.thisMonth.count} {t("statPayments")}
              {providerSplit(stats.payments.monthByProvider) && ` · ${providerSplit(stats.payments.monthByProvider)}`}
            </small>
          </div>
          <div className="stat-card">
            <Activity size={17} />
            <span className="stat-label">{t("statActiveSubs")}</span>
            <strong>{stats.subscriptions.activeTotal}</strong>
            <small className="stat-hint">
              {["free", "pro", "premium"].filter((k) => stats.subscriptions.activeByPlan[k]).map((k) => `${k.toUpperCase()} ${stats.subscriptions.activeByPlan[k]}`).join(" · ") || t("adminEmpty")}
              {` · ${t("statYearlySubs")}: ${stats.subscriptions.yearly}`}
            </small>
          </div>
          <div className="stat-card">
            <ShieldCheck size={17} />
            <span className="stat-label">{t("statRevenueAll")}</span>
            <strong>{formatSom(stats.payments.allTime.sumUzs)}</strong>
            <small className="stat-hint">
              <span className="badge-live">{t("statLive")}</span> {formatSom(stats.payments.allTimeLive.sumUzs)}
              {" · "}
              <span className="badge-test">{t("statTest")}</span> {formatSom(stats.payments.allTimeTest.sumUzs)}
            </small>
          </div>
          <div className="stat-card">
            <Users size={17} />
            <span className="stat-label">{t("statTrialDone")}</span>
            <strong>{stats.subscriptions.trialFinishedUnpaid}</strong>
          </div>
          <div className="stat-card">
            <CreditCard size={17} />
            <span className="stat-label">{t("statPending")}</span>
            <strong>{stats.payments.pending}</strong>
          </div>
        </section>
      )}

      {/* ── tabs ── */}
      <div className="admin-tabs" role="tablist">
        {(["users", "payments", "webhooks"] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
          >
            {k === "users" ? t("tabUsers") : k === "payments" ? t("tabPayments") : t("tabWebhooks")}
          </button>
        ))}
      </div>

      {/* ── users ── */}
      {tab === "users" && (
        <section className="admin-section">
          <div className="admin-toolbar">
            <div className="admin-search">
              <Search size={15} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("adminSearch")}
                aria-label={t("adminSearch")}
              />
            </div>
            <span className="admin-count">{usersTotal}</span>
          </div>
          {users === null ? (
            <div className="dash-loading small"><Sparkles size={18} className="pulse" /></div>
          ) : users.length === 0 ? (
            <p className="admin-empty">{t("adminEmpty")}</p>
          ) : (
            <div className="history-scroll">
              <table className="history-table admin-table">
                <thead>
                  <tr>
                    <th>{t("adminColUser")}</th>
                    <th>{t("adminColPlan")}</th>
                    <th>{t("adminColStatus")}</th>
                    <th>{t("adminColUsed")}</th>
                    <th>{t("adminColLastPay")}</th>
                    <th>{t("adminColJoined")}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td data-label={t("adminColUser")}>
                        <strong>{u.name || "—"}</strong>
                        <span className="admin-email">{u.email}</span>
                      </td>
                      <td data-label={t("adminColPlan")}>
                        <span className={`admin-plan plan-${u.plan}`}>
                          {planIcon(u.plan)} {t(u.plan === "premium" ? "planPremium" : u.plan === "pro" ? "planPro" : "planFree")}
                        </span>
                      </td>
                      <td data-label={t("adminColStatus")}>
                        <span className={`status-pill ${u.hasActiveSubscription ? "ok" : "neutral"}`}>
                          {u.hasActiveSubscription ? t("adminStatusActive") : t("adminStatusFree")}
                        </span>
                      </td>
                      <td data-label={t("adminColUsed")}>
                        {u.todayUsed} · Σ {u.lifetimeUsed}
                      </td>
                      <td data-label={t("adminColLastPay")}>
                        {u.lastPaidAt
                          ? <>
                              {formatSom(u.lastPaidAmount ?? 0)}
                              <span className="admin-email">{formatDate(u.lastPaidAt, lang)}</span>
                            </>
                          : t("adminNever")}
                      </td>
                      <td data-label={t("adminColJoined")}>{formatDate(u.createdAt, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── payments ── */}
      {tab === "payments" && (
        <section className="admin-section">
          {payments === null ? (
            <div className="dash-loading small"><Sparkles size={18} className="pulse" /></div>
          ) : payments.length === 0 ? (
            <p className="admin-empty">{t("adminEmpty")}</p>
          ) : (
            <div className="history-scroll">
              <table className="history-table admin-table">
                <thead>
                  <tr>
                    <th>{t("date")}</th>
                    <th>{t("adminColUser")}</th>
                    <th>{t("adminColPlan")}</th>
                    <th>{t("amount")}</th>
                    <th>{t("provider")}</th>
                    <th>{t("status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.uuid}>
                      <td data-label={t("date")}>{formatDate(p.createdAt, lang)}</td>
                      <td data-label={t("adminColUser")}>
                        <span className="admin-email">{p.email}</span>
                      </td>
                      <td data-label={t("adminColPlan")}>
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
                        <span className={`badge-mode ${p.mode === "sandbox" ? "badge-test" : "badge-live"}`}>
                          {p.mode === "sandbox" ? t("statTest") : t("statLive")}
                        </span>
                        <span className={`status-dot status-${p.status}`}>
                          {t(
                            p.status === "paid" ? "statusPaid"
                            : p.status === "created" ? "statusCreated"
                            : p.status === "prepared" ? "statusPrepared"
                            : p.status === "cancelled" ? "statusCancelled"
                            : p.status === "refunded" ? "statusRefunded"
                            : "statusFailed",
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ── webhook log ── */}
      {tab === "webhooks" && (
        <section className="admin-section">
          {events === null ? (
            <div className="dash-loading small"><Sparkles size={18} className="pulse" /></div>
          ) : events.length === 0 ? (
            <p className="admin-empty">{t("adminEmpty")}</p>
          ) : (
            <ul className="admin-webhooks">
              {events.map((e, i) => (
                <li key={i}>
                  <Webhook size={14} />
                  <span className="admin-wh-provider">{e.provider}</span>
                  <span className="admin-wh-type">{e.eventType}</span>
                  <span className="admin-wh-result">{e.result}</span>
                  <time>{new Date(e.createdAt).toLocaleString()}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
