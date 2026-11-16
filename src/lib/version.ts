// The version of this build. The release workflow passes the version typed into "Import zip and build" as VITE_APP_VERSION,
// so a release always knows its own number. Builds made without a version fall back to the number below, which is bumped
// with each release (see AGENTS.md).
const FALLBACK_VERSION = "1.5.0";

/** "v1.5.0" or "1.5.0" -> "1.5.0"; anything that is not a version (1.2, 1.2.3 or 1.2.3.4) -> null. */
export function cleanVersion(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^v/i, "");
  return /^\d+(\.\d+){1,3}$/.test(t) ? t : null;
}

export const APP_VERSION: string = cleanVersion(import.meta.env?.["VITE_APP_VERSION"]) ?? FALLBACK_VERSION;
