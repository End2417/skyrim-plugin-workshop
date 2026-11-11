import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.lovable.skyrim_plugin_workshop.twa", // same ID as the Play package, so it stays an update
  appName: "ESP Editor",
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
