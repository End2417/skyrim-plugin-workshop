import { describe, expect, it } from "vitest";
import { addMaster, addMasterProblem, HEADER_FLAG_ESL, HEADER_FLAG_ESM, readHeader, renameMaster, setHeaderFlag, setHeaderText, validMasterName } from "./header";
import { checkEsl } from "./esl";
import { History } from "./history";
import { getSubrecords, parseEsp, serializeEsp, type EspRecord } from "./format";
import { buildPlugin } from "./testPlugin";

const weapon = (formId: number, edid: string) => ({ type: "WEAP", formId, edid });

describe("header editing", () => {
  it("reads the header", () => {
    const f = buildPlugin("Mod.esp", ["Skyrim.esm", "Update.esm"], [weapon(0x02000800, "A"), weapon(0x00012eb7, "B")]);
    const h = readHeader(f)!;
    expect(h.masters).toEqual(["Skyrim.esm", "Update.esm"]);
    expect(h.ownRecords).toBe(1);
    expect(h.author).toBe("");
    expect(h.version).toBeCloseTo(1.7, 3);
  });

  it("sets and clears author and description in the right place, and survives saving", () => {
    const f = buildPlugin("Mod.esp", ["Skyrim.esm"], [weapon(0x01000800, "A")]);
    setHeaderText(f, "SNAM", "A description");
    setHeaderText(f, "CNAM", "Me");
    expect(getSubrecords(f.nodes[0] as EspRecord).map((s) => s.type)).toEqual(["HEDR", "CNAM", "SNAM", "MAST", "DATA"]);
    const back = parseEsp(serializeEsp(f), "Mod.esp");
    expect(readHeader(back)).toMatchObject({ author: "Me", description: "A description", masters: ["Skyrim.esm"] });
    setHeaderText(f, "SNAM", "");
    expect(readHeader(f)!.description).toBe("");
    expect(() => setHeaderText(f, "CNAM", "x".repeat(600))).toThrow(/too long/);
  });

  it("turns the ESM and ESL flags on and off, and nothing else", () => {
    const f = buildPlugin("Mod.esp", [], []);
    setHeaderFlag(f, HEADER_FLAG_ESM, true);
    setHeaderFlag(f, HEADER_FLAG_ESL, true);
    expect(readHeader(f)!.flags & 0x201).toBe(0x201);
    setHeaderFlag(f, HEADER_FLAG_ESL, false);
    expect(readHeader(f)!.flags & 0x201).toBe(0x1);
    expect(() => setHeaderFlag(f, 0x80, true)).toThrow(/Only the ESM and ESL/);
  });

  it("renames a master without changing the order", () => {
    const f = buildPlugin("Mod.esp", ["Skyrim.esm", "Update.esm"], []);
    renameMaster(f, 1, "update.esm");
    expect(readHeader(f)!.masters).toEqual(["Skyrim.esm", "update.esm"]);
    expect(() => renameMaster(f, 1, "skyrim.ESM")).toThrow(/already a master/);
    expect(() => renameMaster(f, 5, "x.esm")).toThrow(/no such master/);
    expect(() => renameMaster(f, 0, "nope")).toThrow(/ending in/);
  });

  it("adds a master only when the plugin has no records of its own", () => {
    const patch = buildPlugin("Patch.esp", ["Skyrim.esm"], [weapon(0x00012eb7, "Override")]);
    expect(addMasterProblem(patch, "Update.esm")).toBeNull();
    addMaster(patch, "Update.esm");
    expect(readHeader(patch)!.masters).toEqual(["Skyrim.esm", "Update.esm"]);
    expect(getSubrecords(patch.nodes[0] as EspRecord).map((s) => s.type)).toEqual(["HEDR", "MAST", "DATA", "MAST", "DATA"]);
    expect(parseEsp(serializeEsp(patch), "x.esp")).toBeTruthy();

    const withNew = buildPlugin("New.esp", ["Skyrim.esm"], [weapon(0x01000800, "Mine")]);
    expect(addMasterProblem(withNew, "Update.esm")).toMatch(/renumber/);
    expect(() => addMaster(withNew, "Update.esm")).toThrow(/renumber/);
    expect(addMasterProblem(patch, "skyrim.esm")).toMatch(/already/);
    expect(validMasterName("a.esp")).toBe(true);
    expect(validMasterName("a.txt")).toBe(false);
  });

  it("can be undone", () => {
    const h = new History({ now: () => 0 });
    h.attach();
    try {
      const f = buildPlugin("Mod.esp", [], []);
      setHeaderText(f, "CNAM", "Me");
      h.undo();
      expect(readHeader(f)!.author).toBe("");
    } finally {
      h.detach();
    }
  });
});

describe("checkEsl", () => {
  const withIds = (version: number, ids: number[]) => {
    const f = buildPlugin("Mod.esp", ["Skyrim.esm"], ids.map((id, i) => weapon(0x01000000 | id, `W${i}`)));
    const hedr = getSubrecords(f.nodes[0] as EspRecord).find((s) => s.type === "HEDR")!;
    new DataView(hedr.data.buffer).setFloat32(0, version, true);
    return f;
  };

  it("accepts a plugin whose new records are all in 800-FFF", () => {
    const r = checkEsl(withIds(1.7, [0x800, 0x801, 0xfff]))!;
    expect(r).toMatchObject({ eligible: true, newRecords: 3, lowest: 0x800, highest: 0xfff, windowMin: 0x800 });
  });

  it("lists records outside the window", () => {
    const r = checkEsl(withIds(1.7, [0x800, 0x1000, 0x7ff]))!;
    expect(r.eligible).toBe(false);
    expect(r.outside).toHaveLength(2);
    expect(r.reasons[0]).toMatch(/2 of 3/);
  });

  it("allows the lower IDs with a newer header version", () => {
    expect(checkEsl(withIds(1.7, [0x001]))!.eligible).toBe(false);
    const newer = checkEsl(withIds(1.71, [0x001, 0x7ff]))!;
    expect(newer.eligible).toBe(true);
    expect(newer.windowMin).toBe(1);
  });

  it("ignores overrides and counts a plugin with no new records as eligible", () => {
    const f = buildPlugin("Patch.esp", ["Skyrim.esm"], [weapon(0x00012eb7, "Override")]);
    expect(checkEsl(f)).toMatchObject({ eligible: true, newRecords: 0, lowest: null });
  });

  it("notes a next object ID above FFF", () => {
    const f = withIds(1.7, [0x800]);
    const hedr = getSubrecords(f.nodes[0] as EspRecord).find((s) => s.type === "HEDR")!;
    new DataView(hedr.data.buffer).setUint32(8, 0x2000, true);
    const r = checkEsl(f)!;
    expect(r.eligible).toBe(true);
    expect(r.nextIdTooHigh).toBe(true);
    expect(r.reasons[0]).toMatch(/next object ID/);
  });
});
