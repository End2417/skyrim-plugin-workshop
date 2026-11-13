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
