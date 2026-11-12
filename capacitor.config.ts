import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: process.env.CAP_APP_ID || "app.lovable.skyrim_plugin_workshop.twa", // default = same ID as the Play package, so it stays an update. CI sets CAP_APP_ID for side-by-side test builds.
  appName: process.env.CAP_APP_NAME || "ESP Editor",
  // The CI workflow sets CAP_WEB_DIR to the folder that contains the built index.html.
  webDir: process.env.CAP_WEB_DIR ?? "dist/client",
  server: { androidScheme: "https" },
  android: {
    backgroundColor: "#152846",
    // Android 15+ draws apps under the status bar; keep the web view below it.
    adjustMarginsForEdgeToEdge: "force",
  },
};

export default config;
