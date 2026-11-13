import { describe, expect, it } from "vitest";
import { defaultLanguage, findPluginsByName, scanSkyrimFolder, stringsLanguage, type FolderItem, type ListFolder } from "./skyrimFolder";

const file = (name: string): FolderItem => ({ name, uri: `content://x/${name}`, dir: false, size: 10 });
const dir = (name: string): FolderItem => ({ name, uri: `content://x/${name}`, dir: true, size: 0 });

/** A fake folder tree: path (lower case, joined by /) -> entries. */
const fake = (tree: Record<string, FolderItem[]>): ListFolder => async (path) => {
  const key = path.join("/").toLowerCase();
  return key in tree ? { found: true, entries: tree[key]! } : { found: false, entries: [] };
};

describe("stringsLanguage", () => {
  it("reads the language from Skyrim's own strings files only", () => {
    expect(stringsLanguage("Skyrim_English.STRINGS")).toBe("english");
    expect(stringsLanguage("Update_French.DLSTRINGS")).toBe("french");
    expect(stringsLanguage("Dawnguard_german.ilstrings")).toBe("german");
    expect(stringsLanguage("SomeMod_English.STRINGS")).toBe(null);
    expect(stringsLanguage("Skyrim.esm")).toBe(null);
  });
});

describe("scanSkyrimFolder", () => {
  it("finds the plugins when the Data folder itself was picked", async () => {
    const scan = await scanSkyrimFolder(fake({ "": [file("skyrim.esm"), file("Update.esm"), file("MyMod.esp"), dir("Strings")], strings: [file("Skyrim_English.STRINGS"), file("Skyrim_English.DLSTRINGS"), file("Skyrim_French.STRINGS")] }));
    expect(scan?.dataPath).toEqual([]);
    expect(scan?.plugins.map((p) => p.name)).toEqual(["skyrim.esm", "Update.esm"]); // in load order, ignoring other mods
    expect([...scan!.strings.keys()].sort()).toEqual(["english", "french"]);
    expect(scan!.strings.get("english")).toHaveLength(2);
  });
  it("goes into Data when Skyrim's main folder was picked", async () => {
    const scan = await scanSkyrimFolder(fake({ "": [file("TESV.exe"), dir("Data")], data: [file("Skyrim.esm")] }));
    expect(scan?.dataPath).toEqual(["Data"]);
    expect(scan?.plugins).toHaveLength(1);
    expect(scan!.strings.size).toBe(0); // strings are usually packed in a BSA
  });
  it("says so when it is not a Skyrim folder", async () => {
    expect(await scanSkyrimFolder(fake({ "": [file("notes.txt"), dir("Pictures")] }))).toBe(null);
    expect(await scanSkyrimFolder(fake({}))).toBe(null);
  });
});

describe("the Unofficial Patch", () => {
  it("is found with Skyrim's own plugins, current name or older name, and nothing else is", async () => {
    const scan = await scanSkyrimFolder(
      fake({ "": [file("Skyrim.esm"), file("Unofficial Skyrim Patch.esp"), file("unofficial skyrim legendary edition patch.esp"), file("Other.esp")] }),
    );
    expect(scan?.plugins.map((p) => p.name)).toEqual(["Skyrim.esm", "unofficial skyrim legendary edition patch.esp", "Unofficial Skyrim Patch.esp"]);
  });
  it("is a known plugin even when only the patch is there", async () => {
    const scan = await scanSkyrimFolder(fake({ "": [file("Unofficial Skyrim Legendary Edition Patch.esp")] }));
    expect(scan?.plugins).toHaveLength(1);
  });
  it("has strings files recognised by its name too", () => {
    expect(stringsLanguage("Unofficial Skyrim Legendary Edition Patch_English.STRINGS")).toBe("english");
  });
});

describe("findPluginsByName", () => {
  it("finds any plugin in the Data folder by name and lists the ones that are missing", async () => {
    const scan = (await scanSkyrimFolder(fake({ "": [file("Skyrim.esm"), file("SomeMod.esp"), dir("Strings")], strings: [] })))!;
    const { found, missing } = findPluginsByName(scan, ["skyrim.esm", "SOMEMOD.ESP", "Gone.esp"]);
    expect(found.map((f) => f.name)).toEqual(["Skyrim.esm", "SomeMod.esp"]);
    expect(missing).toEqual(["Gone.esp"]);
  });
});

describe("defaultLanguage", () => {
  it("prefers English, else the first found", () => {
    expect(defaultLanguage(new Map([["french", []], ["english", []]]))).toBe("english");
    expect(defaultLanguage(new Map([["german", []]]))).toBe("german");
    expect(defaultLanguage(new Map())).toBe(null);
  });
});
