import { describe, expect, it } from "vitest";
import {
  asBackupError,
  backupStateFrom,
  backupWarning,
  folderOffer,
  formatSize,
  parseBackupError,
  parseKeep,
  type FolderSuggestion,
} from "./backupLogic";

const TODAY = "2026-11-04";

describe("backup settings", () => {
  it("reads defaults when rows are missing", () => {
    const s = backupStateFrom({});
    expect(s).toMatchObject({ enabled: true, folder: "", keep: 14, lastError: null, offerDone: false });
  });

  it("clamps keep and reads the stored error", () => {
    expect(backupStateFrom({ backup_keep: "0" }).keep).toBe(1);
    expect(backupStateFrom({ backup_keep: "9999" }).keep).toBe(365);
    expect(backupStateFrom({ backup_keep: "abc" }).keep).toBe(14);
    expect(backupStateFrom({ backup_last_error: '"folderInvalid"' }).lastError).toBe("folderInvalid");
  });

  it("parses only known error codes", () => {
    expect(parseBackupError('"integrity"')).toBe("integrity");
    expect(parseBackupError("")).toBeNull();
    expect(parseBackupError('"nope"')).toBeNull();
    expect(parseBackupError("{bad json")).toBeNull();
    expect(asBackupError("folderCreate")).toBe("folderCreate");
    expect(asBackupError(new Error("x"))).toBe("copy");
  });

  it("validates the keep field", () => {
    expect(parseKeep("14")).toBe(14);
    expect(parseKeep(" 365 ")).toBe(365);
    for (const bad of ["0", "366", "-1", "1.5", "", "ten"]) expect(parseKeep(bad)).toBeNull();
  });

  it("formats sizes", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("backup warning", () => {
  const failed = backupStateFrom({ backup_last_error: '"copy"', backup_last_error_at: "2026-11-04 09:00" });

  it("warns about a failed backup until dismissed, then not again that day", () => {
    expect(backupWarning(failed, null, TODAY)).toEqual({ kind: "failed", code: "copy", at: "2026-11-04 09:00" });
    const dismissed = { ...failed, warnDismissed: TODAY };
    expect(backupWarning(dismissed, null, TODAY)).toBeNull();
    // Still failing the next day: shown once more.
    expect(backupWarning(dismissed, null, "2026-11-05")).not.toBeNull();
  });

  it("says nothing after a success or when backups are off", () => {
    expect(backupWarning(backupStateFrom({ backup_last_at: "2026-11-04 09:00" }), null, TODAY)).toBeNull();
    expect(backupWarning({ ...failed, enabled: false }, null, TODAY)).toBeNull();
  });

  it("always shows held migrations, even when dismissed", () => {
    const dismissed = { ...failed, warnDismissed: TODAY };
    expect(backupWarning(dismissed, "folderInvalid", TODAY)).toEqual({ kind: "held", code: "folderInvalid" });
  });
});

describe("first-run folder offer", () => {
  const found: FolderSuggestion[] = [
    { kind: "googleDrive", path: "G:\My Drive\NoxBackups" },
    { kind: "documents", path: "C:\Users\bas\Documents\NoxBackups" },
  ];

  it("offers cloud folders only while nothing was chosen", () => {
    expect(folderOffer(backupStateFrom({}), found)).toEqual([found[0]]);
    expect(folderOffer(backupStateFrom({ backup_folder: "D:\b" }), found)).toEqual([]);
    expect(folderOffer(backupStateFrom({ backup_folder_offer_done: "true" }), found)).toEqual([]);
  });

  it("offers nothing when only Documents was found", () => {
    expect(folderOffer(backupStateFrom({}), [found[1]])).toEqual([]);
  });
});
