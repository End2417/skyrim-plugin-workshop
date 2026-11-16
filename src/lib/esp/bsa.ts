// Reader for Skyrim's BSA archives (version 104 = Legendary Edition, zlib; version 105 = Special Edition, LZ4). The app
// uses it for one job: taking the strings files (Skyrim_English.STRINGS...) out of "Skyrim - Interface.bsa", where the game
// keeps them unless they were extracted. UI-free so it stays testable; it works on a whole archive held in memory.
import { unzlibSync } from "fflate";

export interface BsaEntry {
  /** Folder, lower case with backslashes as stored ("strings"). Empty if the archive stores no folder names. */
  folder: string;
  /** File name as stored ("skyrim_english.strings"). */
  name: string;
  /** Folder and name together. */
  path: string;
  /** Size field of the file record, with the compression flag removed. */
  size: number;
  /** Where the file's data starts, from the start of the archive. */
  offset: number;
  compressed: boolean;
}

export interface BsaArchive {
  version: number;
  entries: BsaEntry[];
  /** The archive's own bytes, kept so files can be read from it. */
  bytes: Uint8Array;
  embedNames: boolean;
}

const FLAG_FOLDER_NAMES = 0x1;
const FLAG_FILE_NAMES = 0x2;
const FLAG_COMPRESSED = 0x4;
const FLAG_EMBED_NAMES = 0x100;
const SIZE_MASK = 0x3fffffff;
const COMPRESSION_TOGGLE = 0x40000000;
const HEADER = 36;

export class BsaError extends Error {}

function latin1(b: Uint8Array): string {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

/** Reads the table of contents. Throws a BsaError with a plain-language reason if this is not an archive it can read. */
export function parseBsa(bytes: Uint8Array): BsaArchive {
  if (bytes.length < HEADER || bytes[0] !== 0x42 || bytes[1] !== 0x53 || bytes[2] !== 0x41 || bytes[3] !== 0) {
    throw new BsaError("This is not a BSA archive.");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== 104 && version !== 105) {
    throw new BsaError(`BSA version ${version} is not supported (Skyrim uses 104 for Legendary Edition and 105 for Special Edition).`);
  }
  const folderOffset = dv.getUint32(8, true);
  const flags = dv.getUint32(12, true);
  const folderCount = dv.getUint32(16, true);
  const fileCount = dv.getUint32(20, true);
  if (flags & 0x40) throw new BsaError("Xbox 360 archives are not supported.");
  const folderSize = version === 105 ? 24 : 16;
  if (folderOffset + folderCount * folderSize > bytes.length) throw new BsaError("The archive's folder list is cut short.");

  // File record blocks follow the folder records one after another, so walk them in order rather than trusting offsets.
  let p = folderOffset + folderCount * folderSize;
  const counts: number[] = [];
  for (let i = 0; i < folderCount; i++) counts.push(dv.getUint32(folderOffset + i * folderSize + 8, true));
  const folders: string[] = [];
  const raw: { folder: string; size: number; offset: number }[] = [];
  for (let i = 0; i < folderCount; i++) {
    let folder = "";
    if (flags & FLAG_FOLDER_NAMES) {
      const len = bytes[p++];
      if (len === undefined || p + len > bytes.length) throw new BsaError("A folder name runs past the end of the archive.");
      folder = latin1(bytes.subarray(p, p + Math.max(0, len - 1))).toLowerCase();
      p += len;
    }
    folders.push(folder);
    const n = counts[i]!;
    if (p + n * 16 > bytes.length) throw new BsaError("A file list runs past the end of the archive.");
    for (let k = 0; k < n; k++) {
      raw.push({ folder, size: dv.getUint32(p + 8, true), offset: dv.getUint32(p + 12, true) });
      p += 16;
    }
  }
  if (raw.length !== fileCount) throw new BsaError("The archive's file count does not match its folders.");

  const names: string[] = [];
  if (flags & FLAG_FILE_NAMES) {
    for (let i = 0; i < fileCount; i++) {
      const end = bytes.indexOf(0, p);
      if (end < 0) throw new BsaError("The archive's file names are cut short.");
      names.push(latin1(bytes.subarray(p, end)));
      p = end + 1;
    }
  }

  const byDefault = (flags & FLAG_COMPRESSED) !== 0;
  const entries: BsaEntry[] = raw.map((r, i) => {
    const name = (names[i] ?? "").toLowerCase();
    return {
      folder: r.folder,
      name,
      path: r.folder ? `${r.folder}\\${name}` : name,
      size: r.size & SIZE_MASK,
      offset: r.offset,
      compressed: byDefault !== ((r.size & COMPRESSION_TOGGLE) !== 0),
    };
  });
  return { version, entries, bytes, embedNames: (flags & FLAG_EMBED_NAMES) !== 0 };
}

/** The bytes of one file in the archive, decompressed. */
export function readBsaFile(a: BsaArchive, e: BsaEntry): Uint8Array {
  const { bytes } = a;
  let o = e.offset;
  let size = e.size;
  if (o < 0 || o + size > bytes.length) throw new BsaError(`${e.path} is outside the archive.`);
  const end = o + size;
  if (a.embedNames) {
    const len = bytes[o];
    if (len === undefined) throw new BsaError(`${e.path} is cut short.`);
    o += 1 + len;
    size = end - o;
  }
  if (!e.compressed) return bytes.slice(o, end);
  if (size < 4) throw new BsaError(`${e.path} is cut short.`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const originalSize = dv.getUint32(o, true);
  const packed = bytes.subarray(o + 4, end);
  let out: Uint8Array;
  try {
    out = a.version === 105 ? lz4Decode(packed, originalSize) : unzlibSync(packed);
  } catch (err) {
    throw new BsaError(`${e.path} could not be unpacked${err instanceof Error ? ` (${err.message})` : ""}.`);
  }
  if (out.length !== originalSize) throw new BsaError(`${e.path} unpacked to ${out.length} bytes instead of ${originalSize}.`);
  return out;
}

// ---------- LZ4 ----------

/**
 * Decompresses LZ4 data into `size` bytes. Special Edition archives use the LZ4 frame format; a bare block is accepted
 * too. Checksums are not verified: the unpacked length is checked by the caller instead.
 */
export function lz4Decode(src: Uint8Array, size: number): Uint8Array {
  const dst = new Uint8Array(size);
  const framed = src.length >= 7 && src[0] === 0x04 && src[1] === 0x22 && src[2] === 0x4d && src[3] === 0x18;
  if (!framed) {
    const n = lz4Block(src, 0, src.length, dst, 0);
    return n === size ? dst : dst.subarray(0, n);
  }
  const flg = src[4]!;
  if (flg >> 6 !== 1) throw new BsaError("unknown LZ4 frame version");
  const blockChecksum = (flg & 0x10) !== 0;
  const contentSize = (flg & 0x08) !== 0;
  const dictId = (flg & 0x01) !== 0;
  let p = 6 + (contentSize ? 8 : 0) + (dictId ? 4 : 0) + 1; // FLG, BD, optional fields, header checksum
  let d = 0;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (;;) {
    if (p + 4 > src.length) throw new BsaError("LZ4 data ends too early");
    const word = dv.getUint32(p, true);
    p += 4;
    if (word === 0) break; // end mark
    const len = word & 0x7fffffff;
    if (p + len > src.length) throw new BsaError("LZ4 block runs past the end");
    if (word & 0x80000000) {
      if (d + len > dst.length) throw new BsaError("LZ4 data is larger than expected");
      dst.set(src.subarray(p, p + len), d);
      d += len;
    } else {
      d = lz4Block(src, p, p + len, dst, d);
    }
    p += len + (blockChecksum ? 4 : 0);
  }
  return d === size ? dst : dst.subarray(0, d);
}

/** Decodes one LZ4 block from src[start, end) into dst at `d`; returns the new write position. */
function lz4Block(src: Uint8Array, start: number, end: number, dst: Uint8Array, d: number): number {
  let s = start;
  while (s < end) {
    const token = src[s++]!;
    let lit = token >> 4;
    if (lit === 15) {
      let b: number;
      do {
        if (s >= end) throw new BsaError("LZ4 literal length is cut short");
        b = src[s++]!;
        lit += b;
      } while (b === 255);
    }
    if (s + lit > end) throw new BsaError("LZ4 literals run past the end");
    if (d + lit > dst.length) throw new BsaError("LZ4 data is larger than expected");
    dst.set(src.subarray(s, s + lit), d);
    s += lit;
    d += lit;
    if (s >= end) break; // the last sequence has literals only
    if (s + 2 > end) throw new BsaError("LZ4 match offset is cut short");
    const offset = src[s]! | (src[s + 1]! << 8);
    s += 2;
    if (offset === 0 || offset > d) throw new BsaError("LZ4 match points before the start of the data");
    let match = token & 15;
    if (match === 15) {
      let b: number;
      do {
        if (s >= end) throw new BsaError("LZ4 match length is cut short");
        b = src[s++]!;
        match += b;
      } while (b === 255);
    }
    match += 4;
    if (d + match > dst.length) throw new BsaError("LZ4 data is larger than expected");
    for (let i = 0, from = d - offset; i < match; i++) dst[d++] = dst[from + i]!; // byte by byte: matches may overlap
  }
  return d;
}

// ---------- strings files ----------

export interface ArchiveStrings {
  entry: BsaEntry;
  /** Plugin the strings belong to, lower case, without extension ("skyrim"). */
  plugin: string;
  /** Language, lower case ("english"). */
  language: string;
  /** Extension without the dot, lower case: "strings", "dlstrings" or "ilstrings". */
  ext: string;
}

const STRINGS_FILE = /^(.+)_([a-z]+)\.((?:dl|il)?strings)$/i;

/** The strings files in an archive's strings folder. */
export function listArchiveStrings(a: BsaArchive): ArchiveStrings[] {
  const out: ArchiveStrings[] = [];
  for (const entry of a.entries) {
    if (entry.folder !== "strings") continue;
    const m = STRINGS_FILE.exec(entry.name);
    if (m) out.push({ entry, plugin: m[1]!.toLowerCase(), language: m[2]!.toLowerCase(), ext: m[3]!.toLowerCase() });
  }
  return out;
}

/** Plugin file name without its extension, lower case ("Skyrim.esm" -> "skyrim"). */
export const pluginBase = (name: string) => name.replace(/\.(esm|esp|esl)$/i, "").toLowerCase();

/** The language to use: English if there is any, otherwise the first one alphabetically. */
export function chooseLanguage(languages: Iterable<string>): string | null {
  const all = [...new Set(languages)].sort();
  return all.includes("english") ? "english" : (all[0] ?? null);
}

/** Name for an extracted file, in the form the game and other tools use: Skyrim_English.STRINGS. */
export function stringsFileName(pluginName: string, s: ArchiveStrings): string {
  const base = pluginName.replace(/\.(esm|esp|esl)$/i, "");
  return `${base}_${s.language.charAt(0).toUpperCase()}${s.language.slice(1)}.${s.ext.toUpperCase()}`;
}
