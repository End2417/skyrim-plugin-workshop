import { describe, expect, it } from "vitest";
import { scanHealth } from "./health";
import { buildPlugin, u32 } from "./testPlugin";
import type { EspGroup } from "./format";

const flst = (formId: number, edid: string, refs: number[] = []) => ({
  type: "FLST",
  formId,
  edid,
  subs: refs.map((id) => ({ type: "LNAM", data: u32(id) })),
});

describe("scanHealth", () => {
  it("finds records that share an Editor ID (any case) or a FormID", async () => {
    const f = buildPlugin("Mod.esp", ["Skyrim.esm"], [
      { type: "WEAP", formId: 0x01000800, edid: "IronSword" },
      { type: "ARMO", formId: 0x01000801, edid: "ironsword" },
      { type: "MISC", formId: 0x01000802, edid: "Gem" },
      { type: "MISC", formId: 0x01000802, edid: "Gem2" },
    ]);
    const r = (await scanHealth(f))!;
    expect(r.duplicateEditorIds.map((d) => [d.key, d.records.length])).toEqual([["ironsword", 2]]);
    expect(r.duplicateFormIds.map((d) => [d.key, d.records.length])).toEqual([["01000802", 2]]);
    expect(r.scanned).toBe(4);
  });

  it("finds groups whose parent record is not in the file", async () => {
    const f = buildPlugin("Mod.esp", ["Skyrim.esm"], [{ type: "WEAP", formId: 0x01000800, edid: "A" }]);
    const group = (type: number, parent: number): EspGroup => ({ kind: "group", uid: 900 + type, label: u32(parent), groupType: type, stamp: 0, unknown: 0, children: [], parent: null });
    f.nodes.push(group(6, 0x01000800), group(6, 0x01000999), group(7, 0x01000abc), group(4, 0x00000001));
    const r = (await scanHealth(f))!;
    expect(r.orphanGroups.map((o) => [o.kind, o.parentId])).toEqual([
      ["cell children", 0x01000999],
      ["topic children", 0x01000abc],
    ]);
  });

  it("lists new supporting records nothing in the plugin points at", async () => {
    const f = buildPlugin("Mod.esp", ["Skyrim.esm"], [
      flst(0x01000800, "Used"),
      flst(0x01000801, "Pointer", [0x01000800]),
      flst(0x00012eb7, "OverrideOfMaster"), // not new: never listed
      { type: "WEAP", formId: 0x01000802, edid: "Weapon" }, // not a supporting type
    ]);
    const r = (await scanHealth(f))!;
    expect(r.unreferenced.map((x) => x.formId)).toEqual([0x01000801]);
    expect(r.unreadable).toBe(0);
  });

  it("says how many records it could not read the references of", async () => {
    const f = buildPlugin("Mod.esp", [], [{ type: "ZZZZ", formId: 0x00000800, edid: "Mystery" }]);
    expect((await scanHealth(f))!.unreadable).toBe(1);
  });

  it("stops when cancelled", async () => {
    const many = Array.from({ length: 2100 }, (_, i) => ({ type: "MISC", formId: 0x800 + i, edid: `M${i}` }));
    expect(await scanHealth(buildPlugin("Mod.esp", [], many), () => true)).toBeNull();
  });
});
