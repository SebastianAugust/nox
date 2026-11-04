import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BACKUP_ERROR_TEXT,
  asBackupError,
  backupNow,
  checkBackupFolder,
  defaultBackupFolder,
  detectBackupFolders,
  formatSize,
  getBackupState,
  openBackupFolder,
  parseKeep,
  saveBackupSetting,
  type BackupErrorCode,
  type BackupInfo,
  type BackupState,
  type FolderSuggestion,
} from "../../lib/backup";
import { t } from "../../lib/i18n";
import { ChunkyButton, Toggle } from "../../components/ui/controls";
import { SettingRow } from "./SettingControls";
import BackupNotice from "./BackupNotice";

const SUGGESTION_LABEL = {
  googleDrive: "backup.kind.googleDrive",
  oneDrive: "backup.kind.oneDrive",
  documents: "backup.kind.documents",
} as const;

/** Settings → Backup: on/off, folder, keep count, back up now, last result. */
export default function BackupSettings() {
  const [state, setState] = useState<BackupState | null>(null);
  const [fallback, setFallback] = useState("");
  const [found, setFound] = useState<FolderSuggestion[]>([]);
  const [folder, setFolder] = useState("");
  const [folderError, setFolderError] = useState<BackupErrorCode | null>(null);
  const [keep, setKeep] = useState("");
  const [keepError, setKeepError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: BackupInfo } | { err: BackupErrorCode } | null>(null);

  const load = useCallback(() => {
    getBackupState()
      .then((s) => {
        setState(s);
        setFolder(s.folder);
        setKeep(String(s.keep));
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    load();
    defaultBackupFolder().then(setFallback).catch(console.error);
    detectBackupFolders().then(setFound).catch(console.error);
    const unlisten = listen("backup:status", load);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  if (!state) return null;

  const saveFolder = async (raw: string) => {
    const next = raw.trim();
    setFolder(next);
    setFolderError(null);
    try {
      await checkBackupFolder(next);
      if (next !== state.folder) {
        await saveBackupSetting("backup_folder", next);
        await saveBackupSetting("backup_folder_offer_done", "true");
      }
    } catch (err) {
      setFolderError(asBackupError(err));
    }
  };

  const saveKeep = async () => {
    const n = parseKeep(keep);
    setKeepError(n === null);
    if (n !== null && n !== state.keep) await saveBackupSetting("backup_keep", String(n));
  };

  const runNow = async () => {
    setBusy(true);
    setResult(null);
    try {
      // A folder typed but not saved yet is checked by Rust all the same.
      setResult({ ok: await backupNow(folder) });
    } catch (err) {
      setResult({ err: asBackupError(err) });
    } finally {
      setBusy(false);
      load();
    }
  };

  const open = async () => {
    setFolderError(null);
    try {
      await openBackupFolder(folder);
    } catch (err) {
      setFolderError(asBackupError(err));
    }
  };

  const last = state.lastError
    ? t("backup.lastFailed", { at: state.lastErrorAt, reason: t(BACKUP_ERROR_TEXT[state.lastError]) })
    : state.lastAt
      ? t("backup.lastOk", { at: state.lastAt, file: state.lastFile })
      : t("backup.never");

  return (
    <div className="settings">
      <BackupNotice />
      <SettingRow label={t("backup.enabled")} hint={t("backup.enabledHint")}>
        <Toggle
          label={t("backup.enabled")}
          on={state.enabled}
          onChange={(on) => void saveBackupSetting("backup_enabled", String(on)).catch(console.error)}
        />
      </SettingRow>

      <div className="setting setting--stack">
        <div className="setting__text">
          <label htmlFor="backup-folder" className="setting__label">
            {t("backup.folder")}
          </label>
          <span className="setting__hint">{t("backup.syncNote")}</span>
        </div>
        <input
          id="backup-folder"
          className="field"
          placeholder={fallback}
          aria-describedby={folderError ? "backup-folder-err" : undefined}
          aria-invalid={!!folderError}
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onBlur={() => void saveFolder(folder)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setFolder(state.folder);
              setFolderError(null);
            }
          }}
        />
        {!state.folder && !folderError && <p className="muted">{t("backup.notChosen", { path: fallback })}</p>}
        {folderError && (
          <p id="backup-folder-err" className="field-error" role="alert">
            {t(BACKUP_ERROR_TEXT[folderError])}
          </p>
        )}
        {found.length > 0 && (
          <div className="backup-found" aria-label={t("backup.found")}>
            <span className="muted">{t("backup.found")}</span>
            {found.map((f) => (
              <button
                key={f.path}
                type="button"
                className="backup-found__item"
                aria-pressed={folder.toLowerCase() === f.path.toLowerCase()}
                onClick={() => void saveFolder(f.path)}
              >
                <strong>{t(SUGGESTION_LABEL[f.kind])}</strong> <span>{f.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <SettingRow label={t("backup.keep")} hint={t("backup.keepHint")} htmlFor="backup-keep">
        <div>
          <input
            id="backup-keep"
            className="field field--short"
            inputMode="numeric"
            value={keep}
            aria-invalid={keepError}
            onChange={(e) => setKeep(e.target.value)}
            onBlur={() => void saveKeep().catch(console.error)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          {keepError && (
            <p className="field-error" role="alert">
              {t("backup.keepInvalid")}
            </p>
          )}
        </div>
      </SettingRow>

      <SettingRow label={t("backup.last")} hint={last}>
        <div className="backup-actions">
          <ChunkyButton size="sm" onClick={() => void runNow()} disabled={busy}>
            {t(busy ? "backup.running" : "backup.now")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="secondary" onClick={() => void open()}>
            {t("backup.open")}
          </ChunkyButton>
        </div>
      </SettingRow>
      {result && (
        <p className={"ok" in result ? "muted" : "field-error"} role={"ok" in result ? "status" : "alert"}>
          {"ok" in result
            ? t("backup.done", { file: result.ok.file, size: formatSize(result.ok.size), n: result.ok.deleted })
            : t(BACKUP_ERROR_TEXT[result.err])}
        </p>
      )}

      <p className="muted backup-restore">{t("backup.restore")}</p>
    </div>
  );
}
