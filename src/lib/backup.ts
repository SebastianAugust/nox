import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getSettings } from "./db";
import { setSetting, todayLocal } from "./db-helpers";
import type { I18nKey } from "./i18n";
import { backupStateFrom, type BackupErrorCode, type BackupState, type FolderSuggestion } from "./backupLogic";

export * from "./backupLogic";

const KEYS = [
  "backup_enabled",
  "backup_folder",
  "backup_keep",
  "backup_last_at",
  "backup_last_file",
  "backup_last_error",
  "backup_last_error_at",
  "backup_warn_dismissed",
  "backup_folder_offer_done",
];

export type BackupInfo = { file: string; size: number; at: string; deleted: number };

export async function getBackupState(): Promise<BackupState> {
  return backupStateFrom(await getSettings(KEYS));
}

/** Runs now (the given folder, or the saved one); rejects with an error code. */
export function backupNow(folder?: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("backup_now", { folder: folder?.trim() ? folder.trim() : null });
}

/** The folder as Nox would use it (empty → the Documents fallback). */
export function checkBackupFolder(folder: string): Promise<string> {
  return invoke<string>("backup_check_folder", { folder });
}

export function defaultBackupFolder(): Promise<string> {
  return invoke<string>("backup_default_folder");
}

export function detectBackupFolders(): Promise<FolderSuggestion[]> {
  return invoke<FolderSuggestion[]>("backup_detect_folders");
}

export function openBackupFolder(folder: string): Promise<void> {
  return invoke("backup_open_folder", { folder });
}

/** Set when startup held the migrations back because the backup failed. */
export function backupHold(): Promise<BackupErrorCode | null> {
  return invoke<BackupErrorCode | null>("backup_hold");
}

export async function saveBackupSetting(key: string, value: string): Promise<void> {
  await setSetting(key, value);
  await emit("settings:changed", { key });
  await emit("backup:status");
}

export function dismissBackupWarning(): Promise<void> {
  return saveBackupSetting("backup_warn_dismissed", todayLocal());
}

export const BACKUP_ERROR_TEXT: Record<BackupErrorCode, I18nKey> = {
  folderInvalid: "backup.err.folderInvalid",
  folderCreate: "backup.err.folderCreate",
  copy: "backup.err.copy",
  integrity: "backup.err.integrity",
  database: "backup.err.database",
};
