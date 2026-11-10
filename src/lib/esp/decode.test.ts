import { describe, expect, it } from "vitest";
import { addArrayEntry, decodeSubrecord, syncCounters, writeLeaf, type DecodeContext } from "./decode";
import type { Subrecord } from "./format";

const ctx: DecodeContext = { localized: false, resolveFormId: (id) => `ref ${id.toString(16)}` };

function weaponData(value: number, weight: number, damage: number): Uint8Array {
  const d = new Uint8Array(10);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, value, true);
  dv.setFloat32(4, weight, true);
  dv.setUint16(8, damage, true);
  return d;
}

describe("named field decoding", () => {
  it("shows a weapon's Game Data as Value, Weight and Damage", () => {
    const node = decodeSubrecord("WEAP", { type: "DATA", data: weaponData(25, 9, 7) }, "IronSword", ctx);
    expect(node.label).toBe("DATA - Game Data");
    expect(node.children?.map((c) => [c.label, c.display])).toEqual([
      ["Value", "25"],
      ["Weight", "9"],
      ["Damage", "7"],
    ]);
  });

  it("writes an edited Damage back into the right bytes only", () => {
    const sub = { type: "DATA", data: weaponData(25, 9, 7) };
    const damage = decodeSubrecord("WEAP", sub, "", ctx).children![2]!;
    const out = writeLeaf(sub.data, damage.leaf!, "18", false);
    expect(Array.from(out)).toEqual(Array.from(weaponData(25, 9, 18)));
  });

  it("shows and edits armor rating divided by 100, as in TES5Edit", () => {
    const d = new Uint8Array(4);
    new DataView(d.buffer).setInt32(0, 2500, true);
    const node = decodeSubrecord("ARMO", { type: "DNAM", data: d }, "", ctx);
    expect(node.display).toBe("25");
    const out = writeLeaf(d, node.leaf!, "30.5", false);
    expect(new DataView(out.buffer).getInt32(0, true)).toBe(3050);
  });

  it("updates Keyword Count when a keyword is added", () => {
    const ksiz = new Uint8Array(4);
    new DataView(ksiz.buffer).setUint32(0, 1, true);
    const subs: Subrecord[] = [
      { type: "KSIZ", data: ksiz },
      { type: "KWDA", data: new Uint8Array(4) },
    ];
    const kwda = decodeSubrecord("WEAP", subs[1]!, "", ctx);
    subs[1] = { type: "KWDA", data: addArrayEntry(subs[1]!.data, kwda.array!) };
    syncCounters(subs);
    expect(new DataView(subs[0]!.data.buffer).getUint32(0, true)).toBe(2);
  });
});
