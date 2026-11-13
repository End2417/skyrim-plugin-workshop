import { describe, expect, it } from "vitest";
import { buildPlugin } from "./testPlugin";
import { buildMasterNames, describeMasterEntry, findMasterEntry, searchMasterNames } from "./masterNames";

const named = (type: string, formId: number, edid: string, full?: string) => ({
  type,
  formId,
  edid,
  subs: full === undefined ? [] : [{ type: "FULL", data: Uint8Array.from([...new TextEncoder().encode(full), 0]) }],
});

// A master that itself has one master: its own records carry index 01, records it overrides carry 00.
const master = () =>
  buildPlugin("Mod.esm", ["Skyrim.esm"], [
    named("WEAP", 0x01000802, "SteelSword", "Steel Sword"),
    named("WEAP", 0x01000800, "IronBow", "Iron Bow"),
    named("MISC", 0x01000801, "Gold001", "Gold"),
    named("WEAP", 0x00013989, "OverriddenSword", "Overridden"), // an override of Skyrim.esm's record
  ]);

describe("buildMasterNames", () => {
  it("keeps only the records the file owns, sorted by local ID", () => {
    const m = buildMasterNames(master(), null);
    expect(Array.from(m.ids)).toEqual([0x800, 0x801, 0x802]);
    expect(m.edids).toEqual(["IronBow", "Gold001", "SteelSword"]);
    expect(m.names).toEqual(["Iron Bow", "Gold", "Steel Sword"]);
  });
  it("finds a record by local ID", () => {
    const m = buildMasterNames(master(), null);
    expect(findMasterEntry(m, 0x802)).toBe(2);
    expect(findMasterEntry(m, 0x999)).toBe(-1);
  });
  it("describes an entry the way the editor words a reference", () => {
    const m = buildMasterNames(master(), null);
    expect(describeMasterEntry(m, 2, 0x00000802)).toBe('SteelSword "Steel Sword" [WEAP:00000802]');
  });
});

describe("searchMasterNames", () => {
  it("matches words in the Editor ID or name, best first", () => {
    const m = buildMasterNames(master(), null);
    expect(searchMasterNames(m, "steel sword", 10).map((i) => m.edids[i])).toEqual(["SteelSword"]);
    expect(searchMasterNames(m, "bow", 10).map((i) => m.edids[i])).toEqual(["IronBow"]);
  });
  it("matches the record type and requires every word", () => {
    const m = buildMasterNames(master(), null);
    expect(searchMasterNames(m, "weapon", 10).length).toBe(2);
    expect(searchMasterNames(m, "weapon gold", 10)).toEqual([]);
  });
  it("ignores one-letter searches and honours the limit", () => {
    const m = buildMasterNames(master(), null);
    expect(searchMasterNames(m, "s", 10)).toEqual([]);
    expect(searchMasterNames(m, "weapon", 1).length).toBe(1);
  });
});
