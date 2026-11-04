import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { calendarStale, getEvents, hasCalendarSource } from "../../lib/calendar";
import { eventsOn, localClock, localDay, nowNext, type CalendarEvent } from "../../lib/calendarLogic";
import { t } from "../../lib/i18n";
import { Card, Tag } from "../../components/ui/controls";

/** Home: today's calendar events, all-day first, with a now/next marker. */
export default function TodaySchedule() {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [hasFeeds, setHasFeeds] = useState(false);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(() => {
    const today = localDay(new Date());
    Promise.all([getEvents(today, today), hasCalendarSource(), calendarStale()])
      .then(([e, feeds, s]) => {
        setEvents(eventsOn(e, today));
        setHasFeeds(feeds);
        setStale(s);
        setNow(new Date());
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    load();
    const unlisten = listen("calendar:status", load);
    // The now/next marker moves with the clock.
    const timer = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => {
      clearInterval(timer);
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  if (!events) return null;
  const marker = nowNext(events, now);

  return (
    <Card title={t("cal.today")} meta={stale ? t("cal.stale") : undefined}>
      {!hasFeeds ? (
        <p className="empty-line">{t("cal.setup")}</p>
      ) : events.length === 0 ? (
        <p className="empty-line">{t("cal.empty")}</p>
      ) : (
        <ul className="schedule">
          {events.map((e) => {
            const mark = marker?.id === e.id ? marker.kind : null;
            return (
              <li key={e.id} className={`schedule__row${mark ? ` schedule__row--${mark}` : ""}`}>
                <span className="schedule__time">
                  {e.all_day ? t("cal.allDay") : `${localClock(e.start)}–${localClock(e.end)}`}
                </span>
                <span className="schedule__title">{e.title}</span>
                {e.location && <span className="schedule__where">{e.location}</span>}
                {mark && <Tag tone={mark === "now" ? "done" : "neutral"}>{t(mark === "now" ? "cal.now" : "cal.next")}</Tag>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
