import { describe, expect, it } from "vitest";
import { buildPlugin } from "./testPlugin";
import { serializeEsp } from "./format";
import { importMasterFiles, importMasterSources, isArchiveFileName, isPluginFileName, isStringsFileName, type FileSource } from "./masterImport";
import { buildBsa, stringsFile } from "./testBsa";
import type { EspRecord } from "./format";

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

describe("strings from BSA archives", () => {
  /** A localized plugin: its names are string IDs. */
  const localized = (name: string) => {
    const file = buildPlugin(name, [], [
      { type: "WEAP", formId: 0x00000800, edid: "IronSword", subs: [{ type: "FULL", data: Uint8Array.from([1, 0, 0, 0]) }] },
      { type: "WEAP", formId: 0x00000801, edid: "SteelSword", subs: [{ type: "FULL", data: Uint8Array.from([2, 0, 0, 0]) }] },
    ]);
    (file.nodes[0] as EspRecord).flags |= 0x80;
    return serializeEsp(file);
  };
  const archive = (version: 104 | 105) =>
    buildBsa(
      version,
      [
        { folder: "strings", name: "skyrim_english.strings", data: stringsFile([[1, "Iron Sword"], [2, "Steel Sword"]]) },
        { folder: "strings", name: "skyrim_french.strings", data: stringsFile([[1, "Epee de fer"]]) },
        { folder: "strings", name: "other_english.strings", data: stringsFile([[9, "Not ours"]]) },
      ],
      { compress: true },
    );
  const source = (name: string, bytes: Uint8Array): FileSource & { reads: number } => {
    const s = { name, reads: 0, read: async () => (s.reads++, bytes) };
    return s;
  };

  it("recognises archive file names", () => {
    expect(isArchiveFileName("Skyrim - Interface.bsa")).toBe(true);
    expect(isArchiveFileName("Skyrim.esm")).toBe(false);
  });

  for (const version of [104, 105] as const) {
    it(`takes a localized plugin's names from a version ${version} archive (English preferred)`, async () => {
      const bsa = source("Skyrim - Interface.bsa", archive(version));
      const r = await importMasterSources([source("Skyrim.esm", localized("Skyrim.esm")), bsa]);
      expect(r.masters[0]).toMatchObject({ name: "Skyrim.esm", needsStrings: false, stringFiles: 1, named: 2 });
      expect(r.archives).toEqual([{ name: "Skyrim - Interface.bsa", strings: 1 }]);
      expect(r.ignored).toEqual([]);
      expect(r.orphanStrings).toEqual([]);
    });
  }

  it("does not open the archive when no plugin needs it", async () => {
    const bsa = source("Skyrim - Interface.bsa", archive(105));
    const r = await importMasterSources([source("Mod.esm", serializeEsp(master())), bsa]);
    expect(bsa.reads).toBe(0);
    expect(r.archives).toEqual([]);
  });

  it("prefers strings files that were picked over the archive", async () => {
    const bsa = source("Skyrim - Interface.bsa", archive(105));
    const loose = source("Skyrim_English.STRINGS", stringsFile([[1, "Picked"], [2, "Picked 2"]]));
    const r = await importMasterSources([source("Skyrim.esm", localized("Skyrim.esm")), loose, bsa]);
    expect(r.masters[0]).toMatchObject({ needsStrings: false, stringFiles: 1 });
    expect(bsa.reads).toBe(0);
  });

  it("says when an archive cannot be used or has nothing for the plugin", async () => {
    const bad = await importMasterSources([source("Skyrim.esm", localized("Skyrim.esm")), source("Broken.bsa", new Uint8Array(100))]);
    expect(bad.masters[0]).toMatchObject({ needsStrings: true, stringFiles: 0 });
    expect(bad.archives).toEqual([{ name: "Broken.bsa", strings: 0, problem: "This is not a BSA archive." }]);

    const none = await importMasterSources([source("Mine.esp", localized("Mine.esp")), source("Skyrim - Interface.bsa", archive(104))]);
    expect(none.masters[0]).toMatchObject({ needsStrings: true });
    expect(none.archives).toEqual([{ name: "Skyrim - Interface.bsa", strings: 0 }]);
  });
});
