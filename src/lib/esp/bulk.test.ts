import { describe, expect, it } from "vitest";
import { buildPlugin } from "./testPlugin";
import { getSubrecords, walkRecords, type EspRecord } from "./format";
import { decodeSubrecord } from "./decode";
import { applyBulkChanges, listBulkFields, matchesWords, planBulkEdit } from "./bulk";

/** ARMO DATA: Value (int32) then Weight (float32). */
const data = (value: number, weight: number) => {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setInt32(0, value, true);
  dv.setFloat32(4, weight, true);
  return b;
};
const armor = (formId: number, edid: string, value: number, weight: number) => ({ type: "ARMO", formId, edid, subs: [{ type: "DATA", data: data(value, weight) }] });

const records = (): EspRecord[] => {
  const f = buildPlugin("T.esp", ["Skyrim.esm"], [
    armor(0x01000800, "ArmorIronCuirass", 100, 25),
    armor(0x01000801, "ArmorIronHelmet", 60, 5),
    armor(0x01000802, "ArmorSteelCuirass", 500, 30),
  ]);
  return [...walkRecords(f.nodes)].filter((r) => r.type === "ARMO");
};
const field = (rs: EspRecord[], label: RegExp) => listBulkFields(rs, false).find((f) => label.test(f.label))!;
const weights = (rs: EspRecord[]) =>
  rs.map((r) => {
    const s = getSubrecords(r)[1]!; // after the Editor ID
    return new DataView(s.data.buffer, s.data.byteOffset).getFloat32(4, true);
  });

describe("listBulkFields", () => {
  it("finds the numeric fields of a record type by name", () => {
    const labels = listBulkFields(records(), false).map((f) => f.label);
    expect(labels.some((l) => /Weight/.test(l))).toBe(true);
    expect(labels.some((l) => /Value/.test(l))).toBe(true);
  });
});

describe("planBulkEdit", () => {
  it("halves a float field and lists every change", () => {
    const rs = records();
    const plan = planBulkEdit(rs, { field: field(rs, /Weight/), op: "multiply", value: 0.5 }, false);
    expect(plan.map((c) => [c.edid, c.before, c.after])).toEqual([
      ["ArmorIronCuirass", 25, 12.5],
      ["ArmorIronHelmet", 5, 2.5],
      ["ArmorSteelCuirass", 30, 15],
    ]);
    expect(plan.every((c) => c.error === null)).toBe(true);
  });
  it("changes a whole-number field by a percentage and rounds it", () => {
    const rs = records();
    const plan = planBulkEdit(rs, { field: field(rs, /Value/), op: "percent", value: 10 }, false);
    expect(plan.map((c) => c.after)).toEqual([110, 66, 550]);
  });
  it("sets and adds, and leaves out records that would not change", () => {
    const rs = records();
    expect(planBulkEdit(rs, { field: field(rs, /Value/), op: "set", value: 60 }, false).map((c) => c.edid)).toEqual(["ArmorIronCuirass", "ArmorSteelCuirass"]);
    expect(planBulkEdit(rs, { field: field(rs, /Value/), op: "add", value: -1 }, false).map((c) => c.after)).toEqual([99, 59, 499]);
  });
  it("flags values that do not fit and does not apply them", () => {
    const rs = records();
    const plan = planBulkEdit(rs, { field: field(rs, /Value/), op: "multiply", value: 100_000_000 }, false);
    expect(plan.every((c) => c.error !== null)).toBe(true);
    expect(applyBulkChanges(plan, false)).toBe(0);
  });
});

describe("applyBulkChanges", () => {
  it("writes the changes and marks the records modified", () => {
    const rs = records();
    const plan = planBulkEdit(rs, { field: field(rs, /Weight/), op: "multiply", value: 0.5 }, false);
    expect(applyBulkChanges(plan, false)).toBe(3);
    expect(weights(rs)).toEqual([12.5, 2.5, 15]);
    expect(rs.every((r) => r.dirty)).toBe(true);
  });
  it("skips changes the person unticked (not passed in)", () => {
    const rs = records();
    const plan = planBulkEdit(rs, { field: field(rs, /Weight/), op: "multiply", value: 2 }, false);
    expect(applyBulkChanges(plan.slice(0, 1), false)).toBe(1);
    expect(weights(rs)).toEqual([50, 5, 30]);
  });
  it("reads back through the normal decoder", () => {
    const rs = records();
    applyBulkChanges(planBulkEdit(rs, { field: field(rs, /Weight/), op: "set", value: 1 }, false), false);
    const node = decodeSubrecord("ARMO", getSubrecords(rs[0]!)[1]!, "ArmorIronCuirass", { localized: false, resolveFormId: String });
    expect(JSON.stringify(node)).toContain('"display":"1"');
  });
});

describe("matchesWords", () => {
  it("needs every word in the Editor ID or name", () => {
    const [iron] = records();
    expect(matchesWords(iron!, "iron cuirass", false)).toBe(true);
    expect(matchesWords(iron!, "iron helmet", false)).toBe(false);
    expect(matchesWords(iron!, "", false)).toBe(true);
  });
});

// ---------- upgrades: several fields, choices and flags, CSV, presets ----------
import { bulkEditProblem, deletePreset, exportBulkCsv, formatBulkValue, loadPresets, parseCsv, planBulkEdits, planCsvImport, presetEdits, presetFromEdits, savePreset } from "./bulk";

/** WEAP DNAM-less sample: ALCH ENIT is awkward, so use a record with an enum and flags: ARMO BOD2 is not in the layout; use MGEF-free KYWD? Use AMMO DATA (flags). */
const ammoRecords = (): EspRecord[] => {
  const d = (flags: number, damage: number, value: number) => {
    const b = new Uint8Array(16);
    const dv = new DataView(b.buffer);
    dv.setUint32(4, flags, true);
    dv.setFloat32(8, damage, true);
    dv.setUint32(12, value, true);
    return b;
  };
  const f = buildPlugin("A.esp", ["Skyrim.esm"], [
    { type: "AMMO", formId: 0x01000800, edid: "AmmoA", subs: [{ type: "DATA", data: d(0x1, 8, 2) }] },
    { type: "AMMO", formId: 0x01000801, edid: "AmmoB", subs: [{ type: "DATA", data: d(0x0, 10, 3) }] },
  ]);
  return [...walkRecords(f.nodes)].filter((r) => r.type === "AMMO");
};
const ammoField = (rs: EspRecord[], re: RegExp) => listBulkFields(rs, false).find((f) => re.test(f.label))!;
const ammoFlags = (r: EspRecord) => new DataView(getSubrecords(r)[1]!.data.buffer, getSubrecords(r)[1]!.data.byteOffset).getUint32(4, true);

describe("bulk edit: several fields in one run", () => {
  it("plans every edit and applies them together", () => {
    const rs = records();
    const edits = [
      { field: field(rs, /Weight/), op: "multiply" as const, value: 0.5 },
      { field: field(rs, /Value/), op: "add" as const, value: 10 },
    ];
    const plan = planBulkEdits(rs, edits, false);
    expect(plan).toHaveLength(6);
    expect(applyBulkChanges(plan, false)).toBe(3);
    expect(weights(rs)).toEqual([12.5, 2.5, 15]);
    const values = rs.map((r) => new DataView(getSubrecords(r)[1]!.data.buffer, getSubrecords(r)[1]!.data.byteOffset).getInt32(0, true));
    expect(values).toEqual([110, 70, 510]);
  });

  it("refuses to change one field twice in the same run", () => {
    const rs = records();
    const f = field(rs, /Weight/);
    expect(() =>
      planBulkEdits(rs, [{ field: f, op: "add", value: 1 }, { field: f, op: "multiply", value: 2 }], false),
    ).toThrow(/changed twice/);
  });
});

describe("bulk edit: choices and flags", () => {
  it("lists flags and choices as fields with their options", () => {
    const rs = ammoRecords();
    const fields = listBulkFields(rs, false);
    const flags = fields.find((f) => f.kind === "flags");
    expect(flags).toBeTruthy();
    expect(Object.values(flags!.options!).length).toBeGreaterThan(0);
  });

  it("turns flags on and off without touching the other bits", () => {
    const rs = ammoRecords();
    const flags = listBulkFields(rs, false).find((f) => f.kind === "flags")!;
    const bit = Number(Object.keys(flags.options!)[0]);
    const on = planBulkEdits(rs, [{ field: flags, op: "setFlags", value: bit }], false);
    applyBulkChanges(on, false);
    expect(rs.map((r) => (ammoFlags(r) & bit) !== 0)).toEqual([true, true]);
    const off = planBulkEdits(rs, [{ field: flags, op: "clearFlags", value: bit }], false);
    applyBulkChanges(off, false);
    expect(rs.map(ammoFlags)).toEqual([0, 0]);
    expect(formatBulkValue(flags, bit)).toBe(flags.options![bit]);
    expect(formatBulkValue(flags, 0)).toBe("(none)");
  });

  it("validates edits before they run", () => {
    const rs = ammoRecords();
    const flags = listBulkFields(rs, false).find((f) => f.kind === "flags")!;
    const num = ammoField(rs, /Value/);
    expect(bulkEditProblem({ field: flags, op: "setFlags", value: 0 })).toMatch(/at least one flag/);
    expect(bulkEditProblem({ field: flags, op: "multiply", value: 2 })).toMatch(/does not apply/);
    expect(bulkEditProblem({ field: num, op: "add", value: Number.NaN })).toMatch(/Enter a number/);
    expect(bulkEditProblem({ field: num, op: "add", value: 5 })).toBeNull();
  });
});

describe("bulk edit: CSV", () => {
  it("parses quotes, commas, line breaks and a byte order mark", () => {
    expect(parseCsv('\uFEFFa,"b,c","d ""q"""\r\n1,2,"x\ny"\n\n')).toEqual([
      ["a", "b,c", 'd "q"'],
      ["1", "2", "x\ny"],
    ]);
  });

  it("exports values and brings edited ones back as changes", () => {
    const rs = records();
    const fields = listBulkFields(rs, false);
    const weight = field(rs, /Weight/);
    const csv = exportBulkCsv(rs, [weight], false);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(`FormID,Type,Editor ID,Name,${weight.key}`);
    expect(lines[1]).toBe("01000800,ARMO,ArmorIronCuirass,,25");
    // edit the file: the first armor goes from 25 to 12, the second is left, a third row names a record that is not there
    const edited = [lines[0], "01000800,ARMO,ArmorIronCuirass,,12", "01000801,ARMO,ArmorIronHelmet,,5", "01009999,ARMO,Missing,,1"].join("\n");
    const plan = planCsvImport(rs, edited, fields, false);
    expect(plan.rows).toBe(3);
    expect(plan.matched).toBe(2);
    expect(plan.changes.map((c) => [c.edid, c.before, c.after])).toEqual([["ArmorIronCuirass", 25, 12]]);
    expect(plan.problems).toEqual(["Row 4: no record 01009999 among the records chosen."]);
    applyBulkChanges(plan.changes, false);
    expect(weights(rs)).toEqual([12, 5, 30]);
  });

  it("matches rows by Editor ID when there is no FormID column, and reports what it cannot use", () => {
    const rs = records();
    const fields = listBulkFields(rs, false);
    const weight = field(rs, /Weight/);
    const plan = planCsvImport(rs, `Editor ID,${weight.key},Nonsense\nARMORSTEELCUIRASS,20,1\nArmorIronHelmet,abc,2`, fields, false);
    expect(plan.changes.map((c) => [c.edid, c.after])).toEqual([["ArmorSteelCuirass", 20]]);
    expect(plan.problems).toContain('Column "Nonsense" is not a field of these records and was ignored.');
    expect(plan.problems.some((p) => /"abc" is not a number/.test(p))).toBe(true);
    expect(planCsvImport(rs, "Name,Foo\nx,1", fields, false).problems[0]).toMatch(/FormID/);
    expect(planCsvImport(rs, "", fields, false).problems[0]).toMatch(/empty/);
  });
});

describe("bulk edit: presets", () => {
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
  };

  it("saves, lists, replaces and deletes presets, and maps them back onto the fields", () => {
    const rs = records();
    const fields = listBulkFields(rs, false);
    const preset = presetFromEdits("Lighter iron", "ARMO", "iron", [{ field: field(rs, /Weight/), op: "multiply", value: 0.5 }]);
    expect(savePreset(preset)).toBe(true);
    expect(savePreset({ ...preset, words: "steel" })).toBe(true); // same name and type: replaced
    expect(loadPresets()).toHaveLength(1);
    expect(loadPresets()[0]!.words).toBe("steel");
    const { edits, missing } = presetEdits({ ...preset, edits: [...preset.edits, { fieldKey: "XXXX|Nope", op: "set", value: 1 }] }, fields);
    expect(edits.map((e) => [e.field.key, e.op, e.value])).toEqual([[field(rs, /Weight/).key, "multiply", 0.5]]);
    expect(missing).toEqual(["XXXX|Nope"]);
    expect(deletePreset("Lighter iron", "ARMO")).toBe(true);
    expect(loadPresets()).toEqual([]);
  });
});
