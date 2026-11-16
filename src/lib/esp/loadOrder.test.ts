import { describe, expect, it } from "vitest";
import { findConflicts, sortLikeTheGame } from "./loadOrder";
import { buildPlugin, type SampleRecord } from "./testPlugin";

function data(damage: number): Uint8Array {
  const d = new Uint8Array(10);
  new DataView(d.buffer).setUint16(8, damage, true);
  return d;
}
const weap = (formId: number, edid: string, damage: number): SampleRecord => ({ type: "WEAP", formId, edid, subs: [{ type: "DATA", data: data(damage) }] });

describe("findConflicts", () => {
  it("finds records overridden by several plugins and says who wins", async () => {
    // Skyrim.esm is not loaded: both mods point at its record 00012EB7
    const a = buildPlugin("ModA.esp", ["Skyrim.esm"], [weap(0x00012eb7, "IronSword", 10), weap(0x00012eb8, "Same", 5)]);
    const b = buildPlugin("ModB.esp", ["Skyrim.esm"], [weap(0x00012eb7, "IronSword", 20), weap(0x00012eb8, "Same", 5), weap(0x01000800, "OnlyB", 1)]);
    const r = (await findConflicts([a, b]))!;
    expect(r.counts.conflicts).toBe(1);
    expect(r.identical).toBe(1);
    const c = r.conflicts[0]!;
    expect(c).toMatchObject({ type: "WEAP", editorId: "IronSword", overwritten: 1 });
    expect(c.winner.plugin).toBe("ModB.esp");
    expect(c.entries.map((e) => [e.plugin, e.differs, e.defines])).toEqual([
      ["ModA.esp", true, false],
      ["ModB.esp", false, false],
    ]);
    expect(r.byPlugin).toEqual([
      { plugin: "ModA.esp", wins: 0, loses: 1, identical: 1 },
      { plugin: "ModB.esp", wins: 1, loses: 0, identical: 1 },
    ]);
  });

  it("follows the load order: the last plugin wins", async () => {
    const a = buildPlugin("ModA.esp", ["Skyrim.esm"], [weap(0x00012eb7, "IronSword", 10)]);
    const b = buildPlugin("ModB.esp", ["Skyrim.esm"], [weap(0x00012eb7, "IronSword", 20)]);
    expect((await findConflicts([b, a]))!.conflicts[0]!.winner.plugin).toBe("ModA.esp");
  });

  it("sees a plugin's override of another plugin's own record", async () => {
    const base = buildPlugin("Base.esp", ["Skyrim.esm"], [weap(0x01000800, "Shared", 1)]);
    const patch = buildPlugin("Patch.esp", ["Skyrim.esm", "Base.esp"], [weap(0x01000800, "Shared", 9)]);
    const r = (await findConflicts([base, patch]))!;
    expect(r.counts.conflicts).toBe(1);
    expect(r.conflicts[0]!.entries.map((e) => e.defines)).toEqual([true, false]);
    expect(r.conflicts[0]!.winner.plugin).toBe("Patch.esp");
  });

  it("does not confuse different records that only share a number", async () => {
    const a = buildPlugin("ModA.esp", ["Skyrim.esm"], [weap(0x01000800, "A", 1)]);
    const b = buildPlugin("ModB.esp", ["Skyrim.esm"], [weap(0x01000800, "B", 2)]); // each plugin's own record 800
    expect((await findConflicts([a, b]))!.counts.conflicts).toBe(0);
  });

  it("puts ESM-flagged plugins first and stops when cancelled", async () => {
    const esp = buildPlugin("Mod.esp", [], []);
    const esm = buildPlugin("Master.esp", [], []);
    (esm.nodes[0] as { flags: number }).flags |= 1;
    expect(sortLikeTheGame([esp, esm]).map((f) => f.name)).toEqual(["Master.esp", "Mod.esp"]);
    const many = Array.from({ length: 3100 }, (_, i) => weap(0x00012000 + i, `W${i}`, 1));
    expect(await findConflicts([buildPlugin("A.esp", ["Skyrim.esm"], many), buildPlugin("B.esp", ["Skyrim.esm"], many)], () => true)).toBeNull();
  });
});
