// Skyrim (TES5) plugin binary format: parsing and serialization.
// Records keep their original bytes until edited, so untouched records round-trip byte-for-byte.
import { unzlibSync, zlibSync } from "fflate";

export const FLAG_COMPRESSED = 0x00040000;
export const HEADER_SIZE = 24;

export const RECORD_FLAG_NAMES: Record<number, string> = {
  0x00000001: "Master (ESM)",
  0x00000020: "Deleted",
  0x00000080: "Localized",
  0x00000200: "Light (ESL)",
  0x00000400: "Persistent",
  0x00000800: "Initially disabled",
  0x00001000: "Ignored",
  0x00040000: "Compressed",
};

export interface Subrecord {
  type: string;
  data: Uint8Array;
}

export interface EspRecord {
  kind: "record";
  uid: number;
  type: string;
  flags: number;
  formId: number;
  stamp: number;
  version: number;
  unknown: number;
  raw: Uint8Array;
  subrecords: Subrecord[] | null;
  dirty: boolean;
  parent: EspGroup | null;
  editorIdCache?: string | null;
}

export interface EspGroup {
  kind: "group";
  uid: number;
  label: Uint8Array;
  groupType: number;
  stamp: number;
  unknown: number;
  children: EspNode[];
  parent: EspGroup | null;
}

export type EspNode = EspRecord | EspGroup;

export interface EspFile {
  name: string;
  nodes: EspNode[];
}

let uidCounter = 0;
export const nextUid = () => ++uidCounter;

const sig = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export const hex8 = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");

export function parseEsp(buffer: Uint8Array, name = "plugin.esp"): EspFile {
  const nodes = parseRange(buffer, view(buffer), 0, buffer.length, null);
  const first = nodes[0];
  if (!first || first.kind !== "record" || first.type !== "TES4") {
    throw new Error("This doesn't look like a Skyrim plugin (no TES4 header found).");
  }
  return { name, nodes };
}

function parseRange(
  buf: Uint8Array,
  dv: DataView,
  start: number,
  end: number,
  parent: EspGroup | null,
): EspNode[] {
  const out: EspNode[] = [];
  let o = start;
  while (o < end) {
    if (o + HEADER_SIZE > end) throw new Error(`Truncated header at offset 0x${o.toString(16)}`);
    const type = sig(buf, o);
    const size = dv.getUint32(o + 4, true);
    if (type === "GRUP") {
      if (size < HEADER_SIZE || o + size > end)
        throw new Error(`Invalid group size at offset 0x${o.toString(16)}`);
      const g: EspGroup = {
        kind: "group",
        uid: nextUid(),
        label: buf.slice(o + 8, o + 12),
        groupType: dv.getInt32(o + 12, true),
        stamp: dv.getUint32(o + 16, true),
        unknown: dv.getUint32(o + 20, true),
        children: [],
        parent,
      };
      g.children = parseRange(buf, dv, o + HEADER_SIZE, o + size, g);
      out.push(g);
      o += size;
    } else {
      if (!/^[A-Z0-9_]{4}$/.test(type))
        throw new Error(`Unexpected data at offset 0x${o.toString(16)}`);
      if (o + HEADER_SIZE + size > end)
        throw new Error(`Record ${type} at 0x${o.toString(16)} runs past the end of its group`);
      out.push({
        kind: "record",
        uid: nextUid(),
        type,
        flags: dv.getUint32(o + 8, true),
        formId: dv.getUint32(o + 12, true),
        stamp: dv.getUint32(o + 16, true),
        version: dv.getUint16(o + 20, true),
        unknown: dv.getUint16(o + 22, true),
        raw: buf.subarray(o + HEADER_SIZE, o + HEADER_SIZE + size),
        subrecords: null,
        dirty: false,
        parent,
      });
      o += HEADER_SIZE + size;
    }
  }
  return out;
}

/** Uncompressed record body (subrecord bytes) from the original file data. */
function decodeRaw(r: EspRecord): Uint8Array {
  if (r.flags & FLAG_COMPRESSED) {
    if (r.raw.length < 4) throw new Error("Compressed record is too short");
    return unzlibSync(r.raw.subarray(4));
  }
  return r.raw;
}

export function parseSubrecords(data: Uint8Array): Subrecord[] {
  const dv = view(data);
  const subs: Subrecord[] = [];
  let o = 0;
  let pendingSize: number | null = null;
  while (o < data.length) {
    if (o + 6 > data.length) throw new Error("Truncated subrecord header");
    const type = sig(data, o);
    let size = dv.getUint16(o + 4, true);
    o += 6;
    if (pendingSize !== null) {
      size = pendingSize;
      pendingSize = null;
    }
    if (o + size > data.length) throw new Error(`Subrecord ${type} runs past the end of its record`);
    const d = data.slice(o, o + size);
    o += size;
    if (type === "XXXX" && size === 4) {
      pendingSize = view(d).getUint32(0, true);
      continue;
    }
    subs.push({ type, data: d });
  }
  return subs;
}

/** Parsed subrecords, decoding (and caching) them on first access. */
export function getSubrecords(r: EspRecord): Subrecord[] {
  if (!r.subrecords) r.subrecords = parseSubrecords(decodeRaw(r));
  return r.subrecords;
}

/** Call before mutating a record's header or subrecords. */
export function markDirty(r: EspRecord) {
  getSubrecords(r);
  r.dirty = true;
  r.editorIdCache = undefined;
}

export function serializeSubrecords(subs: Subrecord[]): Uint8Array {
  let total = 0;
  for (const s of subs) total += s.data.length > 0xffff ? 10 + 6 + s.data.length : 6 + s.data.length;
  const out = new Uint8Array(total);
  const dv = view(out);
  let o = 0;
  const writeSig = (t: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i) & 0xff;
  };
  for (const s of subs) {
    if (s.data.length > 0xffff) {
      writeSig("XXXX");
      dv.setUint16(o + 4, 4, true);
      dv.setUint32(o + 6, s.data.length, true);
      o += 10;
      writeSig(s.type);
      dv.setUint16(o + 4, 0, true);
    } else {
      writeSig(s.type);
      dv.setUint16(o + 4, s.data.length, true);
    }
    o += 6;
    out.set(s.data, o);
    o += s.data.length;
  }
  return out;
}

function recordPayload(r: EspRecord): Uint8Array {
  if (!r.dirty) return r.raw;
  const data = serializeSubrecords(getSubrecords(r));
  if (!(r.flags & FLAG_COMPRESSED)) return data;
  const z = zlibSync(data);
  const out = new Uint8Array(4 + z.length);
  view(out).setUint32(0, data.length, true);
  out.set(z, 4);
  return out;
}

export function serializeEsp(file: EspFile): Uint8Array {
  const payloads = new Map<EspRecord, Uint8Array>();
  const groupSizes = new Map<EspGroup, number>();
  const sizeOf = (n: EspNode): number => {
    if (n.kind === "record") {
      const p = recordPayload(n);
      payloads.set(n, p);
      return HEADER_SIZE + p.length;
    }
    let s = HEADER_SIZE;
    for (const c of n.children) s += sizeOf(c);
    groupSizes.set(n, s);
    return s;
  };
  let total = 0;
  for (const n of file.nodes) total += sizeOf(n);

  const out = new Uint8Array(total);
  const dv = view(out);
  let o = 0;
  const writeSig = (t: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i) & 0xff;
  };
  const write = (n: EspNode) => {
    if (n.kind === "record") {
      const p = payloads.get(n)!;
      writeSig(n.type);
      dv.setUint32(o + 4, p.length, true);
      dv.setUint32(o + 8, n.flags >>> 0, true);
      dv.setUint32(o + 12, n.formId >>> 0, true);
      dv.setUint32(o + 16, n.stamp >>> 0, true);
      dv.setUint16(o + 20, n.version, true);
      dv.setUint16(o + 22, n.unknown, true);
      out.set(p, o + HEADER_SIZE);
      o += HEADER_SIZE + p.length;
    } else {
      writeSig("GRUP");
      dv.setUint32(o + 4, groupSizes.get(n)!, true);
      out.set(n.label, o + 8);
      dv.setInt32(o + 12, n.groupType, true);
      dv.setUint32(o + 16, n.stamp >>> 0, true);
      dv.setUint32(o + 20, n.unknown >>> 0, true);
      o += HEADER_SIZE;
      for (const c of n.children) write(c);
    }
  };
  for (const n of file.nodes) write(n);
  return out;
}

// ---------- Text (Windows-1252, the encoding Skyrim LE uses) ----------

const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
  0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
  0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const CP1252_REVERSE = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

export function decodeText(b: Uint8Array): string {
  let s = "";
  for (const c of b) s += String.fromCharCode(c >= 0x80 && c < 0xa0 ? CP1252_HIGH[c - 0x80] : c);
  return s;
}

export function encodeText(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    out[i] = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : (CP1252_REVERSE.get(cp) ?? 0x3f);
  }
  return out;
}

/** Null-terminated string as stored in most text subrecords. */
export const encodeZString = (s: string) => {
  const t = encodeText(s);
  const out = new Uint8Array(t.length + 1);
  out.set(t);
  return out;
};

export function looksLikeZString(d: Uint8Array): boolean {
  if (d.length < 2 || d[d.length - 1] !== 0) return false;
  for (let i = 0; i < d.length - 1; i++) {
    const c = d[i];
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}

export const zstringValue = (d: Uint8Array) =>
  decodeText(d[d.length - 1] === 0 ? d.subarray(0, d.length - 1) : d);

export function toHex(d: Uint8Array): string {
  return Array.from(d, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/0x/gi, "").replace(/[\s,]+/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean))
    throw new Error("Hex must be pairs of 0-9 / A-F characters");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------- Helpers for display / navigation ----------

export function getEditorId(r: EspRecord): string | null {
  if (r.editorIdCache !== undefined) return r.editorIdCache;
  let result: string | null = null;
  try {
    if (r.subrecords) {
      const e = r.subrecords.find((s) => s.type === "EDID");
      result = e ? zstringValue(e.data) : null;
    } else {
      const d = decodeRaw(r);
      if (d.length >= 6 && sig(d, 0) === "EDID") {
        const size = view(d).getUint16(4, true);
        result = zstringValue(d.subarray(6, 6 + size));
      }
    }
  } catch {
    result = null;
  }
  r.editorIdCache = result;
  return result;
}

const GROUP_TYPE_NAMES: Record<number, string> = {
  1: "World children",
  2: "Interior cell block",
  3: "Interior cell sub-block",
  4: "Exterior cell block",
  5: "Exterior cell sub-block",
  6: "Cell children",
  7: "Topic children",
  8: "Persistent children",
  9: "Temporary children",
  10: "Distant children",
};

export function describeGroup(g: EspGroup): string {
  const dv = view(g.label);
  switch (g.groupType) {
    case 0:
      return sig(g.label, 0);
    case 2:
    case 3:
      return `${GROUP_TYPE_NAMES[g.groupType]} ${dv.getInt32(0, true)}`;
    case 4:
    case 5:
      return `${GROUP_TYPE_NAMES[g.groupType]} (${dv.getInt16(2, true)}, ${dv.getInt16(0, true)})`;
    default:
      return `${GROUP_TYPE_NAMES[g.groupType] ?? `Group type ${g.groupType}`} of ${hex8(dv.getUint32(0, true))}`;
  }
}

export function* walkRecords(nodes: EspNode[]): Generator<EspRecord> {
  for (const n of nodes) {
    if (n.kind === "record") yield n;
    else yield* walkRecords(n.children);
  }
}

export function countRecords(nodes: EspNode[]): number {
  let c = 0;
  for (const n of nodes) c += n.kind === "record" ? 1 : countRecords(n.children);
  return c;
}

export function searchRecords(file: EspFile, query: string, limit = 200): EspRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const asId = /^(0x)?[0-9a-f]{1,8}$/i.test(q) ? parseInt(q.replace(/^0x/, ""), 16) : null;
  const results: EspRecord[] = [];
  for (const r of walkRecords(file.nodes)) {
    const edid = getEditorId(r);
    if ((asId !== null && r.formId === asId) || edid?.toLowerCase().includes(q) || r.type.toLowerCase() === q) {
      results.push(r);
      if (results.length >= limit) break;
    }
  }
  return results;
}

/** Removes a record and keeps the TES4 header's record count in sync. */
export function deleteRecord(file: EspFile, r: EspRecord) {
  const list = r.parent ? r.parent.children : file.nodes;
  const i = list.indexOf(r);
  if (i < 0) return;
  list.splice(i, 1);
  const tes4 = file.nodes[0];
  if (tes4 && tes4.kind === "record" && tes4 !== r) {
    const hedr = getSubrecords(tes4).find((s) => s.type === "HEDR");
    if (hedr && hedr.data.length >= 8) {
      markDirty(tes4);
      const dv = view(hedr.data);
      dv.setInt32(4, Math.max(0, dv.getInt32(4, true) - 1), true);
    }
  }
}
