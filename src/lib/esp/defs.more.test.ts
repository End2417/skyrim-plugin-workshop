import { describe, expect, it } from "vitest";
import { decodeSubrecord, fixedSize } from "./decode";
import { findSubDef, RECORD_DEFS, SIGNATURE_NAMES } from "./defs";
import { convertToLe } from "./convert";
import { encodeZString, serializeEsp } from "./format";
import { buildPlugin, ids, u32 } from "./testPlugin";

const ctx = { localized: false, resolveFormId: (id: number) => id.toString(16).toUpperCase() };

/** Record type, subrecord, and the number of bytes the game writes for it. */
const SIZES: [string, string, number][] = [
  ["VTYP", "DNAM", 1],
  ["LCRT", "CNAM", 4],
  ["AACT", "CNAM", 4],
  ["TXST", "DNAM", 2],
  ["ECZN", "DATA", 12],
  ["SHOU", "SNAM", 12],
  ["SHOU", "MDOB", 4],
  ["AVIF", "AVSK", 16],
  ["AVIF", "CNAM", 4],
  ["SNCT", "FNAM", 4],
  ["SNCT", "PNAM", 4],
  ["SNCT", "VNAM", 2],
  ["SNCT", "UNAM", 2],
  ["DLBR", "QNAM", 4],
  ["DLBR", "TNAM", 4],
  ["DLBR", "DNAM", 4],
  ["DLBR", "SNAM", 4],
  ["ADDN", "DATA", 4],
  ["ADDN", "SNAM", 4],
  ["ADDN", "DNAM", 4],
];

describe("added record layouts", () => {
  it("have the sizes the game uses", () => {
    for (const [rec, sub, size] of SIZES) {
      const def = findSubDef(rec, sub)!.def;
      expect(typeof def === "function" ? null : fixedSize(def), `${rec} ${sub}`).toBe(size);
    }
  });

  it("have names and appear in the signature list", () => {
    for (const t of ["VTYP", "EQUP", "LCRT", "AACT", "TXST", "ECZN", "SHOU", "WOOP", "AVIF", "SNCT", "DLBR", "ADDN"]) {
      expect(RECORD_DEFS[t]?.name, t).toBeTruthy();
      expect(SIGNATURE_NAMES[t], t).toBeTruthy();
    }
  });

  it("decode a sample of the data into named fields", () => {
    const eczn = new Uint8Array(12);
    new DataView(eczn.buffer).setUint32(0, 0x00012eb7, true);
    eczn[8] = 2;
    eczn[9] = 5;
    eczn[10] = 0x3;
    eczn[11] = 30;
    const node = decodeSubrecord("ECZN", { type: "DATA", data: eczn }, "Zone", ctx);
    const kids = Object.fromEntries((node.children ?? []).map((c) => [c.label, c.display]));
    expect(kids["Owner"]).toBe("12EB7");
    expect(kids["Rank"]).toBe("2");
    expect(kids["Minimum Level"]).toBe("5");
    expect(kids["Flags"]).toBe("Never Resets, Match PC Below Minimum Level");
    expect(kids["Max Level"]).toBe("30");

    const word = new Uint8Array(12);
    new DataView(word.buffer).setFloat32(8, 3.5, true);
    const shout = decodeSubrecord("SHOU", { type: "SNAM", data: word }, "S", ctx);
    expect((shout.children ?? []).find((c) => c.label === "Recovery Time")!.display).toBe("3.5");
  });

  it("do not trigger the layout check on correctly sized data", () => {
    const f = buildPlugin("A.esp", [], [
      { type: "ECZN", formId: 0x00000800, edid: "Zone", subs: [{ type: "DATA", data: new Uint8Array(12) }] },
      { type: "SNCT", formId: 0x00000801, edid: "Cat", subs: [{ type: "FNAM", data: u32(1) }, { type: "VNAM", data: new Uint8Array(2) }] },
      { type: "TXST", formId: 0x00000802, edid: "Tex", subs: [{ type: "TX00", data: encodeZString("textures\\a.dds") }, { type: "DNAM", data: new Uint8Array(2) }] },
      { type: "SHOU", formId: 0x00000803, edid: "Shout", subs: [{ type: "SNAM", data: ids(0, 0, 0) }] },
    ]);
    const report = convertToLe(f).report;
    expect(report.layout).toEqual([]);
    expect(report.scanned).toBe(4);
    // and data that is too long for the layout is noticed
    const long = buildPlugin("B.esp", [], [{ type: "ECZN", formId: 0x00000800, edid: "Zone", subs: [{ type: "DATA", data: new Uint8Array(16) }] }]);
    expect(convertToLe(long).report.layout.map((x) => [x.recordType, x.sub, x.expected, x.actual])).toEqual([["ECZN", "DATA", 12, 16]]);
    expect(serializeEsp(f).length).toBeGreaterThan(0);
  });
});

