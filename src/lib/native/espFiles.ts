// Bridge to the app's own Android plugin (android-overlay/EspFilesPlugin.java, added to the project
// by scripts/patch-android.mjs). It provides "open with" and a save-folder picker. On the web, or in a
// build made without the patch, `nativeFilesAvailable()` is false and callers fall back to the old behaviour.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface OpenedFile {
  uri: string;
  name: string;
}

export interface SaveFolder {
  uri: string;
  name: string;
}

/** One item in a listed folder. `uri` can be read with {@link readFolderFile}. */
export interface FolderEntry {
  name: string;
  uri: string;
  dir: boolean;
  size: number;
}

interface EspFilesPlugin {
  getPendingFile(): Promise<{ file?: OpenedFile }>;
  openRead(opts: { uri: string }): Promise<{ handle: string }>;
  readNext(opts: { handle: string; length: number }): Promise<{ data: string; bytes: number }>;
  closeRead(opts: { handle: string }): Promise<void>;
  pickFolder(opts?: { readOnly?: boolean }): Promise<SaveFolder>;
  folderStatus(opts: { uri: string; needWrite?: boolean }): Promise<{ ok: boolean; name?: string }>;
  listFolder(opts: { treeUri: string; path?: string[] }): Promise<{ found: boolean; entries: FolderEntry[] }>;
  beginWrite(opts: { treeUri: string; name: string }): Promise<{ handle: string }>;
  writeChunk(opts: { handle: string; data: string }): Promise<void>;
  endWrite(opts: { handle: string; abort?: boolean }): Promise<{ name: string; uri: string }>;
  addListener(event: "fileOpened", listener: (file: OpenedFile) => void): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<EspFilesPlugin>("EspFiles");

/** True inside the Android app, when it was built with the native plugin. */
export function nativeFilesAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("EspFiles");
}

/** Multiple of 3, so every base64 chunk stands on its own. */
export const CHUNK = 3 * 1024 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- open with ----------

/** The file Android launched the app with, if any (returned once). */
export async function takePendingFile(): Promise<OpenedFile | null> {
  if (!nativeFilesAvailable()) return null;
  try {
    return (await plugin.getPendingFile()).file ?? null;
  } catch {
    return null;
  }
}

/** Calls `listener` when a plugin is opened with the app while it is already running. */
export async function onFileOpened(listener: (file: OpenedFile) => void): Promise<() => void> {
  if (!nativeFilesAvailable()) return () => {};
  const handle = await plugin.addListener("fileOpened", listener);
  return () => void handle.remove();
}

/** Reads a content:// file Android gave the app, in chunks. */
export async function readOpenedFile(file: OpenedFile): Promise<Uint8Array> {
  const { handle } = await plugin.openRead({ uri: file.uri });
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { data, bytes } = await plugin.readNext({ handle, length: CHUNK });
      if (bytes > 0) {
        parts.push(fromBase64(data));
        total += bytes;
      }
      if (bytes < CHUNK) break;
    }
  } finally {
    await plugin.closeRead({ handle }).catch(() => {});
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- save folder ----------

const FOLDER_KEY = "esp-editor-save-folder";

/** The folder the person chose, if any. It may have become unusable since; see {@link usableSaveFolder}. */
export function getSaveFolder(): SaveFolder | null {
  try {
    const raw = localStorage.getItem(FOLDER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SaveFolder>;
    return typeof v.uri === "string" && typeof v.name === "string" ? { uri: v.uri, name: v.name } : null;
  } catch {
    return null;
  }
}

export function clearSaveFolder(): void {
  try {
    localStorage.removeItem(FOLDER_KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

/** Opens Android's folder picker. Resolves with null if the person backs out. */
export async function chooseSaveFolder(): Promise<SaveFolder | null> {
  try {
    const folder = await plugin.pickFolder();
    try {
      localStorage.setItem(FOLDER_KEY, JSON.stringify(folder));
    } catch {
      throw new Error("Could not remember the folder on this device.");
    }
    return folder;
  } catch (e) {
    if ((e as { code?: string }).code === "CANCELLED") return null;
    throw e;
  }
}

/** The chosen folder if Android still allows writing to it, otherwise null. */
export async function usableSaveFolder(): Promise<SaveFolder | null> {
  const folder = getSaveFolder();
  if (!folder || !nativeFilesAvailable()) return null;
  try {
    const status = await plugin.folderStatus({ uri: folder.uri });
    return status.ok ? { uri: folder.uri, name: status.name ?? folder.name } : null;
  } catch {
    return null;
  }
}

/** Writes a file into the chosen folder. Never overwrites: a taken name gets " (1)", " (2)"... Returns the name used. */
export async function writeToFolder(folder: SaveFolder, filename: string, bytes: Uint8Array): Promise<string> {
  const { handle } = await plugin.beginWrite({ treeUri: folder.uri, name: filename });
  try {
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += CHUNK) {
      await plugin.writeChunk({ handle, data: toBase64(bytes.subarray(offset, offset + CHUNK)) });
    }
    return (await plugin.endWrite({ handle })).name;
  } catch (e) {
    await plugin.endWrite({ handle, abort: true }).catch(() => {});
    throw e;
  }
}

// ---------- Skyrim folder (read-only) ----------

const SKYRIM_KEY = "esp-editor-skyrim-folder";

export function getSkyrimFolder(): SaveFolder | null {
  try {
    const raw = localStorage.getItem(SKYRIM_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SaveFolder>;
    return typeof v.uri === "string" && typeof v.name === "string" ? { uri: v.uri, name: v.name } : null;
  } catch {
    return null;
  }
}

/** Opens Android's folder picker for Skyrim's folder (or its Data folder), asking only to read. Null if the person backs out. */
export async function chooseSkyrimFolder(): Promise<SaveFolder | null> {
  try {
    const folder = await plugin.pickFolder({ readOnly: true });
    try {
      localStorage.setItem(SKYRIM_KEY, JSON.stringify(folder));
    } catch {
      /* it just has to be picked again next time */
    }
    return folder;
  } catch (e) {
    if ((e as { code?: string }).code === "CANCELLED") return null;
    throw e;
  }
}

/** The chosen Skyrim folder if Android still allows reading it. */
export async function usableSkyrimFolder(): Promise<SaveFolder | null> {
  const folder = getSkyrimFolder();
  if (!folder || !nativeFilesAvailable()) return null;
  try {
    const status = await plugin.folderStatus({ uri: folder.uri, needWrite: false });
    return status.ok ? { uri: folder.uri, name: status.name ?? folder.name } : null;
  } catch {
    return null;
  }
}

/** Lists a folder below the chosen one; `path` walks down by folder name (ignoring case). */
export async function listFolder(folder: SaveFolder, path: string[] = []): Promise<{ found: boolean; entries: FolderEntry[] }> {
  return plugin.listFolder({ treeUri: folder.uri, path });
}

/** Reads a file from a listing. */
export function readFolderFile(entry: FolderEntry): Promise<Uint8Array> {
  return readOpenedFile({ uri: entry.uri, name: entry.name });
}
