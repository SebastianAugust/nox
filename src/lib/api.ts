import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

/**
 * Errors from the Rust HTTP commands (`src-tauri/src/http.rs`). They carry a
 * kind and at most a status code; never a URL, header or token.
 */
export type ApiErrorKind =
  | "noToken"
  | "unauthorized"
  | "notFound"
  | "rateLimited"
  | "offline"
  | "timeout"
  | "http"
  | "badResponse"
  | "invalid"
  | "notPaired"
  | "writesOff"
  | "readOnly";

export type ApiError = { kind: ApiErrorKind; status?: number };

export function asApiError(err: unknown): ApiError {
  if (err && typeof err === "object" && "kind" in err && typeof (err as ApiError).kind === "string") {
    return err as ApiError;
  }
  return { kind: "badResponse" };
}

export type Service = "notion" | "weather" | "telegram";

/** A short, user-facing sentence for an API error. */
export function apiErrorText(err: unknown, service: Service): string {
  const e = asApiError(err);
  switch (e.kind) {
    case "noToken":
      return t("api.noToken");
    case "unauthorized":
      return t(service === "notion" ? "api.unauthorizedNotion" : "api.tokenInvalid");
    case "notFound":
      return t(service === "notion" ? "api.notFoundNotion" : "api.notFound");
    case "rateLimited":
      return t("api.rateLimited");
    case "offline":
      return t("api.offline");
    case "timeout":
      return t("api.timeout");
    case "http":
      return t("api.http", { status: e.status ?? 0 });
    case "invalid":
      return t("api.invalid");
    case "notPaired":
      return t("tg.notPaired");
    case "writesOff":
      return t("api.writesOff");
    case "readOnly":
      return t("api.readOnly");
    default:
      return t("api.badResponse");
  }
}

// ── Secrets (Windows Credential Manager, through Rust) ──
// Only "saved / not saved" ever comes back; the value never does.

export type SecretName = "notion_token" | "telegram_bot_token";

export function secretExists(name: SecretName): Promise<boolean> {
  return invoke<boolean>("secret_exists", { name });
}

export async function saveSecret(name: SecretName, value: string): Promise<void> {
  await invoke("secret_set", { name, value });
  await emit("secrets:changed", { name });
}

export async function removeSecret(name: SecretName): Promise<void> {
  await invoke("secret_delete", { name });
  await emit("secrets:changed", { name });
}
