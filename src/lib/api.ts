/**
 * Typed API client for the Promptora backend.
 * Same-origin only — no secrets ever ship to the browser.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "x-promptora-client": "1",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(path, { ...options, headers, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "Network error — check your connection.");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const d = data as { error?: string; message?: string } | null;
    throw new ApiError(
      res.status,
      d?.error ?? "error",
      d?.message ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
};

/* ── Shared types ─────────────────────────────────────────────────────── */
export type PlanId = "free" | "pro" | "premium";
export type Billing = "monthly" | "yearly";
export type PaymentProvider = "click" | "payme";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  plan: PlanId;
  createdAt?: number;
}
export interface SubscriptionInfo {
  id: number;
  plan: string;
  status: "active" | "expired" | "canceled" | "superseded";
  provider: string | null;
  billing: Billing;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  mode: "live" | "sandbox";
}
export interface UsageInfo {
  day: string;
  generationsToday: number;
  limit: number | null;
  unlimited: boolean;
}
export interface PaymentStatusInfo {
  sandbox: boolean;
  clickConfigured: boolean;
  paymeConfigured: boolean;
  paymeTestMode: boolean;
  currency: string;
  ephemeralDb: boolean;
}
export interface MeResponse {
  user: SessionUser;
  subscription: SubscriptionInfo | null;
  usage: UsageInfo;
  paymentMode: PaymentStatusInfo;
}
export interface PaymentRecord {
  id: number;
  uuid: string;
  plan: string;
  billing: Billing;
  amountUzs: number;
  currency: string;
  provider: PaymentProvider;
  status: "created" | "prepared" | "paid" | "cancelled" | "failed" | "refunded";
  mode: "live" | "sandbox";
  merchantTransId: string;
  providerPaymentId: string | null;
  errorNote: string | null;
  createdAt: number;
  paidAt: number | null;
}
export interface CheckoutResponse {
  payment: { uuid: string; plan: PlanId; billing: Billing; amountUzs: number; provider: PaymentProvider; mode: "live" | "sandbox" };
  checkoutUrl: string;
  sandbox: boolean;
}

/* ── Formatting helpers ─────────────────────────────────────────────── */
const somFormatter = new Intl.NumberFormat("uz-UZ", { maximumFractionDigits: 0 });
export const formatSom = (amount: number) => `${somFormatter.format(amount)} so'm`;

export const formatDate = (ts: number, lang: string = "en") =>
  new Intl.DateTimeFormat(lang === "uz" ? "uz-UZ" : lang === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ts));

export const daysLeft = (end: number) =>
  Math.max(0, Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000)));

const ANON_USAGE_KEY = "promptora-usage";
const today = () => new Date().toISOString().slice(0, 10);
export const anonUsage = {
  read(): number {
    try {
      const raw = localStorage.getItem(ANON_USAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { day: string; count: number }) : null;
      return parsed && parsed.day === today() ? Number(parsed.count) || 0 : 0;
    } catch {
      return 0;
    }
  },
  bump() {
    try {
      const count = this.read() + 1;
      localStorage.setItem(ANON_USAGE_KEY, JSON.stringify({ day: today(), count }));
      return count;
    } catch {
      return 0;
    }
  },
};
