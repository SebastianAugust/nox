import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getSetting, setSetting } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import {
  addPlace,
  deletePlace,
  detectLocation,
  getActivePlace,
  getPlaces,
  placeDetail,
  searchPlaces,
  setActivePlace,
  type Approximate,
  type SavedPlace,
} from "../../lib/places";
import { placeLabel, type Place } from "../../lib/weather";
import { ChunkyButton, IconButton, Toggle } from "../../components/ui/controls";
import { SettingRow } from "./SettingControls";

/** Saved places and the active one, following changes from any window. */
export function usePlaces() {
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [active, setActive] = useState<SavedPlace | null>(null);
  const reload = useCallback(() => {
    // getActivePlace first: it seeds Jatinangor on a fresh database.
    getActivePlace()
      .then(async (a) => {
        setActive(a);
        setPlaces(await getPlaces());
      })
      .catch(console.error);
  }, []);
  useEffect(() => {
    reload();
    const unlisten = listen("settings:changed", reload);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [reload]);
  return { places, active, reload };
}

/** Quick switch between saved places (Home chip, Settings, Integrations). */
export function PlaceSelect({ id, className }: { id?: string; className?: string }) {
  const { places, active } = usePlaces();
  if (places.length === 0 || !active) return null;
  return (
    <select
      id={id}
      className={className ?? "field field--select field--short"}
      aria-label={t("home.placeSelect")}
      value={active.id}
      onChange={(e) => void setActivePlace(Number(e.target.value)).catch(console.error)}
    >
      {places.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** The Places section of Settings: list, switch, add by search, detect. */
export function PlacesManager() {
  const { places, active } = usePlaces();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [picked, setPicked] = useState<Place | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [detectOn, setDetectOn] = useState(false);
  const [guess, setGuess] = useState<Approximate | null>(null);
  const [detectFailed, setDetectFailed] = useState(false);

  useEffect(() => {
    getSetting("location_detect_enabled")
      .then((v) => setDetectOn(v === "true"))
      .catch(console.error);
  }, []);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setPicked(null);
    try {
      setResults(await searchPlaces(query));
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  const pick = (p: Place) => {
    setPicked(p);
    setName(p.name);
  };

  const save = async (p: { name: string; label: string | null; latitude: number; longitude: number }) => {
    setBusy(true);
    try {
      await addPlace(p);
      setQuery("");
      setResults(null);
      setPicked(null);
      setGuess(null);
      setName("");
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleDetect = async (on: boolean) => {
    setDetectOn(on);
    if (!on) setGuess(null);
    await setSetting("location_detect_enabled", String(on));
    await emit("settings:changed", { key: "location_detect_enabled" });
  };

  const detect = async () => {
    setBusy(true);
    setDetectFailed(false);
    try {
      const g = await detectLocation();
      setGuess(g);
      setName(g.city ?? "");
    } catch {
      setDetectFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const guessLabel = (g: Approximate) =>
    [g.city, g.region, g.country].filter(Boolean).join(", ") || `${g.latitude.toFixed(3)}, ${g.longitude.toFixed(3)}`;

  return (
    <div className="settings">
      <div className="places" role="radiogroup" aria-label={t("set.places")}>
        {places.map((p) => (
          <div key={p.id} className={`place${active?.id === p.id ? " place--active" : ""}`}>
            <button
              type="button"
              role="radio"
              aria-checked={active?.id === p.id}
              className="place__pick"
              onClick={() => void setActivePlace(p.id).catch(console.error)}
            >
              <span className="place__dot" aria-hidden="true">
                {active?.id === p.id && <i className="ti ti-check" />}
              </span>
              <span className="place__name">{p.name}</span>
              <span className="place__detail">{placeDetail(p)}</span>
            </button>
            {places.length > 1 && (
              <IconButton
                label={t("set.places.delete", { name: p.name })}
                className="icon-btn--danger"
                onClick={() => void deletePlace(p.id).catch(console.error)}
              >
                <i className="ti ti-trash" aria-hidden="true" />
              </IconButton>
            )}
          </div>
        ))}
      </div>

      <SettingRow label={t("set.places.search")} htmlFor="set-place-search">
        <form
          className="secret__row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            id="set-place-search"
            className="field"
            placeholder={t("set.places.searchPh")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ChunkyButton type="submit" size="sm" variant="secondary" disabled={busy || !query.trim()}>
            {t("set.places.searchBtn")}
          </ChunkyButton>
        </form>
      </SettingRow>

      {results && results.length === 0 && <p className="field-error">{t("set.places.noResults")}</p>}
      {results && results.length > 0 && !picked && (
        <ul className="place-results">
          {results.map((r, i) => (
            <li key={`${r.latitude},${r.longitude},${i}`}>
              <button type="button" className="place-result" onClick={() => pick(r)}>
                <span>{placeLabel(r)}</span>
                <span className="place__detail">{[r.admin2, r.country].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked && (
        <NameAndSave
          label={placeLabel(picked)}
          name={name}
          setName={setName}
          busy={busy}
          onSave={() => void save({ name, label: placeLabel(picked), latitude: picked.latitude, longitude: picked.longitude })}
          onCancel={() => setPicked(null)}
        />
      )}

      <SettingRow label={t("set.places.detectSetting")} hint={t("set.places.detectHint")}>
        <div className="secret__row">
          {detectOn && (
            <ChunkyButton size="sm" variant="secondary" disabled={busy} onClick={() => void detect()}>
              {t("set.places.detect")}
            </ChunkyButton>
          )}
          <Toggle label={t("set.places.detectSetting")} on={detectOn} onChange={(on) => void toggleDetect(on)} />
        </div>
      </SettingRow>
      {detectFailed && <p className="field-error">{t("set.places.detectFailed")}</p>}
      {guess && (
        <NameAndSave
          label={t("set.places.approx", { place: guessLabel(guess) })}
          note={t("set.places.approxNote")}
          name={name}
          setName={setName}
          busy={busy}
          onSave={() =>
            void save({
              name: name || t("set.places.here"),
              label: guessLabel(guess),
              latitude: guess.latitude,
              longitude: guess.longitude,
            })
          }
          onCancel={() => setGuess(null)}
        />
      )}
    </div>
  );
}

/** Confirm step: what was found, a name for it, Save and use / Dismiss. */
function NameAndSave({
  label,
  note,
  name,
  setName,
  busy,
  onSave,
  onCancel,
}: {
  label: string;
  note?: string;
  name: string;
  setName: (v: string) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="place-confirm"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <p className="place-confirm__what">{label}</p>
      {note && <p className="muted">{note}</p>}
      <div className="secret__row">
        <label htmlFor="set-place-name" className="setting__label">
          {t("set.places.name")}
        </label>
        <input
          id="set-place-name"
          className="field field--short"
          placeholder={t("set.places.namePh")}
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <ChunkyButton type="submit" size="sm" disabled={busy}>
          {t("set.places.save")}
        </ChunkyButton>
        <ChunkyButton size="sm" variant="secondary" onClick={onCancel}>
          {t("set.places.dismiss")}
        </ChunkyButton>
      </div>
    </form>
  );
}
