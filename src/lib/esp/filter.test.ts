import { describe, expect, it } from "vitest";
import { buildPlugin } from "./testPlugin";
import { getEditorId, type EspRecord } from "./format";
import { buildSearchIndexSync, filterIndex, hasFieldQuery, type FieldQuery } from "./search";

const rec = (type: string, formId: number, edid: string, full?: string) => ({
  type,
  formId,
  edid,
  subs: full === undefined ? [] : [{ type: "FULL", data: Uint8Array.from([...new TextEncoder().encode(full), 0]) }],
});

const file = () =>
  buildPlugin("T.esp", ["Skyrim.esm"], [
    rec("WEAP", 0x01000800, "IronSword", "Iron Sword"),
    rec("WEAP", 0x01000801, "SteelSword", "Steel Sword"),
    rec("WEAP", 0x01000802, "IronBow", "Hunting Bow"),
    rec("ARMO", 0x01000A10, "ArmorIronHelmet", "Iron Helmet"),
    rec("MISC", 0x01000A11, "WoodenBowl", "Bowl"),
  ]);

const run = async (q: Partial<FieldQuery>): Promise<(string | null)[]> => {
  const index = buildSearchIndexSync(file(), false);
  const res = await filterIndex(index, { formId: "", editorId: "", name: "", ...q }, 50);
  return (res ?? []).map((r: EspRecord) => getEditorId(r));
};

describe("hasFieldQuery", () => {
  it("needs at least two characters in some box", () => {
    expect(hasFieldQuery({ formId: "", editorId: "", name: "" })).toBe(false);
    expect(hasFieldQuery({ formId: "8", editorId: "i", name: " " })).toBe(false);
    expect(hasFieldQuery({ formId: "", editorId: "ir", name: "" })).toBe(true);
  });
});

describe("filterIndex", () => {
  it("filters by part of the FormID, with or without 0x", async () => {
    expect(await run({ formId: "0A1" })).toEqual(["ArmorIronHelmet", "WoodenBowl"]);
    expect(await run({ formId: "0x01000801" })).toEqual(["SteelSword"]);
    expect(await run({ formId: "zz" })).toEqual([]);
  });
  it("filters by Editor ID only, whole words first", async () => {
    expect((await run({ editorId: "iron" }))[0]).toBe("IronSword");
    expect(await run({ editorId: "iron" })).toEqual(["IronSword", "IronBow", "ArmorIronHelmet"]);
    expect(await run({ editorId: "hunting" })).toEqual([]); // that word is only in a name
  });
  it("filters by Name only", async () => {
    expect(await run({ name: "hunting" })).toEqual(["IronBow"]);
    expect(await run({ name: "steelsword" })).toEqual([]); // that is an Editor ID, not a name
  });
  it("needs every word and every filled box to match", async () => {
    expect(await run({ editorId: "iron sword" })).toEqual(["IronSword"]);
    expect(await run({ editorId: "iron", name: "bow" })).toEqual(["IronBow"]);
    expect(await run({ editorId: "iron", formId: "0A" })).toEqual(["ArmorIronHelmet"]);
  });
  it("matches plurals and the start of a word", async () => {
    expect(await run({ editorId: "swords" })).toEqual(["IronSword", "SteelSword"]);
    expect(await run({ name: "hel" })).toEqual(["ArmorIronHelmet"]);
  });
  it("returns nothing for an empty or too-short query", async () => {
    expect(await run({})).toEqual([]);
    expect(await run({ editorId: "i" })).toEqual([]);
  });
  it("can be cancelled", async () => {
    const index = buildSearchIndexSync(file(), false);
    expect(await filterIndex(index, { formId: "", editorId: "iron", name: "" }, 50, () => true)).toBe(null); // a newer search replaced this one
  });
});
