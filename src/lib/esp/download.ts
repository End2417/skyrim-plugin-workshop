import { Capacitor } from "@capacitor/core";

// Android app: browsers cannot report whether an anchor download reached storage, and the
// Capacitor WebView ignores blob downloads entirely. In the native app the file is written
// to the app cache and handed to Android's share sheet, where the user picks "Save to
// device", Files, Drive, etc. Sharing cannot confirm a save either, so callers must not
// treat success as proof the file was stored.
const CHUNK = 3 * 1024 * 1024; // multiple of 3 so each base64 chunk is self-contained

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function saveNative(bytes: Uint8Array, filename: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"),
    import("@capacitor/share"),
  ]);
  const safeName = filename.replace(/[\\/:*?"<>|]/g, "_") || "plugin.esp";
  const path = `export/${safeName}`;
  const directory = Directory.Cache;

  // First chunk (re)creates the file; later chunks append, so big plugins never need
  // one giant base64 string.
  await Filesystem.writeFile({
    path,
    directory,
    recursive: true,
    data: toBase64(bytes.subarray(0, CHUNK)),
  });
  for (let offset = CHUNK; offset < bytes.length; offset += CHUNK) {
    await Filesystem.appendFile({ path, directory, data: toBase64(bytes.subarray(offset, offset + CHUNK)) });
  }

  const { uri } = await Filesystem.getUri({ path, directory });
  await Share.share({ title: safeName, dialogTitle: "Save plugin", url: uri });
}

export function downloadPlugin(bytes: Uint8Array, filename: string): void | Promise<void> {
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
