import { describe, expect, it } from "vitest";
import { chooseLanguage, listArchiveStrings, lz4Decode, parseBsa, pluginBase, readBsaFile, stringsFileName } from "./bsa";
import { parseStringsFile } from "./strings";
import { buildBsa, lz4Block, lz4Frame, repetitive, stringsFile, text } from "./testBsa";

describe("lz4Decode", () => {
  it("decodes a hand-made block (one literal and an overlapping match)", () => {
    // token 0x17: 1 literal, match length 7+4; literal 'a'; offset 1
    expect(Array.from(lz4Decode(Uint8Array.from([0x17, 0x61, 0x01, 0x00]), 12))).toEqual(Array(12).fill(0x61));
  });

  it("round-trips a frame, including long literal runs and several blocks", () => {
    const noise = Uint8Array.from({ length: 700 }, (_, i) => (i * 7919 + (i >> 3) * 31) & 0xff);
    const data = new Uint8Array([...repetitive(2000), ...noise, ...repetitive(500)]);
    expect(Array.from(lz4Decode(lz4Frame(data), data.length))).toEqual(Array.from(data));
    expect(Array.from(lz4Decode(lz4Frame(data, 4096), data.length))).toEqual(Array.from(data));
  });

  it("handles blocks stored uncompressed", () => {
    const data = repetitive(300);
    expect(Array.from(lz4Decode(lz4Frame(data, 1000, [0, 2]), data.length))).toEqual(Array.from(data));
  });

  it("accepts a bare block and refuses damaged data", () => {
    const data = repetitive(50);
    expect(Array.from(lz4Decode(Uint8Array.from(lz4Block(data)), data.length))).toEqual(Array.from(data));
    expect(() => lz4Decode(Uint8Array.from([0x17, 0x61, 0x00, 0x00]), 12)).toThrow("before the start");
    expect(() => lz4Decode(Uint8Array.from([0x17, 0x61, 0x05, 0x00]), 12)).toThrow("before the start");
    const framed = lz4Frame(data);
    expect(() => lz4Decode(framed.subarray(0, framed.length - 20), data.length)).toThrow();
    expect(() => lz4Decode(lz4Frame(data), 10)).toThrow("larger than expected");
  });
});

const sample = [
  { folder: "strings", name: "skyrim_english.strings", data: stringsFile([[1, "Iron Sword"], [2, "Steel Sword"]]) },
  { folder: "strings", name: "skyrim_english.dlstrings", data: stringsFile([[7, "A long description"]], true) },
  { folder: "strings", name: "skyrim_german.strings", data: stringsFile([[1, "Eisenschwert"]]) },
  { folder: "interface", name: "fontconfig.txt", data: repetitive(100) },
];

describe("parseBsa / readBsaFile", () => {
  for (const [label, version, compress] of [
    ["Legendary Edition, zlib", 104, true],
    ["Special Edition, LZ4", 105, true],
    ["Special Edition, not compressed", 105, false],
  ] as const) {
    it(`reads ${label}`, () => {
      const a = parseBsa(buildBsa(version, sample, { compress }));
      expect(a.version).toBe(version);
      expect(a.entries.map((e) => e.path)).toEqual(["strings\\skyrim_english.strings", "strings\\skyrim_english.dlstrings", "strings\\skyrim_german.strings", "interface\\fontconfig.txt"]);
      for (const f of sample) {
        const e = a.entries.find((x) => x.name === f.name)!;
        expect(Array.from(readBsaFile(a, e))).toEqual(Array.from(f.data));
      }
      const table = parseStringsFile("Skyrim_English.STRINGS", readBsaFile(a, a.entries[0]!));
      expect(table.get(2)).toBe("Steel Sword");
    });
  }

  it("honours the per-file compression toggle and embedded file names", () => {
    const files = [
      { ...sample[0]!, toggle: true },
      { ...sample[1]! },
    ];
    for (const version of [104, 105] as const) {
      for (const embed of [false, true]) {
        const a = parseBsa(buildBsa(version, files, { compress: false, embed }));
        expect(a.entries.map((e) => e.compressed)).toEqual([true, false]);
        files.forEach((f, i) => expect(Array.from(readBsaFile(a, a.entries[i]!))).toEqual(Array.from(f.data)));
      }
    }
  });

  it("says what is wrong with archives it cannot read", () => {
    expect(() => parseBsa(text("not an archive at all, not at all, not at all"))).toThrow("not a BSA");
    const old = buildBsa(104, sample);
    old[4] = 103;
    expect(() => parseBsa(old)).toThrow("version 103");
    expect(() => parseBsa(buildBsa(104, sample).subarray(0, 60))).toThrow();
    const a = parseBsa(buildBsa(105, sample, { compress: true }));
    const cut = { ...a, bytes: a.bytes.subarray(0, a.bytes.length - 30) };
    expect(() => readBsaFile(cut, cut.entries[3]!)).toThrow();
  });
});

describe("strings files in an archive", () => {
  it("lists them by plugin and language and names them like the game does", () => {
    const list = listArchiveStrings(parseBsa(buildBsa(105, sample, { compress: true })));
    expect(list.map((s) => `${s.plugin}/${s.language}/${s.ext}`)).toEqual(["skyrim/english/strings", "skyrim/english/dlstrings", "skyrim/german/strings"]);
    expect(stringsFileName("Skyrim.esm", list[1]!)).toBe("Skyrim_English.DLSTRINGS");
    expect(pluginBase("Dawnguard.ESM")).toBe("dawnguard");
    expect(chooseLanguage(list.map((s) => s.language))).toBe("english");
    expect(chooseLanguage(["polish", "german"])).toBe("german");
    expect(chooseLanguage([])).toBeNull();
  });
});
