import { afterEach, describe, expect, it } from "vitest";
import { extractPlugin, mergeIntoPlugin, newRecordsFor } from "./extract";
import { fileInfo, getEditorId, getSubrecords, markDirty, parseEsp, walkRecords, type EspFile, type EspRecord } from "./format";
import { History } from "./history";
import { copyRecord, createRecord } from "./records";
import { buildPlugin, u32, type SampleRecord } from "./testPlugin";

const flst = (formId: number, edid: string, refs: number[] = []): SampleRecord => ({ type: "FLST", formId, edid, subs: refs.map((id) => ({ type: "LNAM", data: u32(id) })) });
const find = (f: EspFile, edid: string) => [...walkRecords(f.nodes)].find((r) => getEditorId(r) === edid) as EspRecord;
const refsOf = (r: EspRecord) => getSubrecords(r).filter((s) => s.type === "LNAM").map((s) => new DataView(s.data.buffer, s.data.byteOffset).getUint32(0, true));
const out = (bytes: Uint8Array) => parseEsp(bytes, "Out.esp");
const hedr = (f: EspFile) => {
  const d = getSubrecords(f.nodes[0] as EspRecord).find((s) => s.type === "HEDR")!.data;
  return { next: new DataView(d.buffer, d.byteOffset).getUint32(8, true) };
};

let history: History | null = null;
afterEach(() => history?.detach());
const sample = () => {
  history?.detach();
  history = new History();
  history.attach();
  const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [flst(0x01000800, "Existing"), flst(0x00012eb7, "OverrideOfSkyrim")]);
  const made = createRecord(history, file, "FLST", "NewList");
  // an existing record is changed to point at the new one
  const existing = find(file, "Existing");
  markDirty(existing);
  getSubrecords(existing).push({ type: "LNAM", data: u32(made.formId) });
  return { file, made, existing };
};

describe("Extract with records made this session", () => {
  it("writes a made record as a new record of the extracted plugin, not as an override of the source", () => {
    const { file, made } = sample();
    expect(made.formId >>> 24).toBe(1); // the source plugin's own slot
    const result = out(extractPlugin(file, [made]));
    expect(fileInfo(result).masters).toEqual(["Skyrim.esm", "Mod.esp"]);
    const r = find(result, "NewList");
    expect(r.formId >>> 24).toBe(2); // the extracted plugin's own slot, one after the source
    expect(r.formId & 0xffffff).toBe(made.formId & 0xffffff);
  });

  it("renumbers references to it, and brings along a made record that a chosen record needs", () => {
    const { file, made, existing } = sample();
    expect(newRecordsFor(file, [existing]).map(getEditorId)).toEqual(["NewList"]);
    const result = out(extractPlugin(file, [existing])); // only the edited record is chosen
    const newId = find(result, "NewList").formId;
    expect(newId >>> 24).toBe(2);
    expect(refsOf(find(result, "Existing"))).toEqual([newId]);
    // nothing in the output points at the source's slot for a record the source does not have
    const sourceHad = new Set([0x01000800]);
    for (const r of walkRecords(result.nodes)) for (const ref of refsOf(r)) if (ref >>> 24 === 1) expect(sourceHad.has(ref)).toBe(true);
    expect(made.formId >>> 24).toBe(1);
  });

  it("leaves the edited plugin itself untouched", () => {
    const { file, made, existing } = sample();
    extractPlugin(file, [existing, made]);
    expect(made.formId >>> 24).toBe(1);
    expect(refsOf(existing)).toEqual([made.formId]);
    expect(find(file, "NewList")).toBe(made);
    expect(file.created).toEqual([made]);
  });

  it("keeps copies working: a copy of a record points at the same masters and is new in the extract", () => {
    history?.detach();
    history = new History();
    history.attach();
    const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [flst(0x01000800, "Original", [0x00012eb7])]);
    const copy = copyRecord(history, file, find(file, "Original"), "OriginalCopy");
    const r = find(out(extractPlugin(file, [copy])), "OriginalCopy");
    expect(r.formId >>> 24).toBe(2);
    expect(refsOf(r)).toEqual([0x00012eb7]); // still points at Skyrim.esm
  });

  it("changes nothing for an ordinary extract, even when new records exist elsewhere in the plugin", () => {
    const { file } = sample();
    const plain = find(file, "OverrideOfSkyrim");
    markDirty(plain);
    const result = out(extractPlugin(file, [plain]));
    expect([...walkRecords(result.nodes)].filter((r) => r.type !== "TES4").map((r) => [getEditorId(r), r.formId])).toEqual([["OverrideOfSkyrim", 0x00012eb7]]);
    expect(newRecordsFor(file, [plain])).toEqual([]);
  });

  it("does nothing special for a plugin with no new records", () => {
    const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [flst(0x01000800, "A", [0x01000801]), flst(0x01000801, "B")]);
    markDirty(find(file, "A"));
    const result = out(extractPlugin(file, [find(file, "A")]));
    expect(refsOf(find(result, "A"))).toEqual([0x01000801]);
  });
});

describe("Adding records made this session to an existing patch", () => {
  const patchBytes = () => {
    // a patch that already lists Mod.esp as a master, and has a record of its own whose ID matches the new record's
    const p = buildPlugin("Patch.esp", ["Skyrim.esm", "Mod.esp"], [flst(0x02000801, "PatchOwn"), flst(0x01000800, "Existing")]);
    return p;
  };

  it("gives them IDs the patch does not use and renumbers references to them", () => {
    const { file, made, existing } = sample();
    const patch = patchBytes();
    const before = hedr(patch).next;
    const result = mergeIntoPlugin(patch, file, [existing]);
    expect(result.newRecords).toBe(1);
    expect(result.replaced).toBe(1); // only the override of Mod.esp's record 800
    const merged = out(result.bytes);
    const newRec = find(merged, "NewList");
    expect(newRec.formId >>> 24).toBe(2);
    expect(newRec.formId & 0xffffff).not.toBe(0x801); // the patch's own record keeps its ID
    expect(find(merged, "PatchOwn").formId).toBe(0x02000801);
    expect(refsOf(find(merged, "Existing"))).toEqual([newRec.formId]);
    expect(hedr(merged).next).toBeGreaterThan(newRec.formId & 0xffffff);
    expect(hedr(merged).next).toBeGreaterThanOrEqual(before);
    expect(made.formId >>> 24).toBe(1);
  });

  it("puts the new record in the patch's own slot even when the patch lists more masters than the source", () => {
    const { file, existing } = sample();
    const patch = buildPlugin("Patch.esp", ["Skyrim.esm", "Mod.esp", "Other.esp"], [flst(0x01000800, "Existing")]);
    const merged = out(mergeIntoPlugin(patch, file, [existing]).bytes);
    expect(find(merged, "NewList").formId >>> 24).toBe(3);
  });
});
