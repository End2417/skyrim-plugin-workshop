import { describe, expect, it } from "vitest";
import { buildPlugin, u32 } from "./testPlugin";
import { LE_FORM_VERSION, convertToLe, detectEdition, isLikelySeOnlyMaster, leFileName } from "./convert";
import { extractPlugin } from "./extract";
import { fileInfo, getSubrecords, parseEsp, walkRecords, zstringValue, type EspFile, type EspRecord } from "./format";

const armor = (formId: number, dnam = u32(1000)) => ({ type: "ARMO", formId, edid: "MyArmor", subs: [{ type: "DNAM", data: dnam }] });
const header = (f: EspFile) => f.nodes[0] as EspRecord;
const hedrVersion = (f: EspFile) => {
  const d = getSubrecords(header(f)).find((s) => s.type === "HEDR")!.data;
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getFloat32(0, true);
};

/** buildPlugin writes what Special Edition writes: HEDR 1.7 and form version 44. */
const sePlugin = (masters = ["Skyrim.esm"], name = "Mod.esp") => buildPlugin(name, masters, [armor(0x01000800)]);

describe("detectEdition", () => {
  it("recognises a Special Edition header", () => {
    const info = detectEdition(sePlugin());
    expect(info.edition).toBe("SE");
    expect(info.newestFormVersion).toBe(44);
    expect(info.reasons.length).toBe(2);
  });

  it("recognises a converted plugin as Legendary Edition", () => {
    const le = parseEsp(convertToLe(sePlugin()).bytes, "Mod.esp");
    expect(detectEdition(le)).toMatchObject({ edition: "LE", reasons: [] });
  });

  it("treats the ESL flag and .esl extension as Special Edition", () => {
    const f = sePlugin([], "Mod.esl");
    expect(detectEdition(f).reasons.join(" ")).toMatch(/\.esl/);
  });
});

describe("convertToLe", () => {
  it("stamps Legendary Edition header and form versions", () => {
    const { bytes, report } = convertToLe(sePlugin());
    const le = parseEsp(bytes, "Mod.esp");
    expect(hedrVersion(le)).toBeCloseTo(0.94, 5);
    for (const r of walkRecords(le.nodes)) expect(r.version).toBeLessThanOrEqual(LE_FORM_VERSION);
    expect(report.changes.join("\n")).toMatch(/0\.94/);
  });

  it("does not modify the open file", () => {
    const f = sePlugin();
    convertToLe(f);
    expect(hedrVersion(f)).toBeCloseTo(1.7, 5);
    expect(detectEdition(f).edition).toBe("SE");
  });

  it("clears the ESL flag and renames the file and .esl masters", () => {
    const f = sePlugin(["Skyrim.esm", "Lib.esl"], "Mod.esl");
    header(f).flags |= 0x200;
    const { bytes, name, report } = convertToLe(f);
    expect(name).toBe("Mod.esp");
    const le = parseEsp(bytes, name);
    expect(header(le).flags & 0x200).toBe(0);
    expect(fileInfo(le).masters).toEqual(["Skyrim.esm", "Lib.esp"]);
    expect(report.warnings.join("\n")).toMatch(/Lib\.esp/);
  });

  it("keeps .esl masters when asked", () => {
    const { bytes, report } = convertToLe(sePlugin(["Lib.esl"]), { renameEslMasters: false });
    expect(fileInfo(parseEsp(bytes)).masters).toEqual(["Lib.esl"]);
    expect(report.warnings.join("\n")).toMatch(/cannot load/);
  });

  it("warns about Creation Club masters", () => {
    const { report } = convertToLe(sePlugin(["Skyrim.esm", "ccBGSSSE001-Fish.esm"]));
    expect(report.warnings.join("\n")).toMatch(/ccBGSSSE001-Fish\.esm.*Creation Club/);
  });

  it("leaves record contents byte-identical by default", () => {
    const f = sePlugin();
    const before = [...walkRecords(f.nodes)].filter((r) => r.type !== "TES4").map((r) => Array.from(getSubrecords(r).flatMap((s) => [...s.data])));
    const le = parseEsp(convertToLe(f).bytes);
    const after = [...walkRecords(le.nodes)].filter((r) => r.type !== "TES4").map((r) => Array.from(getSubrecords(r).flatMap((s) => [...s.data])));
    expect(after).toEqual(before);
  });

  it("includes unsaved edits in the converted copy", () => {
    const f = sePlugin();
    const rec = [...walkRecords(f.nodes)].find((r) => r.type === "ARMO")!;
    getSubrecords(rec).find((s) => s.type === "DNAM")!.data[0] = 0x2a;
    rec.dirty = true;
    const le = parseEsp(convertToLe(f).bytes);
    const out = [...walkRecords(le.nodes)].find((r) => r.type === "ARMO")!;
    expect(getSubrecords(out).find((s) => s.type === "DNAM")!.data[0]).toBe(0x2a);
  });

  it("reports subrecords longer than the LE layout, and only trims when asked", () => {
    const longer = new Uint8Array(8);
    const f = buildPlugin("Mod.esp", ["Skyrim.esm"], [armor(0x01000800, longer)]);
    const plain = convertToLe(f);
    expect(plain.report.layout).toEqual([expect.objectContaining({ recordType: "ARMO", sub: "DNAM", expected: 4, actual: 8, count: 1, trimmed: false })]);
    const kept = [...walkRecords(parseEsp(plain.bytes).nodes)].find((r) => r.type === "ARMO")!;
    expect(getSubrecords(kept).find((s) => s.type === "DNAM")!.data.length).toBe(8);

    const trimmed = convertToLe(f, { trimToLeLayout: true });
    const cut = [...walkRecords(parseEsp(trimmed.bytes).nodes)].find((r) => r.type === "ARMO")!;
    expect(getSubrecords(cut).find((s) => s.type === "DNAM")!.data.length).toBe(4);
  });
});

describe("helpers", () => {
  it("spots Creation Club names only", () => {
    expect(isLikelySeOnlyMaster("ccQDRSSE001-SurvivalMode.esl")).toBe(true);
    expect(isLikelySeOnlyMaster("_ResourcePack.esl")).toBe(true);
    expect(isLikelySeOnlyMaster("Skyrim.esm")).toBe(false);
    expect(isLikelySeOnlyMaster("Dawnguard.esm")).toBe(false);
  });
  it("renames .esl to .esp", () => expect(leFileName("A.ESL")).toBe("A.esp"));
  it("zstringValue sanity", () => expect(zstringValue(new Uint8Array([65, 0]))).toBe("A"));
});

describe("extracting from a Special Edition plugin as Legendary Edition", () => {
  it("produces an LE-format patch that still lists the source as its last master", () => {
    const f = sePlugin();
    const rec = [...walkRecords(f.nodes)].find((r) => r.type === "ARMO")!;
    getSubrecords(rec);
    rec.dirty = true;
    const extracted = parseEsp(extractPlugin(f, [rec], { sourceName: "Mod.esp" }), "Out.esp");
    expect(detectEdition(extracted).edition).toBe("SE");
    const le = parseEsp(convertToLe(extracted).bytes, "Out.esp");
    expect(detectEdition(le).edition).toBe("LE");
    expect(fileInfo(le).masters).toEqual(["Skyrim.esm", "Mod.esp"]);
  });
});
