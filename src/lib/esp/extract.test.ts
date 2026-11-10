import { describe, expect, it } from "vitest";
import {
  encodeZString,
  fileInfo,
  getEditorId,
  getSubrecords,
  markDirty,
  parseEsp,
  serializeSubrecords,
  walkRecords,
  type EspFile,
  type EspGroup,
  type EspRecord,
} from "./format";
import { extractPlugin, fieldKey, findLocalizedFields, listChangedRecords } from "./extract";

const sig = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
function record(type: string, formId: number, body: Uint8Array, flags = 0): Uint8Array {
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
function group(label: string, children: Uint8Array[]): Uint8Array {
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
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

/** A tiny localized "Skyrim.esm": two swords (names are string IDs) and one armor. */
function sampleMaster(): EspFile {
  const hedr = new Uint8Array(12);
  new DataView(hedr.buffer).setFloat32(0, 1.7, true);
  new DataView(hedr.buffer).setInt32(4, 6, true);
  const tes4 = record("TES4", 0, serializeSubrecords([{ type: "HEDR", data: hedr }]), 0x81);
  const weap = (id: number, edid: string, str: number) =>
    record("WEAP", id, serializeSubrecords([
      { type: "EDID", data: encodeZString(edid) },
      { type: "FULL", data: u32(str) },
    ]));
  const armo = record("ARMO", 0x00012e49, serializeSubrecords([{ type: "EDID", data: encodeZString("ArmorIronCuirass") }]));
  const bytes = concat([
    tes4,
    group("WEAP", [weap(0x00012eb7, "IronSword", 0x1234), weap(0x00012eb8, "SteelSword", 0x1235)]),
    group("ARMO", [armo]),
  ]);
  return parseEsp(bytes, "Skyrim.esm");
}

const records = (f: EspFile) => [...walkRecords(f.nodes)];
const find = (f: EspFile, edid: string) => records(f).find((r) => getEditorId(r) === edid) as EspRecord;

describe("extracting changes into a new plugin", () => {
  it("lists only edited records", () => {
    const file = sampleMaster();
    expect(listChangedRecords(file)).toEqual([]);
    const sword = find(file, "IronSword");
    markDirty(sword);
    expect(listChangedRecords(file)).toEqual([sword]);
  });

  it("writes an esp that overrides the source record and masters the source file", () => {
    const file = sampleMaster();
    const sword = find(file, "IronSword");
    markDirty(sword);
    const out = parseEsp(extractPlugin(file, [sword], { text: new Map([[fieldKey({ record: sword, index: 1 }), "Iron Sword"]]) }));

    const info = fileInfo(out);
    expect(info.masters).toEqual(["Skyrim.esm"]);
    expect(info.localized).toBe(false);
    const header = out.nodes[0] as EspRecord;
    expect(header.flags & 0x1).toBe(0); // not an ESM
    expect(header.flags & 0x80).toBe(0); // not localized

    // Only the WEAP group with the one record; FormID unchanged so it overrides the master.
    expect(out.nodes).toHaveLength(2);
    const grp = out.nodes[1] as EspGroup;
    expect(new TextDecoder().decode(grp.label)).toBe("WEAP");
    expect(grp.children).toHaveLength(1);
    const rec = grp.children[0] as EspRecord;
    expect(rec.formId).toBe(0x00012eb7);
    expect(getSubrecords(rec).find((s) => s.type === "FULL")!.data).toEqual(encodeZString("Iron Sword"));
  });

  it("falls back to the editor ID when no name text is given, and counts records and groups", () => {
    const file = sampleMaster();
    const sword = find(file, "SteelSword");
    markDirty(sword);
    const out = parseEsp(extractPlugin(file, [sword]));
    const rec = records(out).find((r) => r.type === "WEAP")!;
    expect(getSubrecords(rec).find((s) => s.type === "FULL")!.data).toEqual(encodeZString("SteelSword"));
    const hedr = getSubrecords(out.nodes[0] as EspRecord).find((s) => s.type === "HEDR")!.data;
    expect(new DataView(hedr.buffer, hedr.byteOffset).getInt32(4, true)).toBe(2); // 1 record + 1 group
  });

  it("detects localized fields and refuses an empty selection", () => {
    const file = sampleMaster();
    const sword = find(file, "IronSword");
    expect(findLocalizedFields(file, [sword]).map((f) => [f.sub, f.stringId])).toEqual([["FULL", 0x1234]]);
    expect(() => extractPlugin(file, [])).toThrow("Select at least one record");
  });

  it("keeps edits made to the record", () => {
    const file = sampleMaster();
    const sword = find(file, "IronSword");
    markDirty(sword);
    getSubrecords(sword)[0]!.data = encodeZString("IronSwordMk2");
    const out = parseEsp(extractPlugin(file, [sword]));
    expect(records(out).map((r) => getEditorId(r))).toContain("IronSwordMk2");
  });
});
