// Skyrim keeps names and descriptions of localized plugins (like Skyrim.esm) in separate string
// files: .STRINGS (names), .DLSTRINGS (descriptions, book text) and .ILSTRINGS (dialogue).
// Records only hold a number; load the files to see the text.
export interface StringTable {
  /** Names of the files this table was built from. */
  files: string[];
  size: number;
  get(id: number): string | null;
}

/** Parses one strings file. `.STRINGS` holds plain zero-terminated text; the other two prefix each string with its length. */
export function parseStringsFile(name: string, bytes: Uint8Array): Map<number, string> {
  const lengthPrefixed = /\.(dl|il)strings$/i.test(name);
  if (!/\.(dl|il)?strings$/i.test(name)) throw new Error(`${name} is not a strings file (.STRINGS, .DLSTRINGS or .ILSTRINGS).`);
  if (bytes.length < 8) throw new Error(`${name} is too short to be a strings file.`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);
  const dataSize = dv.getUint32(4, true);
  const dataStart = 8 + count * 8;
  if (dataStart > bytes.length || dataStart + dataSize > bytes.length) throw new Error(`${name} looks damaged or incomplete.`);

  // Skyrim Special Edition writes UTF-8; Legendary Edition writes Windows-1252. Plain English text is identical in both.
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const latin1 = new TextDecoder("windows-1252");
  const decode = (b: Uint8Array) => {
    try {
      return utf8.decode(b);
    } catch {
      return latin1.decode(b);
    }
  };

  const out = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const id = dv.getUint32(8 + i * 8, true);
    let o = dataStart + dv.getUint32(12 + i * 8, true);
    if (o >= bytes.length) continue;
    let end: number;
    if (lengthPrefixed) {
      if (o + 4 > bytes.length) continue;
      const len = dv.getUint32(o, true);
      o += 4;
      end = Math.min(bytes.length, o + len);
    } else {
      end = bytes.indexOf(0, o);
      if (end < 0) end = bytes.length;
    }
    let text = bytes.subarray(o, end);
    if (text.length && text[text.length - 1] === 0) text = text.subarray(0, text.length - 1);
    out.set(id, decode(text));
  }
  return out;
}

export function mergeStringTables(parts: { name: string; strings: Map<number, string> }[]): StringTable {
  const all = new Map<number, string>();
  for (const p of parts) for (const [id, text] of p.strings) all.set(id, text);
  return { files: parts.map((p) => p.name), size: all.size, get: (id) => all.get(id >>> 0) ?? null };
}

// The table for the plugin that is open. Looked up by getDisplayName and the field display.
let active: StringTable | null = null;
export const setActiveStrings = (t: StringTable | null) => void (active = t);
export const getActiveStrings = () => active;
export const lookupString = (id: number): string | null => active?.get(id) ?? null;

import { STORE_STRINGS, withStore as withStoreIn } from "./db";

// ---------- remembering the files between sessions (so you load them once) ----------
export interface StoredStringsFile {
  name: string;
  bytes: Uint8Array;
}

const STORE = STORE_STRINGS;
const withStore = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => withStoreIn(STORE, mode, fn);

/** Keeps the strings files for a plugin on this device. Never throws; returns false if storage refused. */
export async function rememberStringFiles(plugin: string, files: StoredStringsFile[]): Promise<boolean> {
  try {
    await withStore("readwrite", (s) => s.put(files.map((f) => ({ name: f.name, buffer: f.bytes.slice().buffer })), plugin.toLowerCase()));
    return true;
  } catch {
    return false;
  }
}

export async function recallStringFiles(plugin: string): Promise<StoredStringsFile[] | null> {
  try {
    const found = await withStore<{ name: string; buffer: ArrayBuffer }[] | undefined>("readonly", (s) => s.get(plugin.toLowerCase()));
    return found?.length ? found.map((f) => ({ name: f.name, bytes: new Uint8Array(f.buffer) })) : null;
  } catch {
    return null;
  }
}

export async function forgetStringFiles(plugin: string): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.delete(plugin.toLowerCase()));
  } catch {
    /* nothing stored */
  }
}
