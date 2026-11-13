import { describe, expect, it } from "vitest";
import { buildPlugin } from "./testPlugin";
import { serializeEsp } from "./format";
import { importMasterFiles, isPluginFileName, isStringsFileName } from "./masterImport";

const master = () =>
  buildPlugin("Mod.esm", ["Skyrim.esm"], [
    { type: "WEAP", formId: 0x01000800, edid: "IronBow", subs: [{ type: "FULL", data: Uint8Array.from([...new TextEncoder().encode("Iron Bow"), 0]) }] },
    { type: "MISC", formId: 0x01000801, edid: "Gold001", subs: [] },
  ]);
const fileOf = (name: string, bytes: Uint8Array) => new File([bytes.slice().buffer], name);

describe("file name checks", () => {
  it("tells plugins from strings files", () => {
    expect(isPluginFileName("Skyrim.ESM")).toBe(true);
    expect(isStringsFileName("Skyrim_English.DLSTRINGS")).toBe(true);
    expect(isStringsFileName("Skyrim.esm")).toBe(false);
  });
});

describe("importMasterFiles", () => {
  it("indexes a plugin's records and reports what it could not use", async () => {
    const plugin = fileOf("Mod.esm", serializeEsp(master()));
    const stray = fileOf("readme.txt", new Uint8Array(4));
    const orphan = fileOf("Other_English.STRINGS", new Uint8Array(8));
    const r = await importMasterFiles([plugin, stray, orphan]);
    expect(r.masters).toHaveLength(1);
    expect(r.masters[0]).toMatchObject({ name: "Mod.esm", count: 2, named: 2, needsStrings: false });
    expect(r.ignored).toEqual(["readme.txt"]);
    expect(r.orphanStrings).toEqual(["Other_English.STRINGS"]);
  });
  it("reports status while it works", async () => {
    const seen: string[] = [];
    await importMasterFiles([fileOf("Mod.esm", serializeEsp(master()))], (t) => seen.push(t));
    expect(seen).toEqual(["Reading Mod.esm…", "Indexing Mod.esm…"]);
  });
});
