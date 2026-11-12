import { Capacitor } from "@capacitor/core";
import { usableSaveFolder, getSaveFolder, writeToFolder } from "../native/espFiles";

// Browsers cannot report whether an anchor download reached storage, and the Capacitor
// WebView ignores blob downloads entirely. In the Android app the file is written straight
// to the folder the person chose (see native/espFiles.ts) or, by default, Documents/ESP Editor
// (a completed write is confirmed). If Android refuses that, it falls back to the share sheet,
// which cannot confirm a save.
const CHUNK = 3 * 1024 * 1024; // multiple of 3 so each base64 chunk is self-contained

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function writeChunks(
  fs: typeof import("@capacitor/filesystem"),
  directory: import("@capacitor/filesystem").Directory,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  // First chunk (re)creates the file; later chunks append, so big plugins never need
  // one giant base64 string.
  await fs.Filesystem.writeFile({ path, directory, recursive: true, data: toBase64(bytes.subarray(0, CHUNK)) });
  for (let offset = CHUNK; offset < bytes.length; offset += CHUNK) {
    await fs.Filesystem.appendFile({ path, directory, data: toBase64(bytes.subarray(offset, offset + CHUNK)) });
  }
}

const FOLDER = "ESP Editor";

/** "Mod.esp" -> "Mod (1).esp", "Mod (2).esp", ... so an existing file is never overwritten or blocked. */
function numbered(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

async function existingNames(fs: typeof import("@capacitor/filesystem")): Promise<Set<string>> {
  try {
    const { files } = await fs.Filesystem.readdir({ path: FOLDER, directory: fs.Directory.Documents });
    return new Set(files.map((f) => f.name.toLowerCase()));
  } catch {
    return new Set(); // folder does not exist yet
  }
}

/** Saves into the phone's Documents/ESP Editor folder and returns that location. Falls back to the share sheet. */
async function saveNative(bytes: Uint8Array, filename: string): Promise<string | void> {
  const fs = await import("@capacitor/filesystem");
  const safeName = filename.replace(/[\\/:*?"<>|]/g, "_") || "plugin.esp";
  if (getSaveFolder()) {
    // The person picked a folder: use it. If Android no longer allows that, say so and use the default folder.
    const folder = await usableSaveFolder();
    if (folder) {
      try {
        const name = await writeToFolder(folder, safeName, bytes);
        return `${folder.name}/${name}`;
      } catch (e) {
        await notify(`Could not save to ${folder.name} (${e instanceof Error ? e.message : String(e)}). Using Documents/${FOLDER} instead.`);
      }
    } else {
      await notify(`Your chosen save folder is no longer available. Using Documents/${FOLDER} instead.`);
    }
  }
  const taken = await existingNames(fs);
  for (let n = 0; n < 50; n++) {
    const candidate = numbered(safeName, n);
    if (taken.has(candidate.toLowerCase())) continue;
    try {
      await writeChunks(fs, fs.Directory.Documents, `${FOLDER}/${candidate}`, bytes);
      return `Documents/${FOLDER}/${candidate}`;
    } catch (e) {
      // Android can refuse to write a name that already exists; try the next number.
      console.warn(`Saving as ${candidate} failed:`, e);
    }
  }
  const { Share } = await import("@capacitor/share");
  const path = `export/${safeName}`;
  await writeChunks(fs, fs.Directory.Cache, path, bytes);
  const { uri } = await fs.Filesystem.getUri({ path, directory: fs.Directory.Cache });
  await Share.share({ title: safeName, dialogTitle: "Save plugin", url: uri });
}

/** Android's own pop-up message, visible wherever you are in the app. */
async function notify(text: string): Promise<void> {
  try {
    const { Toast } = await import("@capacitor/toast");
    await Toast.show({ text, duration: "long", position: "bottom" });
  } catch {
    /* the on-screen banner still reports the result */
  }
}

export function downloadPlugin(bytes: Uint8Array, filename: string): void | Promise<string | void> {
  if (Capacitor.isNativePlatform()) {
    return saveNative(bytes, filename).then(
      async (where) => {
        await notify(where ? `Saved to ${where}` : "Choose where to save the file");
        return where;
      },
      async (e) => {
        await notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      },
    );
  }

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Leave enough time for Android's download manager to consume the URL,
    // including when the browser reports an error after dispatching the click.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
