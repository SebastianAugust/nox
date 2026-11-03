import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { removeSecret, saveSecret, secretExists, type SecretName } from "../../lib/api";
import { t } from "../../lib/i18n";
import { ChunkyButton, Tag } from "../../components/ui/controls";

/**
 * A token input. The value goes straight to Windows Credential Manager (via
 * Rust) and the field is cleared; afterwards only "Saved" or "Not set" is
 * known here. The token is never read back.
 */
export function SecretField({ id, name }: { id: string; name: SecretName }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const check = () => secretExists(name).then(setSaved).catch(() => setSaved(false));
    check();
    const unlisten = listen("secrets:changed", check);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [name]);

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      await saveSecret(name, draft);
      setDraft("");
      setSaved(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeSecret(name);
      setSaved(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="secret">
      <form
        className="secret__row"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          id={id}
          type="password"
          className="field"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("int.token.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <ChunkyButton type="submit" size="sm" disabled={busy || !draft.trim()}>
          {t("int.token.save")}
        </ChunkyButton>
      </form>
      <div className="secret__row">
        {saved !== null && <Tag tone={saved ? "done" : "neutral"}>{t(saved ? "int.token.saved" : "int.token.notSet")}</Tag>}
        {saved && (
          <ChunkyButton size="sm" variant="secondary" disabled={busy} onClick={() => void remove()}>
            {t("int.token.remove")}
          </ChunkyButton>
        )}
      </div>
      {failed && (
        <p className="field-error" role="alert">
          {t("int.token.failed")}
        </p>
      )}
    </div>
  );
}
