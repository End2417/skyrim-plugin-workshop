// Builds tiny plugins in memory for tests. Not imported by the app.
import { encodeZString, parseEsp, serializeSubrecords, type EspFile, type Subrecord } from "./format";

const sig = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
export const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
export const ids = (...list: number[]) => {
  const out = new Uint8Array(list.length * 4);
  list.forEach((n, i) => new DataView(out.buffer).setUint32(i * 4, n, true));
  return out;
};

export function rawRecord(type: string, formId: number, subs: Subrecord[], flags = 0): Uint8Array {
  const body = serializeSubrecords(subs);
  const out = new Uint8Array(24 + body.length);
  const dv = new DataView(out.buffer);
  out.set(sig(type), 0);
  dv.setUint32(4, body.length, true);
  dv.setUint32(8, flags, true);
  dv.setUint32(12, formId, true);
  dv.setUint16(20, 44, true);
  out.set(body, 24);
  return out;
}

export function rawGroup(label: string, children: Uint8Array[]): Uint8Array {
  const size = 24 + children.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(sig("GRUP"), 0);
  dv.setUint32(4, size, true);
  out.set(sig(label), 8);
  let o = 24;
  for (const c of children) (out.set(c, o), (o += c.length));
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

export interface SampleRecord {
  type: string;
  formId: number;
  edid: string;
  subs?: Subrecord[];
}

/** A plugin with the given masters and records, each type in its own top-level group. */
export function buildPlugin(name: string, masters: string[], records: SampleRecord[]): EspFile {
  const hedr = new Uint8Array(12);
  new DataView(hedr.buffer).setFloat32(0, 1.7, true);
  const types = [...new Set(records.map((r) => r.type))];
  new DataView(hedr.buffer).setInt32(4, records.length + types.length, true);
  const headerSubs: Subrecord[] = [{ type: "HEDR", data: hedr }];
  for (const m of masters) headerSubs.push({ type: "MAST", data: encodeZString(m) }, { type: "DATA", data: new Uint8Array(8) });
  const parts = [rawRecord("TES4", 0, headerSubs)];
  for (const t of types) {
    parts.push(
      rawGroup(
        t,
        records
          .filter((r) => r.type === t)
          .map((r) => rawRecord(r.type, r.formId, [{ type: "EDID", data: encodeZString(r.edid) }, ...(r.subs ?? [])])),
      ),
    );
  }
  return parseEsp(concat(parts), name);
}
