// Whether the first-launch "set up your Skyrim files" screen has been dealt with (done or skipped).
const KEY = "esp-editor-setup-v1";

export function isSetupDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markSetupDone(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* it will simply be offered again next time */
  }
}
