import { Capacitor } from "@capacitor/core";

// Browsers cannot report whether an anchor download reached storage, and the Capacitor
// WebView ignores blob downloads entirely. In the Android app the file is written straight
// to Documents/ESP Editor (a completed write is confirmed). If Android refuses that, it
// falls back to the share sheet, which cannot confirm a save.
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

/** Saves into the phone's Documents/ESP Editor folder and returns that location. Falls back to the share sheet. */
async function saveNative(bytes: Uint8Array, filename: string): Promise<string | void> {
  const fs = await import("@capacitor/filesystem");
  const safeName = filename.replace(/[\\/:*?"<>|]/g, "_") || "plugin.esp";
  try {
    await writeChunks(fs, fs.Directory.Documents, `ESP Editor/${safeName}`, bytes);
    return `Documents/ESP Editor/${safeName}`;
  } catch (e) {
    console.warn("Direct save failed, using the share sheet instead:", e);
  }
  const { Share } = await import("@capacitor/share");
  const path = `export/${safeName}`;
  await writeChunks(fs, fs.Directory.Cache, path, bytes);
  const { uri } = await fs.Filesystem.getUri({ path, directory: fs.Directory.Cache });
  await Share.share({ title: safeName, dialogTitle: "Save plugin", url: uri });
}

/** In the Android app, resolves with the saved location (or nothing if it fell back to sharing). */
export function downloadPlugin(bytes: Uint8Array, filename: string): void | Promise<string | void> {
  if (Capacitor.isNativePlatform()) return saveNative(bytes, filename);

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
