import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Sparkles, Loader2, AlertCircle, Mail, Lock, User } from "lucide-react";
import { GoogleIcon } from "./GoogleIcon";
import { useApp } from "../context";
import { api, ApiError, type MeResponse } from "../lib/api";

export default function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { t, user, refreshAuth, notify, oauth } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get("next") || "/dashboard";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLogin = mode === "login";

  // OAuth error reporting comes back as /login?error=<code>
  const oauthError = params.get("error");
  useEffect(() => {
    if (!oauthError) return;
    setError(
      oauthError === "google_unavailable" ? t("googleUnavailable")
      : oauthError === "oauth_state" ? t("oauthState")
      : oauthError === "google_email" ? t("googleEmailBlocked")
      : oauthError === "oauth_denied" ? t("googleDenied")
      : t("googleError"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthError]);

  useEffect(() => {
    if (user) navigate(next.startsWith("/") ? next : "/dashboard", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post<MeResponse>(
        isLogin ? "/api/auth/login" : "/api/auth/register",
        isLogin ? { email, password } : { name, email, password },
      );
      await refreshAuth();
      notify(isLogin ? t("welcomeBack") : t("accountCreated"));
      navigate(next.startsWith("/") ? next : "/dashboard", { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "email_taken") setError(t("emailTaken"));
        else if (e.code === "invalid_credentials") setError(t("invalidCredentials"));
        else if (e.code === "invalid_email") setError(t("invalidCredentials"));
        else if (e.code === "weak_password") setError(t("forgotHint"));
        else setError(e.message || t("genericAuthError"));
      } else {
        setError(t("genericAuthError"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-brand" aria-hidden="true">
        <div className="auth-brand-inner">
          <Link to="/" className="logo auth-logo">
            <span className="logo-icon"><Sparkles size={21} strokeWidth={1.8} /></span>
            <span>promptora<span className="logo-ai">AI</span></span>
          </Link>
          <h2>{isLogin ? t("welcomeBack") : t("createAccount")}</h2>
          <p>{isLogin ? t("authSub") : t("authSubSignup")}</p>
          <div className="auth-brand-art">
            <span /><span /><span />
          </div>
        </div>
      </div>

      <div className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <h1>{isLogin ? t("signIn") : t("signUp")}</h1>
          <p className="auth-sub">{isLogin ? t("authSub") : t("authSubSignup")}</p>

          {!isLogin && (
            <label className="form-field">
              <span>{t("fullName")}</span>
              <div className="input-icon">
                <User size={16} />
                <input
                  type="text"
                  autoComplete="name"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Aziz Karimov"
                />
              </div>
            </label>
          )}
          <label className="form-field">
            <span>{t("email")}</span>
            <div className="input-icon">
              <Mail size={16} />
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
          </label>
          <label className="form-field">
            <span>{t("password")}</span>
            <div className="input-icon">
              <Lock size={16} />
              <input
                type="password"
                autoComplete={isLogin ? "current-password" : "new-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            {!isLogin && <small className="field-hint">{t("forgotHint")}</small>}
          </label>

          {error && (
            <div className="form-error" role="alert">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
            {busy && <Loader2 size={17} className="spin" />}
            {isLogin ? t("signIn") : t("createAccount")}
          </button>

          {oauth?.google && (
            <>
              <div className="auth-divider" role="separator">
                <span>{t("orDivider")}</span>
              </div>
              <a
                className="btn btn-secondary auth-google-btn"
                href={`/api/auth/google?next=${encodeURIComponent(next)}`}
              >
                <GoogleIcon size={17} />
                {t("continueWithGoogle")}
              </a>
            </>
          )}

          <p className="auth-switch">
            {isLogin ? t("noAccount") : t("haveAccount")}{" "}
            <Link to={`${isLogin ? "/signup" : "/login"}?next=${encodeURIComponent(next)}`}>
              {isLogin ? t("signUp") : t("signIn")}
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
