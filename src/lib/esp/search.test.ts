import { describe, expect, it } from "vitest";
import { encodeZString, getEditorId, parseEsp, serializeSubrecords, type EspFile } from "./format";
import { buildSearchIndex, parseQuery, searchIndex, searchPlugin, splitWords } from "./search";

const sig = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
function record(type: string, formId: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(24 + body.length);
  const dv = new DataView(out.buffer);
  out.set(sig(type), 0);
  dv.setUint32(4, body.length, true);
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
const weapon = (id: number, edid: string, animType: number) => {
  const dnam = new Uint8Array(20);
  dnam[0] = animType;
  return record("WEAP", id, serializeSubrecords([{ type: "EDID", data: encodeZString(edid) }, { type: "DNAM", data: dnam }]));
};
const misc = (id: number, edid: string) => record("MISC", id, serializeSubrecords([{ type: "EDID", data: encodeZString(edid) }]));

function sample(): EspFile {
  const tes4 = record("TES4", 0, serializeSubrecords([{ type: "HEDR", data: new Uint8Array(12) }]));
  return parseEsp(
    concat([
      tes4,
      group("WEAP", [
        weapon(0x10, "IronSword", 1),
        weapon(0x11, "IronBow", 7),
        weapon(0x12, "DraugrHunter", 7), // a bow whose Editor ID never says "bow"
        weapon(0x13, "DLC1CrossbowIron", 9),
        weapon(0x14, "SteelGreatsword", 5),
      ]),
      group("MISC", [misc(0x20, "WoodenBowl"), misc(0x21, "ElbowGuardTest")]),
    ]),
    "test.esm",
  );
}
const ids = (rs: ReturnType<typeof searchPlugin>) => rs.map((r) => getEditorId(r));

describe("plain-language search", () => {
  it("splits Editor IDs into words", () => {
    expect(splitWords("IronBow02")).toEqual(["iron", "bow", "02"]);
    expect(splitWords("DLC1CrossbowIron")).toEqual(["dlc", "1", "crossbow", "iron"]);
  });

  it("finds bows when you type just 'bow', real bows before look-alikes", () => {
    const out = ids(searchPlugin(sample(), "bow"));
    expect(out.slice(0, 2).sort()).toEqual(["DraugrHunter", "IronBow"]);
    expect(out).toContain("DLC1CrossbowIron");
    expect(out.indexOf("DLC1CrossbowIron")).toBeLessThan(out.indexOf("WoodenBowl")); // substring beats nothing, bowl is only a prefix
    expect(out).not.toContain("IronSword");
  });

  it("understands plurals and several words", () => {
    expect(ids(searchPlugin(sample(), "bows")).slice(0, 2).sort()).toEqual(["DraugrHunter", "IronBow"]);
    expect(ids(searchPlugin(sample(), "iron bow"))[0]).toBe("IronBow");
    expect(ids(searchPlugin(sample(), "swords"))).toEqual(expect.arrayContaining(["IronSword", "SteelGreatsword"]));
  });

  it("matches record types and FormIDs", () => {
    expect(ids(searchPlugin(sample(), "misc")).sort()).toEqual(["ElbowGuardTest", "WoodenBowl"]);
    expect(ids(searchPlugin(sample(), "00000011"))).toEqual(["IronBow"]);
    expect(parseQuery("bad dead")[0]!.formId).toBeNull(); // plain words that happen to be hex stay words
  });

  it("gives the same answer through the background index, and can be cancelled", async () => {
    const file = sample();
    const index = (await buildSearchIndex(file, false))!;
    expect(ids((await searchIndex(index, "bow"))!)).toEqual(ids(searchPlugin(file, "bow")));
    expect(await searchIndex(index, "bow", 500, () => true)).toBeNull();
  });

  it("notices a record renamed after the index was built", async () => {
    const file = sample();
    const index = (await buildSearchIndex(file, false))!;
    const sword = [...index.records].find((r) => getEditorId(r) === "IronSword")!;
    sword.dirty = true;
    sword.subrecords = [{ type: "EDID", data: encodeZString("IronLongbow") }];
    sword.editorIdCache = undefined;
    expect(ids((await searchIndex(index, "longbow"))!)).toContain("IronLongbow");
  });

  it("keeps only the best matches when there are many", () => {
    expect(searchPlugin(sample(), "bow", 2)).toHaveLength(2);
  });

  it("ignores one-letter searches", () => {
    expect(searchPlugin(sample(), "a")).toEqual([]);
  });

  it("returns nothing for an empty or unmatched search", () => {
    expect(searchPlugin(sample(), "  ")).toEqual([]);
    expect(searchPlugin(sample(), "zzzz")).toEqual([]);
  });
});
