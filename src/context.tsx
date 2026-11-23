import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { dictionaries, type Key, type Lang } from "./i18n";
import type { MediaType } from "./data";
import {
  api,
  ApiError,
  anonUsage,
  type MeResponse,
  type OauthConfig,
  type PaymentStatusInfo,
  type PlanId,
  type SessionUser,
  type SubscriptionInfo,
  type UsageInfo,
} from "./lib/api";
export interface SavedPrompt {
  id: string;
  title: string;
  prompt: string;
  type: MediaType;
  created: number;
}
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
export interface UpgradeState {
  open: boolean;
  reason?: "limit" | "saved";
}

interface AppState {
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: string;
  setTheme: (t: string) => void;
  t: (k: Key) => string;
  favorites: string[];
  toggleFavorite: (id: string) => void;
  saved: SavedPrompt[];
  savePrompt: (p: SavedPrompt) => void;
  removeSaved: (id: string) => void;
  resetFavorites: () => void;
  notify: (msg: string, error?: boolean) => void;
  copy: (s: string) => Promise<void>;
  /* ── account / subscription ─────────────────────────── */
  user: SessionUser | null;
  subscription: SubscriptionInfo | null;
  plan: PlanId;
  usage: UsageInfo | null;
  paymentMode: PaymentStatusInfo | null;
  oauth: OauthConfig | null;
  authReady: boolean;
  refreshAuth: () => Promise<void>;
  logout: () => Promise<void>;
  trackGeneration: () => Promise<boolean>;
  upgrade: UpgradeState;
  openUpgrade: (reason?: UpgradeState["reason"]) => void;
  closeUpgrade: () => void;
}
const Context = createContext<AppState>(null!);
export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const l = load<Lang>("promptora-language", "en");
    return ["en", "uz", "ru"].includes(l) ? l : "en";
  });
  const [theme, setTheme] = useState(() =>
    load<string>("promptora-theme", "dark") === "light" ? "light" : "dark",
  );
  const [favorites, setFavorites] = useState<string[]>(() => {
    const v = load<unknown>("promptora-favorites", []);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  });
  const [saved, setSaved] = useState<SavedPrompt[]>(() => {
    const v = load<unknown>("promptora-saved", []);
    return Array.isArray(v)
      ? v.filter(
          (x) => x && typeof x.prompt === "string" && typeof x.id === "string",
        )
      : [];
  });
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(
    null,
  );
  const [user, setUser] = useState<SessionUser | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentStatusInfo | null>(null);
  const [oauth, setOauth] = useState<OauthConfig | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradeState>({ open: false });
  const plan: PlanId = (user?.plan ?? "free") as PlanId;
  const openUpgrade = (reason: UpgradeState["reason"] = "limit") =>
    setUpgrade({ open: true, reason });
  const closeUpgrade = () => setUpgrade((u) => ({ ...u, open: false }));
  const refreshAuth = async () => {
    try {
      const me = await api.get<MeResponse>("/api/auth/me");
      setUser(me.user);
      setSubscription(me.subscription);
      setUsage(me.usage);
      setPaymentMode(me.paymentMode);
    } catch {
      setUser(null);
      setSubscription(null);
      setUsage(null);
      // Anonymous users still deserve an accurate sandbox banner —
      // the plans endpoint is public.
      try {
        const plans = await api.get<{ payments: PaymentStatusInfo }>("/api/billing/plans");
        setPaymentMode(plans.payments);
      } catch {
        setPaymentMode(null);
      }
    } finally {
      setAuthReady(true);
    }
  };
  useEffect(() => {
    refreshAuth();
    api
      .get<OauthConfig>("/api/auth/oauth-config")
      .then(setOauth)
      .catch(() => setOauth({ google: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {
      /* already gone */
    }
    setUser(null);
    setSubscription(null);
    setUsage(null);
  };
  const trackGeneration = async (): Promise<boolean> => {
    // Anonymous users: local daily counter, same free limit.
    if (!user) {
      if (anonUsage.read() >= 5) {
        openUpgrade("limit");
        return false;
      }
      anonUsage.bump();
      return true;
    }
    try {
      const res = await api.post<{
        plan: PlanId;
        unlimited: boolean;
        allowed?: boolean;
        used?: number;
        limit?: number | null;
      }>("/api/billing/usage");
      if (res.unlimited) return true;
      if (res.allowed === false) {
        openUpgrade("limit");
        refreshAuth();
        return false;
      }
      refreshAuth();
      return true;
    } catch (e) {
      // Fail-open on network errors for authed users but keep a local cap for free.
      if (plan === "free" && anonUsage.bump() > 5) {
        openUpgrade("limit");
        return false;
      }
      if (e instanceof ApiError && e.status === 401) return true;
      return true;
    }
  };
  const t = (k: Key) => dictionaries[lang][k];
  const notify = (msg: string, error = false) => setToast({ msg, error });
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("promptora-language", JSON.stringify(lang));
    } catch {
      notify(t("storageError"), true);
    }
  }, [lang]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("promptora-theme", JSON.stringify(theme));
    } catch {}
  }, [theme]);
  useEffect(() => {
    try {
      localStorage.setItem("promptora-favorites", JSON.stringify(favorites));
      localStorage.setItem("promptora-saved", JSON.stringify(saved));
    } catch {
      notify(t("favoritesError"), true);
    }
  }, [favorites, saved]);
  const toggleFavorite = (id: string) => {
    const exists = favorites.includes(id);
    setFavorites((prev) =>
      exists ? prev.filter((x) => x !== id) : [...prev, id],
    );
    notify(t(exists ? "removedToast" : "savedToast"));
  };
  const copy = async (s: string) => {
    try {
      if (!s.trim()) return;
      await navigator.clipboard.writeText(s);
      notify(t("copySuccess"));
    } catch {
      notify(t("copyError"), true);
    }
  };
  return (
    <Context.Provider
      value={{
        lang,
        setLang,
        theme,
        setTheme,
        t,
        favorites,
        toggleFavorite,
        saved,
        savePrompt: (p) => {
          const isPaidFree = plan === "free" && subscription?.status === "active";
          const cap = plan === "free" ? (isPaidFree ? 100 : 20) : Infinity;
          if (saved.length >= cap) {
            openUpgrade("saved");
            return;
          }
          setSaved((prev) => [p, ...prev]);
          notify(t("savedToast"));
        },
        removeSaved: (id) => {
          setSaved((prev) => prev.filter((x) => x.id !== id));
          notify(t("removedToast"));
        },
        resetFavorites: () => {
          setFavorites([]);
          setSaved([]);
          notify(t("resetSuccess"));
        },
        notify,
        copy,
        user,
        subscription,
        plan,
        usage,
        paymentMode,
        oauth,
        authReady,
        refreshAuth,
        logout,
        trackGeneration,
        upgrade,
        openUpgrade,
        closeUpgrade,
      }}
    >
      {children}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          <span>{toast.error ? "!" : "✓"}</span>
          {toast.msg}
          <button onClick={() => setToast(null)} aria-label={t("close")}>
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
export const useApp = () => useContext(Context);
