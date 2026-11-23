import { useNavigate } from "react-router-dom";
import { Sparkles, X, Check } from "lucide-react";
import { useApp } from "./context";

export function UpgradeModal() {
  const { t, upgrade, closeUpgrade, plan } = useApp();
  const navigate = useNavigate();
  if (!upgrade.open) return null;
  const isSaved = upgrade.reason === "saved";
  return (
    <div className="upgrade-overlay" role="dialog" aria-modal="true" aria-label={t("limitReachedTitle")}>
      <div className="upgrade-modal">
        <button className="upgrade-close" onClick={closeUpgrade} aria-label={t("close")}>
          <X size={18} />
        </button>
        <div className="upgrade-orb">
          <Sparkles size={26} strokeWidth={1.6} />
        </div>
        <h3>{isSaved ? t("savedCapTitle") : t("limitReachedTitle")}</h3>
        <p>{isSaved ? t("savedCapText") : t("limitReachedText")}</p>
        <ul className="upgrade-points">
          <li><Check size={14} />{t("feat_pro_2")}</li>
          <li><Check size={14} />{t("feat_pro_3")}</li>
          <li><Check size={14} />{t("feat_premium_2")}</li>
        </ul>
        <div className="upgrade-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              closeUpgrade();
              navigate(plan === "free" ? "/pricing" : "/pricing#premium");
            }}
          >
            {t("upgradeNow")}
          </button>
          <button className="text-button" onClick={closeUpgrade}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
