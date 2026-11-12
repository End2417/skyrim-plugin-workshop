import { describe, expect, it } from "vitest";
import { buildPlugin, ids, u32 } from "./testPlugin";
import { extractPlugin, findDependencies, mergeIntoPlugin, planMasters } from "./extract";
import { countRecords, fileInfo, getEditorId, getSubrecords, markDirty, parseEsp, walkRecords, type EspFile, type EspRecord } from "./format";

const find = (file: EspFile, edid: string): EspRecord => [...walkRecords(file.nodes)].find((r) => getEditorId(r) === edid)!;

/** Mod.esp (masters: Skyrim.esm): sword -> keyword + enchantment -> magic effect; a second, unrelated sword. */
function source(): EspFile {
  return buildPlugin("Mod.esp", ["Skyrim.esm"], [
    { type: "KYWD", formId: 0x01000800, edid: "MyKeyword" },
    { type: "MGEF", formId: 0x01000804, edid: "MyEffect" },
    { type: "ENCH", formId: 0x01000803, edid: "MyEnchant", subs: [{ type: "EFID", data: ids(0x01000804) }] },
    {
      type: "WEAP",
      formId: 0x01000801,
      edid: "MySword",
      subs: [
        { type: "KWDA", data: ids(0x01000800, 0x00012345) },
        { type: "EITM", data: ids(0x01000803) },
      ],
    },
    { type: "WEAP", formId: 0x01000802, edid: "OtherSword" },
  ]);
}

const edit = (r: EspRecord) => {
  markDirty(r);
  getSubrecords(r).push({ type: "DESC", data: new Uint8Array([72, 105, 0]) });
};

describe("findDependencies", () => {
  it("returns records of the same file that the chosen ones point at, not other files' records", () => {
    const file = source();
    const deps = findDependencies(file, [find(file, "MySword")]);
    expect(deps.records.map((r) => getEditorId(r)).sort()).toEqual(["MyEnchant", "MyKeyword"]);
    expect(deps.truncated).toBe(false);
  });

  it("follows references further when asked", () => {
    const file = source();
    const deps = findDependencies(file, [find(file, "MySword")], { depth: 2 });
    expect(deps.records.map((r) => getEditorId(r)).sort()).toEqual(["MyEffect", "MyEnchant", "MyKeyword"]);
  });

  it("stops at the limit and says so", () => {
    const file = source();
    const deps = findDependencies(file, [find(file, "MySword")], { depth: 2, limit: 1 });
    expect(deps.records).toHaveLength(1);
    expect(deps.truncated).toBe(true);
  });
});

describe("planMasters", () => {
  const src = source();
  it("accepts a patch made from the same source", () => {
    const patch = parseEsp(extractPlugin(src, [find(src, "MySword")]), "Patch.esp");
    expect(planMasters(patch, src, "Mod.esp")).toEqual({ ok: true, add: [] });
  });

  it("appends a missing master when the patch has no records of its own", () => {
    const patch = buildPlugin("Patch.esp", ["Skyrim.esm"], []);
    expect(planMasters(patch, src, "Mod.esp")).toEqual({ ok: true, add: ["Mod.esp"] });
  });

  it("refuses when appending would shift the patch's own FormIDs", () => {
    const patch = buildPlugin("Patch.esp", ["Skyrim.esm"], [{ type: "KYWD", formId: 0x01000800, edid: "PatchOwn" }]);
    const plan = planMasters(patch, src, "Mod.esp");
    expect(plan.ok).toBe(false);
  });

  it("refuses a master list that would renumber FormIDs", () => {
    const patch = buildPlugin("Patch.esp", ["Other.esm"], []);
    const plan = planMasters(patch, src, "Mod.esp");
    expect(plan).toMatchObject({ ok: false });
    expect(!plan.ok && plan.reason).toContain("Other.esm");
  });
});

describe("mergeIntoPlugin", () => {
  it("adds a record to an existing patch and keeps the header consistent", () => {
    const src = source();
    const first = extractPlugin(src, [find(src, "MySword")]);
    const patch = parseEsp(first, "Patch.esp");

    const other = find(src, "OtherSword");
    const result = mergeIntoPlugin(patch, src, [other], { sourceName: "Mod.esp" });
    expect(result).toMatchObject({ added: 1, replaced: 0, kept: 0, mastersAdded: [] });

    const out = parseEsp(result.bytes, "Patch.esp");
    expect([...walkRecords(out.nodes)].map((r) => getEditorId(r)).filter(Boolean).sort()).toEqual(["MySword", "OtherSword"]);
    // both swords share one WEAP group
    expect(out.nodes.filter((n) => n.kind === "group")).toHaveLength(1);
    const hedr = getSubrecords(out.nodes[0] as EspRecord).find((s) => s.type === "HEDR")!;
    expect(new DataView(hedr.data.buffer, hedr.data.byteOffset).getInt32(4, true)).toBe(countRecords(out.nodes)); // records without TES4, plus the one group
  });

  it("replaces a record the patch already has, but keeps the patch's copy of a dependency", () => {
    const src = source();
    const sword = find(src, "MySword");
    const kw = find(src, "MyKeyword");
    const patch = parseEsp(extractPlugin(src, [sword, kw]), "Patch.esp");
    // the patch's keyword carries an edit the source does not have
    const patchKw = find(patch, "MyKeyword");
    markDirty(patchKw);
    getSubrecords(patchKw).push({ type: "CNAM", data: u32(0xff00ff00) });
    const edited = parseEsp(parseAndSave(patch), "Patch.esp");

    edit(sword);
    const result = mergeIntoPlugin(edited, src, [sword, kw], { sourceName: "Mod.esp", weak: [kw] });
    expect(result).toMatchObject({ added: 0, replaced: 1, kept: 1 });

    const out = parseEsp(result.bytes, "Patch.esp");
    expect(getSubrecords(find(out, "MySword")).some((s) => s.type === "DESC")).toBe(true);
    expect(getSubrecords(find(out, "MyKeyword")).some((s) => s.type === "CNAM")).toBe(true);
  });

  it("appends the missing master to an empty patch", () => {
    const src = source();
    const patch = buildPlugin("Patch.esp", ["Skyrim.esm"], []);
    const result = mergeIntoPlugin(patch, src, [find(src, "MySword")], { sourceName: "Mod.esp" });
    expect(result.mastersAdded).toEqual(["Mod.esp"]);
    expect(fileInfo(parseEsp(result.bytes, "Patch.esp")).masters).toEqual(["Skyrim.esm", "Mod.esp"]);
  });

  it("throws the reason when the master lists do not line up", () => {
    const src = source();
    const patch = buildPlugin("Patch.esp", ["Other.esm"], []);
    expect(() => mergeIntoPlugin(patch, src, [find(src, "MySword")], { sourceName: "Mod.esp" })).toThrow(/Other\.esm/);
  });
});

import { serializeEsp } from "./format";
function parseAndSave(f: EspFile): Uint8Array {
  return serializeEsp(f);
}
