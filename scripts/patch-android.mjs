// Adds the app's own Android code to the project that `npx cap add android` generates.
// The android/ folder is not kept in git, so CI runs this after creating it (safe to run again).
//
//  - copies EspFilesPlugin.java (open-with + folder picker) and a MainActivity that registers it
//  - adds "open with" intent filters for .esp / .esm / .esl files to AndroidManifest.xml
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = process.argv[2] ?? join(root, "android");

const config = readFileSync(join(root, "capacitor.config.ts"), "utf8");
const appId = process.env.CAP_APP_ID || /appId:[^\n]*?["']([^"']+)["']/.exec(config)?.[1];
if (!appId) throw new Error("Could not read appId from capacitor.config.ts");

const javaDir = join(androidDir, "app/src/main/java", ...appId.split("."));
const manifestPath = join(androidDir, "app/src/main/AndroidManifest.xml");
if (!existsSync(manifestPath)) throw new Error(`No Android project at ${androidDir}. Run \`npx cap add android\` first.`);

// ---- Java sources ----
mkdirSync(javaDir, { recursive: true });
for (const file of ["EspFilesPlugin.java", "MainActivity.java"]) {
  const source = readFileSync(join(root, "android-overlay", file), "utf8").replaceAll("__PACKAGE__", appId);
  writeFileSync(join(javaDir, file), source);
  console.log(`wrote ${join(javaDir, file)}`);
}

// ---- manifest ----
const START = "<!-- esp-editor:open-with:start -->";
const END = "<!-- esp-editor:open-with:end -->";
const manifest = readFileSync(manifestPath, "utf8");

// Android has no file type for plugins, so Files apps usually call them application/octet-stream and
// often hand over opaque content:// addresses that do not end in .esp. The octet-stream filter is what
// makes the app appear for those; the path patterns cover apps that do send a readable name.
// (pathPattern has no "repeat", so names with extra dots need one pattern per dot count.)
const patterns = [];
for (const ext of ["esp", "esm", "esl", "ESP", "ESM", "ESL"]) {
  for (let dots = 0; dots < 4; dots++) {
    patterns.push(`.*${"\\\\..*".repeat(dots)}\\\\.${ext}`);
  }
}
const block = `
      ${START}
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:scheme="content" />
        <data android:scheme="file" />
        <data android:host="*" />
        <data android:mimeType="*/*" />
${patterns.map((p) => `        <data android:pathPattern="${p}" />`).join("\n")}
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:scheme="content" />
        <data android:scheme="file" />
        <data android:mimeType="application/octet-stream" />
      </intent-filter>
      ${END}
`;

let next = manifest;
if (manifest.includes(START)) {
  next = manifest.replace(new RegExp(`\\s*${START}[\\s\\S]*?${END}\\n?`), block);
} else {
  const close = manifest.indexOf("</activity>");
  if (close < 0) throw new Error("AndroidManifest.xml has no <activity> to add the intent filters to.");
  next = manifest.slice(0, close) + block.trimStart().replace(/^/, "      ") + "\n    " + manifest.slice(close);
}
if (!/android:launchMode="singleTask"/.test(next)) {
  console.warn("warning: MainActivity is not singleTask, so a file opened while the app is running starts a second copy.");
}
writeFileSync(manifestPath, next);
console.log(`patched ${manifestPath}`);
