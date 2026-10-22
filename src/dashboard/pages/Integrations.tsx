import { t, type I18nKey } from "../../lib/i18n";
import { Tag } from "../../components/ui/controls";

type Service = {
  name: string;
  icon: string; // generic tabler icon, never a brand logo
  about: I18nKey;
};

// None of these is built yet (Phase 2), so each one says "Planned" and
// offers no button. When one ships it gets a real Connect flow and shows
// "Connected" / "Not connected" from its settings token.
const SERVICES: Service[] = [
  { name: "Notion", icon: "ti-notebook", about: "int.notion" },
  { name: "Google Calendar", icon: "ti-calendar-event", about: "int.calendar" },
  { name: "Spotify", icon: "ti-music", about: "int.music" },
  { name: "Open-Meteo", icon: "ti-cloud-rain", about: "int.weather" },
];

export default function PageIntegrations() {
  return (
    <>
      <p className="muted page-lead">{t("int.lead")}</p>
      <div className="service-grid">
        {SERVICES.map((s) => (
          <article key={s.name} className="card service" aria-label={`${s.name}: ${t("int.planned")}`}>
            <div className="service__head">
              <span className="service__icon" aria-hidden="true">
                <i className={`ti ${s.icon}`} />
              </span>
              <h2 className="card__title card__title--sm service__name">{s.name}</h2>
              <Tag tone="neutral">{t("int.planned")}</Tag>
            </div>
            <p className="muted">{t(s.about)}</p>
          </article>
        ))}
      </div>
    </>
  );
}
