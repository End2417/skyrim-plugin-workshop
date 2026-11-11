import { describe, expect, it } from "vitest";
import { applyDraft, makeDraft } from "./draft";
import { diffRecord } from "./changes";
import { mergeStringTables, parseStringsFile, setActiveStrings } from "./strings";
import {
  deleteRecord,
  encodeZString,
  getDisplayName,
  getEditorId,
  getSubrecords,
  hex8,
  markDirty,
  parseEsp,
  revertRecord,
  serializeSubrecords,
  walkRecords,
  type EspFile,
  type EspRecord,
} from "./format";

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
function gameData(value: number, weight: number, damage: number): Uint8Array {
  const d = new Uint8Array(10);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, value, true);
  dv.setFloat32(4, weight, true);
  dv.setUint16(8, damage, true);
  return d;
}
function sample(localized = false): EspFile {
  const hedr = new Uint8Array(12);
  new DataView(hedr.buffer).setInt32(4, 3, true);
  const tes4 = record("TES4", 0, serializeSubrecords([{ type: "HEDR", data: hedr }]), localized ? 0x81 : 0x1);
  const weap = (id: number, edid: string, damage: number, name?: Uint8Array) =>
    record("WEAP", id, serializeSubrecords([
      { type: "EDID", data: encodeZString(edid) },
      ...(name ? [{ type: "FULL", data: name }] : []),
      { type: "DATA", data: gameData(25, 9, damage) },
    ]));
  const id = new Uint8Array(4);
  new DataView(id.buffer).setUint32(0, 0x1234, true);
  return parseEsp(concat([tes4, group("WEAP", [weap(0x10, "IronSword", 7, localized ? id : undefined), weap(0x11, "SteelSword", 8)])]), "Test.esm");
}
const find = (f: EspFile, edid: string) => [...walkRecords(f.nodes)].find((r) => getEditorId(r) === edid) as EspRecord;
const ctx = { localized: false, resolveFormId: (n: number) => hex8(n) };

function setDamage(r: EspRecord, damage: number) {
  markDirty(r);
  const data = getSubrecords(r).find((s) => s.type === "DATA")!.data;
  new DataView(data.buffer, data.byteOffset).setUint16(8, damage, true);
}

describe("revert", () => {
  it("restores every edited field and the original FormID", () => {
    const f = sample();
    const r = find(f, "IronSword");
    setDamage(r, 99);
    r.formId = 0x55;
    getSubrecords(r).find((s) => s.type === "EDID")!.data = encodeZString("Changed");
    expect(revertRecord(r)).toBe(true);
    expect(r.dirty).toBe(false);
    expect(r.formId).toBe(0x10);
    expect(getEditorId(r)).toBe("IronSword");
    expect(new DataView(getSubrecords(r).find((s) => s.type === "DATA")!.data.buffer).getUint16(8, true)).toBe(7);
  });

  it("does nothing for a record that was never edited", () => {
    expect(revertRecord(find(sample(), "IronSword"))).toBe(false);
  });
});

describe("change list", () => {
  it("shows old and new values for each edited field", () => {
    const f = sample();
    const r = find(f, "IronSword");
    setDamage(r, 12);
    const changes = diffRecord(r, ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.label).toContain("Damage");
    expect([changes[0]!.before, changes[0]!.after]).toEqual(["7", "12"]);
  });

  it("is empty when an edit was typed back to the original", () => {
    const f = sample();
    const r = find(f, "IronSword");
    setDamage(r, 12);
    setDamage(r, 7);
    expect(diffRecord(r, ctx)).toEqual([]);
  });
});

describe("drafts", () => {
  it("repeats edits and deletions on a freshly opened copy", () => {
    const f = sample();
    setDamage(find(f, "IronSword"), 30);
    deleteRecord(f, find(f, "SteelSword"));
    const draft = makeDraft(f, "Test.esm|1")!;
    expect(draft.records.length).toBeGreaterThan(0);
    expect(draft.deleted).toEqual(["WEAP:00000011"]);

    const fresh = sample();
    const result = applyDraft(fresh, JSON.parse(JSON.stringify(draft)));
    expect(result.missing).toBe(0);
    expect(find(fresh, "SteelSword")).toBeUndefined();
    expect(diffRecord(find(fresh, "IronSword"), ctx)[0]!.after).toBe("30");
  });

  it("has no draft when nothing changed", () => {
    expect(makeDraft(sample(), "x")).toBeNull();
  });
});

function stringsFile(entries: [number, string][], lengthPrefixed: boolean): Uint8Array {
  const enc = new TextEncoder();
  const blobs = entries.map(([, t]) => {
    const body = enc.encode(`${t}\0`);
    if (!lengthPrefixed) return body;
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length, true);
    out.set(body, 4);
    return out;
  });
  const data = concat(blobs);
  const out = new Uint8Array(8 + entries.length * 8 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, entries.length, true);
  dv.setUint32(4, data.length, true);
  let offset = 0;
  entries.forEach(([id], i) => {
    dv.setUint32(8 + i * 8, id, true);
    dv.setUint32(12 + i * 8, offset, true);
    offset += blobs[i]!.length;
  });
  out.set(data, 8 + entries.length * 8);
  return out;
}

describe("strings files", () => {
  it("reads both plain and length-prefixed files", () => {
    const plain = parseStringsFile("Skyrim_English.STRINGS", stringsFile([[0x1234, "Iron Sword"], [2, "Steel Sword"]], false));
    const prefixed = parseStringsFile("Skyrim_English.DLSTRINGS", stringsFile([[7, "A plain blade."]], true));
    expect(plain.get(0x1234)).toBe("Iron Sword");
    expect(prefixed.get(7)).toBe("A plain blade.");
    expect(() => parseStringsFile("notes.txt", new Uint8Array(16))).toThrow("not a strings file");
  });

  it("gives localized records their real names", () => {
    const f = sample(true);
    const r = find(f, "IronSword");
    expect(getDisplayName(r, true)).toBeNull();
    r.nameCache = undefined;
    setActiveStrings(mergeStringTables([{ name: "a.STRINGS", strings: parseStringsFile("a.STRINGS", stringsFile([[0x1234, "Iron Sword"]], false)) }]));
    expect(getDisplayName(r, true)).toBe("Iron Sword");
    setActiveStrings(null);
  });
});
