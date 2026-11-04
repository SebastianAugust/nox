import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BACKUP_ERROR_TEXT,
  asBackupError,
  backupHold,
  backupWarning,
  checkBackupFolder,
  detectBackupFolders,
  dismissBackupWarning,
  folderOffer,
  getBackupState,
  saveBackupSetting,
  type BackupErrorCode,
  type BackupState,
  type FolderSuggestion,
} from "../../lib/backup";
import { todayLocal } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import { ChunkyButton } from "../../components/ui/controls";

/**
 * A small, non-blocking backup notice: a failed backup (once a day, until
 * dismissed), migrations held back at startup, and, with `offer`, the
 * first-run offer of a Google Drive or OneDrive folder. Renders nothing when
 * there is nothing to say.
 */
export default function BackupNotice({ offer = false }: { offer?: boolean }) {
  const [state, setState] = useState<BackupState | null>(null);
  const [held, setHeld] = useState<BackupErrorCode | null>(null);
  const [found, setFound] = useState<FolderSuggestion[]>([]);
  const [error, setError] = useState<BackupErrorCode | null>(null);

  const load = useCallback(() => {
    getBackupState().then(setState).catch(console.error);
    backupHold().then(setHeld).catch(console.error);
  }, []);

  useEffect(() => {
    load();
    const unlisten = listen("backup:status", load);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  // Look for cloud folders only while the offer could still show.
  const wantsOffer = offer && !!state && !state.folder.trim() && !state.offerDone;
  useEffect(() => {
    if (wantsOffer) detectBackupFolders().then(setFound).catch(console.error);
  }, [wantsOffer]);

  if (!state) return null;
  const warning = backupWarning(state, held, todayLocal());
  const offered = offer ? folderOffer(state, found) : [];
  if (!warning && offered.length === 0) return null;

  const pick = async (path: string) => {
    setError(null);
    try {
      await checkBackupFolder(path);
      await saveBackupSetting("backup_folder", path);
      await saveBackupSetting("backup_folder_offer_done", "true");
    } catch (err) {
      setError(asBackupError(err));
    }
  };

  return (
    <div className="backup-notices">
      {warning && (
        <div className="backup-notice backup-notice--warn" role="status">
          <i className="ti ti-alert-triangle" aria-hidden="true" />
          <p className="backup-notice__text">
            {warning.kind === "held"
              ? t("backup.held", { reason: t(BACKUP_ERROR_TEXT[warning.code]) })
              : t("backup.failedWarn", { reason: t(BACKUP_ERROR_TEXT[warning.code]) })}
          </p>
          {warning.kind === "failed" && (
            <ChunkyButton size="sm" variant="quiet" onClick={() => void dismissBackupWarning().catch(console.error)}>
              {t("backup.dismiss")}
            </ChunkyButton>
          )}
        </div>
      )}
      {offered.length > 0 && (
        <div className="backup-notice" role="status">
          <i className="ti ti-cloud" aria-hidden="true" />
          <div className="backup-notice__text">
            <p>{t("backup.offer")}</p>
            <p className="muted">{t("backup.syncNote")}</p>
            {error && (
              <p className="field-error" role="alert">
                {t(BACKUP_ERROR_TEXT[error])}
              </p>
            )}
          </div>
          <div className="backup-notice__actions">
            {offered.map((f) => (
              <ChunkyButton key={f.path} size="sm" variant="secondary" title={f.path} onClick={() => void pick(f.path)}>
                {t(f.kind === "googleDrive" ? "backup.useDrive" : "backup.useOneDrive")}
              </ChunkyButton>
            ))}
            <ChunkyButton
              size="sm"
              variant="quiet"
              onClick={() => void saveBackupSetting("backup_folder_offer_done", "true").catch(console.error)}
            >
              {t("backup.notNow")}
            </ChunkyButton>
          </div>
        </div>
      )}
    </div>
  );
}
