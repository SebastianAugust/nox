/**
 * Pure backup rules (queue step 04), kept apart from Tauri so they can be
 * tested: when the warning shows, and how stored errors are read back.
 */

export type BackupErrorCode = "folderInvalid" | "folderCreate" | "copy" | "integrity" | "database";

const CODES: readonly BackupErrorCode[] = ["folderInvalid", "folderCreate", "copy", "integrity", "database"];

/** Rust stores the error as JSON (`"folderInvalid"`); anything else is unknown. */
export function parseBackupError(raw: string | undefined | null): BackupErrorCode | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" && (CODES as readonly string[]).includes(v) ? (v as BackupErrorCode) : null;
  } catch {
    return null;
  }
}

/** An error as returned by `invoke` (the serialized enum), or null. */
export function asBackupError(err: unknown): BackupErrorCode {
  return typeof err === "string" && (CODES as readonly string[]).includes(err) ? (err as BackupErrorCode) : "copy";
}

export type BackupState = {
  enabled: boolean;
  /** As saved; empty means "not chosen yet" (the Documents fallback is used). */
  folder: string;
  keep: number;
  lastAt: string;
  lastFile: string;
  lastError: BackupErrorCode | null;
  lastErrorAt: string;
  /** Day (YYYY-MM-DD) the failure warning was last dismissed. */
  warnDismissed: string;
  /** The first-run folder offer was answered ("Not now" or a pick). */
  offerDone: boolean;
};

export const DEFAULT_KEEP = 14;
export const MAX_KEEP = 365;

export function backupStateFrom(s: Record<string, string>): BackupState {
  const keep = Number.parseInt(s.backup_keep ?? "", 10);
  return {
    enabled: s.backup_enabled !== "false",
    folder: s.backup_folder ?? "",
    keep: Number.isFinite(keep) ? Math.min(MAX_KEEP, Math.max(1, keep)) : DEFAULT_KEEP,
    lastAt: s.backup_last_at ?? "",
    lastFile: s.backup_last_file ?? "",
    lastError: parseBackupError(s.backup_last_error),
    lastErrorAt: s.backup_last_error_at ?? "",
    warnDismissed: s.backup_warn_dismissed ?? "",
    offerDone: s.backup_folder_offer_done === "true",
  };
}

export type BackupWarning =
  | { kind: "held"; code: BackupErrorCode }
  | { kind: "failed"; code: BackupErrorCode; at: string };

/**
 * What to warn about, at most once a day:
 * - migrations held back at startup (the pre-update backup failed): always,
 *   since the app runs on the old database until it is fixed;
 * - the last backup failed: until dismissed, then not again that day.
 * A later successful backup clears the stored error, so the warning goes.
 */
export function backupWarning(state: BackupState, held: BackupErrorCode | null, today: string): BackupWarning | null {
  if (held) return { kind: "held", code: held };
  if (!state.enabled || !state.lastError) return null;
  if (state.warnDismissed === today) return null;
  return { kind: "failed", code: state.lastError, at: state.lastErrorAt };
}

export type FolderSuggestion = { kind: "googleDrive" | "oneDrive" | "documents"; path: string };

/** The first-run offer: only while nothing was chosen and a cloud folder exists. */
export function folderOffer(state: BackupState, found: FolderSuggestion[]): FolderSuggestion[] {
  if (state.folder.trim() || state.offerDone) return [];
  return found.filter((f) => f.kind !== "documents");
}

/** Keep count from a text field: whole number 1..365, else null. */
export function parseKeep(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= MAX_KEEP ? n : null;
}

/** "1.2 MB" style size for the last-backup line. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
