// Which build this is. The test build (.github/workflows/test-build.yml) sets VITE_TEST_BUILD=1 so it can sit next to the
// normal app on the same phone without touching it: it has its own app ID and name, its own default save folder, and
// says TEST in its title. Browser/WebView storage (settings, remembered masters, drafts) is already separate per app.
const flag = import.meta.env?.["VITE_TEST_BUILD"];

export const IS_TEST_BUILD = flag === "1" || flag === "true";

/** The folder inside Documents that Save and Extract use when no folder was chosen. */
export const APP_FOLDER = IS_TEST_BUILD ? "ESP Editor TEST" : "ESP Editor";

export const APP_TITLE = IS_TEST_BUILD ? "Skyrim ESP Editor TEST" : "Skyrim ESP Editor for Android";
