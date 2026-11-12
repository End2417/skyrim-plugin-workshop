// Turns raw subrecord bytes into named, readable fields (using defs.ts) and writes edits back.
import { findSubDef, type FieldDef, type IntKind } from "./defs";
import {
  decodeText,
  encodeText,
  fromHex,
  hex8,
  looksLikeZString,
  toHex,
  zstringValue,
  type Subrecord,
} from "./format";
import { lookupString } from "./strings";

export interface DecodeContext {
  localized: boolean;
  resolveFormId: (id: number) => string;
}

/** Location of an editable value inside a subrecord's bytes. size -1 means "to the end". */
export interface Leaf {
  def: FieldDef;
  offset: number;
  size: number;
}

export interface FieldNode {
  label: string;
  display: string;
  leaf?: Leaf;
  children?: FieldNode[];
  /** Present on arrays of fixed-size entries so entries can be added/removed. */
  array?: { offset: number; elemSize: number; of: FieldDef };
  /** Index of the array entry this node represents, within its parent array. */
  entry?: { arrayOffset: number; index: number; elemSize: number };
  warning?: string;
}

const INT_SIZE: Record<IntKind, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4 };

export function fixedSize(def: FieldDef, localized = false): number | null {
  switch (def.k) {
    case "f32":
    case "fid":
      return 4;
    case "str":
    case "array":
      return null;
    case "lstr":
      return localized ? 4 : null;
    case "bytes":
      return def.size ?? null;
    case "struct": {
      let s = 0;
      for (const m of def.m) {
        const f = fixedSize(m, localized);
        if (f === null) return null;
        s += f;
      }
      return s;
    }
    default:
      return INT_SIZE[def.k];
  }
}

function readInt(dv: DataView, k: IntKind, o: number): number {
  switch (k) {
    case "u8": return dv.getUint8(o);
    case "i8": return dv.getInt8(o);
    case "u16": return dv.getUint16(o, true);
    case "i16": return dv.getInt16(o, true);
    case "u32": return dv.getUint32(o, true);
    case "i32": return dv.getInt32(o, true);
  }
}

function writeInt(dv: DataView, k: IntKind, o: number, v: number) {
  switch (k) {
    case "u8": return dv.setUint8(o, v);
    case "i8": return dv.setInt8(o, v);
    case "u16": return dv.setUint16(o, v, true);
    case "i16": return dv.setInt16(o, v, true);
    case "u32": return dv.setUint32(o, v >>> 0, true);
    case "i32": return dv.setInt32(o, v, true);
  }
}

const fmtFloat = (f: number) => (Number.isFinite(f) ? String(+f.toPrecision(7)) : String(f));

export function flagList(value: number, names: Record<number, string>): string[] {
  const out: string[] = [];
  for (let b = 0; b < 32; b++) {
    const bit = 2 ** b;
    if (Math.floor(value / bit) % 2 === 1) out.push(names[bit] || `Unknown bit ${b}`);
  }
  return out;
}

export function readLeafValue(def: FieldDef, data: Uint8Array, leaf: Leaf, localized: boolean): number | string {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const o = leaf.offset;
  switch (def.k) {
    case "f32": return dv.getFloat32(o, true);
    case "fid": return dv.getUint32(o, true);
    case "str": return zstringValue(data.subarray(o, leaf.size < 0 ? undefined : o + leaf.size));
    case "lstr":
      return localized ? dv.getUint32(o, true) : zstringValue(data.subarray(o, leaf.size < 0 ? undefined : o + leaf.size));
    case "bytes": return toHex(data.subarray(o, leaf.size < 0 ? undefined : o + leaf.size));
    case "struct":
    case "array": return "";
    default: return readInt(dv, def.k, o);
  }
}

function displayLeaf(def: FieldDef, data: Uint8Array, leaf: Leaf, ctx: DecodeContext): string {
  const v = readLeafValue(def, data, leaf, ctx.localized);
  switch (def.k) {
    case "f32": return fmtFloat(v as number);
    case "fid": return ctx.resolveFormId(v as number);
    case "str": return v as string;
    case "lstr": {
      if (!ctx.localized) return v as string;
      const text = lookupString(v as number); // from the strings files, when loaded
      return text !== null ? `${text}  [String ID ${hex8(v as number)}]` : `[String ID ${hex8(v as number)}]`;
    }
    case "bytes": {
      const s = v as string;
      return s.length > 150 ? `${s.slice(0, 150)} … (${leaf.size < 0 ? data.length - leaf.offset : leaf.size} bytes)` : s || "(empty)";
    }
    case "struct":
    case "array": return "";
    default: {
      const n = v as number;
      if (def.enum) return def.enum[n] ?? `<Unknown: ${n}>`;
      if (def.flags) return flagList(n, def.flags).join(", ") || "(none)";
      if (def.div) return fmtFloat(n / def.div);
      if (def.hex) return hex8(n).slice(-INT_SIZE[def.k] * 2);
      return String(n);
    }
  }
}

/** Decodes one field at `o`. Returns null when the data ends before it. */
function decodeField(def: FieldDef, data: Uint8Array, o: number, ctx: DecodeContext): { node: FieldNode; size: number } | null {
  const remaining = data.length - o;
  if (def.k === "struct") {
    const children: FieldNode[] = [];
    let p = o;
    for (const m of def.m) {
      const r = decodeField(m, data, p, ctx);
      if (!r) break;
      children.push(r.node);
      p += r.size;
    }
    if (p === o && def.m.length) return null;
    return { node: { label: def.n, display: "", children }, size: p - o };
  }
  if (def.k === "array") {
    const children: FieldNode[] = [];
    const elemSize = fixedSize(def.of, ctx.localized);
    let p = o;
    let i = 0;
    while (p < data.length) {
      const r = decodeField(def.of, data, p, ctx);
      if (!r || r.size === 0) break;
      r.node.label = `${def.of.n} #${i}`;
      if (elemSize) r.node.entry = { arrayOffset: o, index: i, elemSize };
      children.push(r.node);
      p += r.size;
      i++;
    }
    const node: FieldNode = { label: def.n, display: children.length ? "" : "(empty)", children };
    if (elemSize) node.array = { offset: o, elemSize, of: def.of };
    return { node, size: p - o };
  }
  let size: number;
  if (def.k === "str" || (def.k === "lstr" && !ctx.localized)) {
    const z = data.indexOf(0, o);
    size = z < 0 ? remaining : z - o + 1;
  } else if (def.k === "bytes" && !def.size) {
    size = remaining;
  } else {
    size = fixedSize(def, ctx.localized)!;
  }
  if (size > remaining || (remaining <= 0 && size > 0)) return null;
  const leaf: Leaf = { def, offset: o, size };
  if (def.k === "bytes" && def.n === "Unused") {
    return { node: { label: def.n, display: toHex(data.subarray(o, o + size)), leaf }, size };
  }
  return { node: { label: def.n, display: displayLeaf(def, data, leaf, ctx), leaf }, size };
}

/**
 * Calls `visit` for every FormID field (typed `fid` fields only, not hex parameters) in a subrecord.
 * Mirrors decodeField's sizing but builds no display nodes, so it stays cheap on whole plugins.
 * Returns the bytes consumed, or null when the data ends before the field.
 */
export function visitFormIds(def: FieldDef, data: Uint8Array, o: number, localized: boolean, visit: (id: number, field: string) => void): number | null {
  const remaining = data.length - o;
  if (def.k === "struct") {
    let p = o;
    for (const m of def.m) {
      const r = visitFormIds(m, data, p, localized, visit);
      if (r === null) break;
      p += r;
    }
    if (p === o && def.m.length) return null;
    return p - o;
  }
  if (def.k === "array") {
    let p = o;
    while (p < data.length) {
      const r = visitFormIds(def.of, data, p, localized, visit);
      if (r === null || r === 0) break;
      p += r;
    }
    return p - o;
  }
  let size: number;
  if (def.k === "str" || (def.k === "lstr" && !localized)) {
    const z = data.indexOf(0, o);
    size = z < 0 ? remaining : z - o + 1;
  } else if (def.k === "bytes" && !def.size) {
    size = remaining;
  } else {
    size = fixedSize(def, localized)!;
  }
  if (size > remaining || (remaining <= 0 && size > 0)) return null;
  if (def.k === "fid") visit(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(o, true), def.n);
  return size;
}

export function subrecordLabel(recordSig: string, sub: Subrecord): string {
  const d = findSubDef(recordSig, sub.type);
  return d ? `${sub.type} - ${d.label}` : sub.type;
}

export function resolveSubDef(recordSig: string, sub: Subrecord, edid: string): FieldDef | null {
  const d = findSubDef(recordSig, sub.type);
  if (!d) return null;
  return typeof d.def === "function" ? d.def({ edid, data: sub.data }) : d.def;
}

/** Readable tree for one subrecord. Unknown subrecords become a single text or hex value. */
export function decodeSubrecord(recordSig: string, sub: Subrecord, edid: string, ctx: DecodeContext): FieldNode {
  const label = subrecordLabel(recordSig, sub);
  let def = resolveSubDef(recordSig, sub, edid);
  if (!def) {
    def = looksLikeZString(sub.data) ? { k: "str", n: "Text" } : { k: "bytes", n: "Data" };
  }
  const r = decodeField(def, sub.data, 0, ctx);
  if (!r) {
    const leaf: Leaf = { def: { k: "bytes", n: "Data" }, offset: 0, size: -1 };
    return {
      label,
      display: sub.data.length ? toHex(sub.data) : "(empty)",
      leaf,
      ...(sub.data.length ? { warning: "Data is shorter than expected; showing raw bytes." } : {}),
    };
  }
  const node: FieldNode = { ...r.node, label };
  if (r.size < sub.data.length) {
    const extra: FieldNode = {
      label: "Unknown (extra bytes)",
      display: toHex(sub.data.subarray(r.size)),
      leaf: { def: { k: "bytes", n: "Unknown" }, offset: r.size, size: -1 },
    };
    if (node.children) node.children.push(extra);
    else return { label, display: "", children: [{ ...r.node }, extra] };
  }
  if (def.k === "struct" && node.children && node.children.length < def.m.length) {
    node.warning = "Some fields are missing from this entry (older format).";
  }
  return node;
}

// ---------- editing ----------

export function parseFormIdInput(s: string): number {
  const t = s.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,8}$/i.test(t)) throw new Error("FormID must be up to 8 hex digits, e.g. 00012EB7");
  return parseInt(t, 16);
}

function splice(data: Uint8Array, offset: number, removeLen: number, insert: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length - removeLen + insert.length);
  out.set(data.subarray(0, offset));
  out.set(insert, offset);
  out.set(data.subarray(offset + removeLen), offset + insert.length);
  return out;
}

/** New subrecord bytes with `leaf` set to `input` (string from an input box, or a number). */
export function writeLeaf(data: Uint8Array, leaf: Leaf, input: string | number, localized: boolean): Uint8Array {
  const def = leaf.def;
  const size = leaf.size < 0 ? data.length - leaf.offset : leaf.size;
  const textual = def.k === "str" || (def.k === "lstr" && !localized);
  if (textual || def.k === "bytes") {
    let bytes: Uint8Array;
    if (def.k === "bytes") {
      bytes = fromHex(String(input));
      if (def.size && bytes.length !== def.size) throw new Error(`Must be exactly ${def.size} bytes`);
    } else {
      const t = encodeText(String(input));
      bytes = new Uint8Array(t.length + 1);
      bytes.set(t);
    }
    return splice(data, leaf.offset, size, bytes);
  }
  const out = data.slice();
  const dv = new DataView(out.buffer);
  const raw = typeof input === "number" ? input : String(input).trim();
  if (def.k === "f32") {
    const n = Number(raw);
    if (raw === "" || Number.isNaN(n)) throw new Error("Enter a number");
    dv.setFloat32(leaf.offset, n, true);
    return out;
  }
  if (def.k === "fid" || def.k === "lstr") {
    dv.setUint32(leaf.offset, typeof raw === "number" ? raw : parseFormIdInput(raw), true);
    return out;
  }
  if (def.k === "struct" || def.k === "array") throw new Error("Not a single value");
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (/^0x[0-9a-f]+$/i.test(raw) || (def.hex && /^[0-9a-f]+$/i.test(raw))) n = parseInt(raw.replace(/^0x/i, ""), 16);
  else n = Number(raw);
  if (typeof raw === "string" && def.div && !/^0x/i.test(raw)) n = Math.round(Number(raw) * def.div);
  if (!Number.isInteger(n)) throw new Error("Enter a whole number");
  const bitsN = INT_SIZE[def.k] * 8;
  const signed = def.k.startsWith("i");
  const min = signed ? -(2 ** (bitsN - 1)) : 0;
  const max = signed ? 2 ** (bitsN - 1) - 1 : 2 ** bitsN - 1;
  if (n < min || n > max) throw new Error(`Must be between ${min} and ${max}`);
  writeInt(dv, def.k, leaf.offset, n);
  return out;
}

export function removeArrayEntry(data: Uint8Array, entry: NonNullable<FieldNode["entry"]>): Uint8Array {
  return splice(data, entry.arrayOffset + entry.index * entry.elemSize, entry.elemSize, new Uint8Array(0));
}

export function addArrayEntry(data: Uint8Array, arr: NonNullable<FieldNode["array"]>): Uint8Array {
  return splice(data, data.length, 0, new Uint8Array(arr.elemSize));
}

/** Default bytes for a new subrecord of a known layout. */
export function defaultData(def: FieldDef | null, localized: boolean): Uint8Array {
  if (!def) return new Uint8Array(0);
  if (def.k === "str" || (def.k === "lstr" && !localized)) return new Uint8Array(1);
  return new Uint8Array(fixedSize(def, localized) ?? 0);
}

const COUNTERS: [counter: string, counted: string, perEntryBytes?: number][] = [
  ["KSIZ", "KWDA", 4],
  ["COCT", "CNTO"],
  ["LLCT", "LVLO"],
  ["SPCT", "SPLO"],
  ["PRKZ", "PRKR"],
];

/** Keeps count fields (e.g. Keyword Count) in step with the lists they count. */
export function syncCounters(subs: Subrecord[]) {
  for (const [counter, counted, per] of COUNTERS) {
    const c = subs.find((s) => s.type === counter);
    if (!c) continue;
    const n = per
      ? Math.floor((subs.find((s) => s.type === counted)?.data.length ?? 0) / per)
      : subs.filter((s) => s.type === counted).length;
    const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    if (c.data.length === 1) dv.setUint8(0, Math.min(n, 255));
    else if (c.data.length === 4) dv.setUint32(0, n, true);
  }
}

export { decodeText };
