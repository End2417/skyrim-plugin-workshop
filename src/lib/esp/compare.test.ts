import { describe, expect, it } from "vitest";
import { aspectsOf, compareFiles, describeDifference } from "./compare";
import { getSubrecords, markDirty, walkRecords, type EspFile, type EspRecord } from "./format";
import { buildPlugin, type SampleRecord } from "./testPlugin";

function gameData(value: number, weight: number, damage: number): Uint8Array {
  const d = new Uint8Array(10);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, value, true);
  dv.setFloat32(4, weight, true);
  dv.setUint16(8, damage, true);
  return d;
}
const weap = (formId: number, edid: string, damage: number): SampleRecord => ({ type: "WEAP", formId, edid, subs: [{ type: "DATA", data: gameData(25, 9, damage) }] });
const find = (f: EspFile, edid: string) => [...walkRecords(f.nodes)].find((r) => r.type !== "TES4" && getEditorIdOf(r) === edid) as EspRecord;
const getEditorIdOf = (r: EspRecord) => {
  const e = getSubrecords(r).find((s) => s.type === "EDID");
  return e ? new TextDecoder().decode(e.data).replace(/\0$/, "") : null;
};

describe("compareFiles, two versions of a mod", () => {
  const a = () => buildPlugin("Mod_LE.esp", ["Skyrim.esm"], [weap(0x01000800, "Same", 5), weap(0x01000801, "Changed", 7), weap(0x01000802, "OnlyOld", 1)]);
  const b = () => buildPlugin("Mod_SE.esp", ["Skyrim.esm"], [weap(0x01000800, "Same", 5), weap(0x01000801, "Changed", 12), weap(0x01000803, "OnlyNew", 2)]);

  it("finds added, removed and changed records, whatever the files are called", async () => {
    const r = (await compareFiles(b(), a()))!;
    expect(r.mode).toBe("versions");
    expect(r.counts).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(r.identical).toBe(1);
    expect(r.added[0]).toMatchObject({ editorId: "OnlyNew", type: "WEAP" });
    expect(r.removed[0]).toMatchObject({ editorId: "OnlyOld" });
    expect(r.changed[0]).toMatchObject({ editorId: "Changed", what: ["data"] });
    expect(r.mastersDiffer).toBe(false);
  });

  it("shows the changed field with the other plugin's value as 'before'", async () => {
    const r = (await compareFiles(b(), a()))!;
    const fields = describeDifference(r.changed[0]!, false);
    expect(fields).toHaveLength(1);
    expect(fields[0]!.label).toContain("Damage");
    expect([fields[0]!.before, fields[0]!.after]).toEqual(["7", "12"]);
  });

  it("sees edits that are not saved yet", async () => {
    const mine = a();
    const r1 = find(mine, "Same");
    markDirty(r1);
    new DataView(getSubrecords(r1).find((s) => s.type === "DATA")!.data.buffer).setUint16(8, 50, true);
    const r = (await compareFiles(mine, a()))!;
    expect(r.counts.changed).toBe(1);
    expect(r.changed[0]!.editorId).toBe("Same");
  });

  it("ignores the form version unless asked, and warns when the master lists differ", async () => {
    const x = buildPlugin("X.esp", ["Skyrim.esm"], [weap(0x01000800, "W", 5)]);
    const y = buildPlugin("Y.esp", ["Skyrim.esm", "Update.esm"], [weap(0x02000800, "W", 5)]);
    const rx = find(x, "W");
    rx.version = 43; // an LE copy of the same record
    expect((await compareFiles(find(y, "W") ? y : y, x))!.mastersDiffer).toBe(true);
    const same = buildPlugin("Z.esp", ["Skyrim.esm"], [weap(0x01000800, "W", 5)]);
    expect(aspectsOf(find(same, "W"), rx)).toEqual([]);
    expect(aspectsOf(find(same, "W"), rx, true)).toEqual(["version"]);
    const flagged = find(same, "W");
    flagged.flags |= 0x20; // deleted
    expect(aspectsOf(flagged, rx)).toEqual(["flags"]);
  });

  it("stops when cancelled", async () => {
    expect(await compareFiles(b(), a(), {}, () => true)).toBeNull();
  });
});

describe("compareFiles, a plugin against its master", () => {
  const skyrim = () => buildPlugin("Skyrim.esm", [], [weap(0x00012eb7, "IronSword", 7), weap(0x00012eb8, "SteelSword", 8), weap(0x00012eb9, "Untouched", 9)]);
  const mod = () => buildPlugin("Tweak.esp", ["Skyrim.esm"], [weap(0x00012eb7, "IronSword", 7), weap(0x00012eb8, "SteelSword", 20), weap(0x01000800, "NewSword", 3)]);

  it("is chosen automatically and reports new, changed and identical-to-master records, without 'removed'", async () => {
    const r = (await compareFiles(mod(), skyrim()))!;
    expect(r.mode).toBe("master");
    expect(r.counts).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(r.identical).toBe(1);
    expect(r.identicalRecords.map((x) => x.formId)).toEqual([0x00012eb7]);
    expect(r.untouched).toBe(1);
    expect(r.added[0]!.editorId).toBe("NewSword");
    expect(r.changed[0]!.editorId).toBe("SteelSword");
  });

  it("can be forced to the other reading", async () => {
    const r = (await compareFiles(mod(), skyrim(), { mode: "versions" }))!;
    expect(r.mode).toBe("versions");
    // Read as two versions, the master's own records are not the mod's overrides, so nothing lines up
    expect(r.counts).toEqual({ added: 3, removed: 3, changed: 0 });
  });
});

describe("compareFiles, large result", () => {
  it("keeps exact counts when the lists are capped", async () => {
    const many = Array.from({ length: 3050 }, (_, i) => weap(0x01000800 + i, `W${i}`, 1));
    const r = (await compareFiles(buildPlugin("A.esp", ["Skyrim.esm"], many), buildPlugin("B.esp", ["Skyrim.esm"], [])))!;
    expect(r.counts.added).toBe(3050);
    expect(r.added).toHaveLength(3000);
    expect(r.truncated).toBe(true);
  });
});
