import { describe, expect, it } from "vitest";
import {
  buildMerged,
  mergedFileName,
  mergePlugins,
  planMerge,
  sortByDependencies,
  type MergeOptions,
  type MergePlan,
} from "./mergePlugins";
import {
  describeGroup,
  encodeText,
  encodeZString,
  fileInfo,
  getEditorId,
  getSubrecords,
  hex8,
  parseEsp,
  serializeEsp,
  walkRecords,
  type EspFile,
  type EspGroup,
  type EspNode,
  type EspRecord,
  type Subrecord,
} from "./format";
import { readVmad } from "./scripts";
import { ids, rawGroup, rawRecord, u32 } from "./testPlugin";

// ---------- helpers that build plugins with real group hierarchies ----------

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

interface HeaderOpts {
  flags?: number;
  version?: number;
  onam?: number[];
}

function tes4(masters: string[], o: HeaderOpts = {}): Uint8Array {
  const hedr = new Uint8Array(12);
  new DataView(hedr.buffer).setFloat32(0, o.version ?? 1.7, true);
  const subs: Subrecord[] = [{ type: "HEDR", data: hedr }];
  for (const m of masters) subs.push({ type: "MAST", data: encodeZString(m) }, { type: "DATA", data: new Uint8Array(8) });
  if (o.onam) subs.push({ type: "ONAM", data: ids(...o.onam) });
  return rawRecord("TES4", 0, subs, o.flags ?? 0);
}

const rec = (type: string, formId: number, edid: string, subs: Subrecord[] = [], flags = 0) =>
  rawRecord(type, formId, [{ type: "EDID", data: encodeZString(edid) }, ...subs], flags);

/** A group of any type; `label` is a 4-character signature (top group) or a number (everything else). */
function grp(groupType: number, label: string | number, children: Uint8Array[]): Uint8Array {
  const g = rawGroup(typeof label === "string" ? label : "AAAA", children);
  const dv = new DataView(g.buffer);
  dv.setInt32(12, groupType, true);
  if (typeof label === "number") dv.setUint32(8, label >>> 0, true);
  return g;
}

const plugin = (name: string, masters: string[], parts: Uint8Array[], o: HeaderOpts = {}): EspFile =>
  parseEsp(concat([tes4(masters, o), ...parts]), name);

const top = (sig: string, children: Uint8Array[]) => grp(0, sig, children);
const kwda = (...list: number[]): Subrecord => ({ type: "KWDA", data: ids(...list) });

/** A CELL with a temporary-children group holding `refs`, in the usual block / sub-block nesting. */
function cell(formId: number, edid: string, refs: Uint8Array[]): Uint8Array[] {
  return [rec("CELL", formId, edid), grp(6, formId, [grp(9, formId, refs)])];
}
const cellTop = (cells: Uint8Array[][]) => top("CELL", [grp(2, 0, [grp(3, 0, cells.flat())])]);

const reparse = (bytes: Uint8Array) => parseEsp(bytes, "Out.esp");
const recordsOf = (f: EspFile) => [...walkRecords(f.nodes)].filter((r) => r.type !== "TES4");
const byEdid = (f: EspFile, edid: string) => recordsOf(f).find((r) => getEditorId(r) === edid);
const refsOf = (r: EspRecord, sub = "KWDA") => {
  const d = getSubrecords(r).find((s) => s.type === sub)!.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return Array.from({ length: d.length / 4 }, (_, i) => dv.getUint32(i * 4, true));
};
const groupsOf = (nodes: EspNode[], type: number): EspGroup[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [...(n.groupType === type ? [n] : []), ...groupsOf(n.children, type)] : []));
const labelId = (g: EspGroup) => new DataView(g.label.buffer, g.label.byteOffset, 4).getUint32(0, true);

async function merged(files: EspFile[], opts: MergeOptions = {}) {
  const r = await mergePlugins(files, opts);
  expect(r).not.toBeNull();
  return { plan: r!.plan, result: r!.result, out: reparse(r!.result.bytes) };
}

const SKYRIM = "Skyrim.esm";

// ---------- VMAD writer (same layout scripts.test.ts uses) ----------

const u8b = (n: number) => [n & 0xff];
const u16b = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32b = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ws = (s: string) => [...u16b(s.length), ...Array.from(encodeText(s))];
const objectProp = (name: string, formId: number) => [...ws(name), ...u8b(1), ...u8b(1), ...u16b(0), ...u16b(0xffff), ...u32b(formId)];
const vmad = (formId: number): Subrecord => ({
  type: "VMAD",
  data: Uint8Array.from([...u16b(5), ...u16b(2), ...u16b(1), ...ws("MyScript"), ...u8b(0), ...u16b(1), ...objectProp("Target", formId)]),
});

// ---------- tests ----------

describe("master list", () => {
  it("combines the masters, vanilla ones in game order, without the plugins being merged", async () => {
    const a = plugin("A.esp", [SKYRIM, "Dawnguard.esm"], []);
    const b = plugin("B.esp", [SKYRIM, "Update.esm", "A.esp"], []);
    const plan = (await planMerge([a, b]))!;
    expect(plan.masters.map((m) => m.name)).toEqual([SKYRIM, "Update.esm", "Dawnguard.esm"]);
    expect(plan.masters[1]!.usedBy).toEqual([1]);
    expect(plan.ok).toBe(true);
  });

  it("moves references to masters whose slot changed", async () => {
    const a = plugin("A.esp", [SKYRIM, "Dawnguard.esm"], [top("ARMO", [rec("ARMO", 0x02000800, "ArmorA", [kwda(0x01000801, 0x00000f00)])])]);
    const b = plugin("B.esp", [SKYRIM, "Update.esm"], [top("ARMO", [rec("ARMO", 0x02000800, "ArmorB", [kwda(0x01000802)])])]);
    const { out, plan } = await merged([a, b]);
    expect(plan.masters.map((m) => m.name)).toEqual([SKYRIM, "Update.esm", "Dawnguard.esm"]);
    // Dawnguard was slot 1 in A and is slot 2 now; Update was slot 1 in B and stays slot 1
    expect(refsOf(byEdid(out, "ArmorA")!)).toEqual([0x02000801, 0x00000f00]);
    expect(refsOf(byEdid(out, "ArmorB")!)).toEqual([0x01000802]);
    expect(plan.inputs[0]!.slotsMoved).toBe(1);
    expect(plan.inputs[1]!.slotsMoved).toBe(0);
  });
});

describe("renumbering", () => {
  const a = () => plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")])]);
  const b = () =>
    plugin(
      "B.esp",
      [SKYRIM],
      [
        top("KYWD", [rec("KYWD", 0x01000800, "KwB")]),
        top("ARMO", [rec("ARMO", 0x01000801, "ArmorB", [kwda(0x01000800, 0x0001a000)])]),
      ],
    );

  it("keeps IDs that are free and gives a clashing record a new one, fixing the references to it", async () => {
    const { out, plan } = await merged([a(), b()]);
    expect(plan.masters.map((m) => m.name)).toEqual([SKYRIM]);
    expect(byEdid(out, "KwA")!.formId >>> 0).toBe(0x01000800);
    expect(byEdid(out, "ArmorB")!.formId >>> 0).toBe(0x01000801);
    const kwB = byEdid(out, "KwB")!.formId >>> 0;
    expect(kwB).toBe(0x01000802);
    // B's own keyword moved; the master reference did not
    expect(refsOf(byEdid(out, "ArmorB")!)).toEqual([kwB, 0x0001a000]);
    expect(plan.counts.renumbered).toBe(1);
    expect(plan.inputs[1]!.renumbered).toBe(1);
    const e = plan.entries.find((x) => x.record === byEdid(b(), "KwB") || getEditorId(x.record) === "KwB")!;
    expect(e.renumbered).toBe(true);
    expect(e.oldFormId).toBe(0x01000800);
    expect(e.newFormId).toBe(0x01000802);
  });

  it("moves a plugin's own records to the merged plugin's slot when the master counts differ", async () => {
    const x = plugin("X.esp", [], [top("KYWD", [rec("KYWD", 0x00000800, "KwX")])]);
    const y = plugin("Y.esp", [SKYRIM, "Update.esm"], [top("KYWD", [rec("KYWD", 0x02000900, "KwY")])]);
    const { out } = await merged([x, y]);
    // two masters, so own records live in slot 2
    expect(byEdid(out, "KwX")!.formId >>> 0).toBe(0x02000800);
    expect(byEdid(out, "KwY")!.formId >>> 0).toBe(0x02000900);
  });

  it("is a plain list of records with the merged header", async () => {
    const { out, result, plan } = await merged([a(), b()], { author: "Me", description: "Hello" });
    const info = fileInfo(out);
    expect(info.masters).toEqual([SKYRIM]);
    expect(info.localized).toBe(false);
    const subs = getSubrecords(out.nodes[0] as EspRecord);
    const text = (t: string) => new TextDecoder().decode(subs.find((s) => s.type === t)!.data).replace(/\0$/, "");
    expect(text("CNAM")).toBe("Me");
    expect(text("SNAM")).toBe("Hello");
    const hedr = subs.find((s) => s.type === "HEDR")!.data;
    const dv = new DataView(hedr.buffer, hedr.byteOffset, hedr.byteLength);
    // KYWD (2 records + group) and ARMO (1 record + group)
    expect(dv.getInt32(4, true)).toBe(3 + 2 + 0 + 2 + 0 - 2 + 0);
    expect(dv.getUint32(8, true)).toBe(0x01000803);
    expect(result.report.verification.problems).toBe(0);
    expect(result.report.verification.duplicates).toBe(0);
    expect(plan.counts.records).toBe(3);
  });

  it("keeps records that need no change byte for byte", async () => {
    const { out } = await merged([a(), b()]);
    const src = byEdid(a(), "KwA")!;
    const got = byEdid(out, "KwA")!;
    expect(got.raw).toEqual(src.raw);
    expect(got.flags).toBe(src.flags);
  });

  it("does not change the plugins it was given", async () => {
    const files = [a(), b()];
    const before = files.map((f) => serializeEsp(f));
    await merged(files);
    expect(files.map((f) => serializeEsp(f))).toEqual(before);
  });
});

describe("plugins that need each other", () => {
  const build = () => {
    const a = plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")]), top("ARMO", [rec("ARMO", 0x01000801, "ArmorA", [kwda(0x01000800)])])]);
    // B lists A (slot 1) and has its own records in slot 2
    const b = plugin(
      "B.esp",
      [SKYRIM, "A.esp"],
      [
        top("KYWD", [rec("KYWD", 0x02000800, "KwB")]),
        top("ARMO", [
          rec("ARMO", 0x01000801, "ArmorA", [kwda(0x01000800, 0x02000800, 0x00000f00)]), // changes A's armor
          rec("ARMO", 0x02000801, "ArmorB", [kwda(0x01000800, 0x02000800)]),
        ]),
      ],
    );
    return [a, b];
  };

  it("points B's references to A at the merged plugin and keeps B's version of the record it changes", async () => {
    const { out, plan } = await merged(build());
    expect(plan.masters.map((m) => m.name)).toEqual([SKYRIM]);
    // A: 800 and 801. B's own 800 clashes with A's 800 and moves; B's own 801 clashes and moves
    const kwA = byEdid(out, "KwA")!.formId >>> 0;
    const kwB = byEdid(out, "KwB")!.formId >>> 0;
    expect(kwA).toBe(0x01000800);
    expect(kwB).not.toBe(kwA);
    const armors = recordsOf(out).filter((r) => r.type === "ARMO");
    expect(armors).toHaveLength(2);
    const armorA = armors.find((r) => getEditorId(r) === "ArmorA")!;
    expect(armorA.formId >>> 0).toBe(0x01000801);
    // B's version won: it references A's keyword, B's keyword (renumbered) and a master record
    expect(refsOf(armorA)).toEqual([kwA, kwB, 0x00000f00]);
    const armorB = armors.find((r) => getEditorId(r) === "ArmorB")!;
    expect(refsOf(armorB)).toEqual([kwA, kwB]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.winner).toBe(1);
  });

  it("will not merge a plugin before the one it needs, and can put them in order", async () => {
    const [a, b] = build();
    const plan = (await planMerge([b!, a!]))!;
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => i.level === "error" && /has to come before/.test(i.message))).toBe(true);
    expect(sortByDependencies([b!, a!]).map((f) => f.name)).toEqual(["A.esp", "B.esp"]);
    await expect(buildMerged([b!, a!], plan)).rejects.toThrow(/has to come before/);
  });
});

describe("records several plugins change", () => {
  const armor = (edid: string, ref: number) => top("ARMO", [rec("ARMO", 0x00012e49, edid, [kwda(ref)])]);
  const mk = () => [plugin("A.esp", [SKYRIM], [armor("Same", 0x0001a000)]), plugin("B.esp", [SKYRIM], [armor("Same", 0x0001a001)]), plugin("C.esp", [SKYRIM], [armor("Same", 0x0001a002)])];

  it("keeps the last plugin's version by default and reports who lost", async () => {
    const { out, plan } = await merged(mk());
    expect(recordsOf(out)).toHaveLength(1);
    expect(refsOf(recordsOf(out)[0]!)).toEqual([0x0001a002]);
    expect(plan.conflicts).toHaveLength(1);
    const c = plan.conflicts[0]!;
    expect(c.winner).toBe(2);
    expect(c.entries.map((e) => e.input)).toEqual([0, 1, 2]);
    expect(c.identical).toBe(false);
    expect(plan.entries.map((e) => e.action)).toEqual(["lost", "lost", "wins"]);
    expect(plan.counts).toMatchObject({ records: 1, conflicts: 1, dropped: 2, overrides: 1 });
  });

  it("lets the person choose another plugin's version", async () => {
    const plan = (await planMerge(mk()))!;
    const id = plan.conflicts[0]!.id;
    const { out, plan: p2 } = await merged(mk(), { choose: { [id]: 0 } });
    expect(refsOf(recordsOf(out)[0]!)).toEqual([0x0001a000]);
    expect(p2.conflicts[0]!.winner).toBe(0);
  });

  it("recognises copies that are the same", async () => {
    const files = [plugin("A.esp", [SKYRIM], [armor("Same", 0x0001a000)]), plugin("B.esp", [SKYRIM], [armor("Same", 0x0001a000)])];
    const plan = (await planMerge(files))!;
    expect(plan.conflicts[0]!.identical).toBe(true);
    expect(plan.counts.identical).toBe(1);
  });
});

describe("groups", () => {
  it("renumbers the cell a group belongs to and keeps both plugins' references", async () => {
    const refA = rawRecord("REFR", 0x01000801, [{ type: "NAME", data: u32(0x0001a000) }]);
    const refB = rawRecord("REFR", 0x01000801, [{ type: "NAME", data: u32(0x0001a000) }]);
    const a = plugin("A.esp", [SKYRIM], [cellTop([cell(0x01000800, "CellA", [refA])])]);
    const b = plugin("B.esp", [SKYRIM], [cellTop([cell(0x01000800, "CellB", [refB])])]);
    const { out } = await merged([a, b]);
    const cells = recordsOf(out).filter((r) => r.type === "CELL");
    expect(cells.map((c) => getEditorId(c))).toEqual(["CellA", "CellB"]);
    const ca = cells[0]!.formId >>> 0;
    const cb = cells[1]!.formId >>> 0;
    expect(ca).toBe(0x01000800);
    expect(cb).not.toBe(ca);
    // each cell's children group is labelled with its own cell's new FormID
    expect(groupsOf(out.nodes, 6).map(labelId)).toEqual([ca, cb]);
    expect(groupsOf(out.nodes, 9).map(labelId)).toEqual([ca, cb]);
    expect(recordsOf(out).filter((r) => r.type === "REFR")).toHaveLength(2);
    expect(new Set(recordsOf(out).map((r) => r.formId >>> 0)).size).toBe(recordsOf(out).length);
  });

  it("merges the children of a cell of a master that several plugins change", async () => {
    const master = 0x00012345;
    const a = plugin("A.esp", [SKYRIM], [cellTop([cell(master, "BaseCell", [rawRecord("REFR", 0x01000800, [{ type: "NAME", data: u32(0x0001a000) }])])])]);
    const b = plugin("B.esp", [SKYRIM], [cellTop([cell(master, "BaseCell", [rawRecord("REFR", 0x01000801, [{ type: "NAME", data: u32(0x0001a000) }])])])]);
    const { out, plan } = await merged([a, b]);
    expect(recordsOf(out).filter((r) => r.type === "CELL")).toHaveLength(1);
    expect(groupsOf(out.nodes, 6)).toHaveLength(1);
    expect(groupsOf(out.nodes, 9)).toHaveLength(1);
    expect(groupsOf(out.nodes, 9)[0]!.children).toHaveLength(2);
    expect(plan.conflicts).toHaveLength(1);
    expect(labelId(groupsOf(out.nodes, 6)[0]!)).toBe(master);
  });

  it("renumbers dialogue topics together with their responses", async () => {
    const dial = (id: number, info: number, edid: string) => top("DIAL", [rec("DIAL", id, edid), grp(7, id, [rec("INFO", info, `${edid}Info`)])]);
    const a = plugin("A.esp", [SKYRIM], [dial(0x01000800, 0x01000801, "TopicA")]);
    const b = plugin("B.esp", [SKYRIM], [dial(0x01000800, 0x01000801, "TopicB")]);
    const { out } = await merged([a, b]);
    const topicB = byEdid(out, "TopicB")!.formId >>> 0;
    expect(topicB).not.toBe(0x01000800);
    expect(groupsOf(out.nodes, 7).map(labelId)).toEqual([0x01000800, topicB]);
  });

  it("leaves out empty groups", async () => {
    const a = plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")])]);
    const b = plugin("B.esp", [SKYRIM], [top("MISC", [])]);
    const { out } = await merged([a, b]);
    expect(out.nodes.filter((n) => n.kind === "group").map((g) => describeGroup(g as EspGroup))).toEqual(["Keyword"]);
  });
});

describe("references inside fields the editor can only partly read", () => {
  const a = () => plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")])]);

  it("renumbers script properties", async () => {
    const b = plugin(
      "B.esp",
      [SKYRIM],
      [top("KYWD", [rec("KYWD", 0x01000800, "KwB")]), top("ACTI", [rec("ACTI", 0x01000801, "Door", [vmad(0x01000800)])])],
    );
    const { out, result } = await merged([a(), b]);
    const door = byEdid(out, "Door")!;
    const info = readVmad(getSubrecords(door).find((s) => s.type === "VMAD")!.data, "ACTI");
    expect(info.complete).toBe(true);
    expect(info.scripts[0]!.properties[0]!.formId).toBe(byEdid(out, "KwB")!.formId);
    expect(result.report.scriptRefsRewritten).toBe(1);
    expect(result.report.scriptRecords).toBe(1);
  });

  it("renumbers a reference to a plugin that is part of the merge from inside a script", async () => {
    const b = plugin("B.esp", [SKYRIM, "A.esp"], [top("ACTI", [rec("ACTI", 0x02000800, "Door", [vmad(0x01000800)])])]);
    const { out } = await merged([a(), b]);
    const info = readVmad(getSubrecords(byEdid(out, "Door")!).find((s) => s.type === "VMAD")!.data, "ACTI");
    expect(info.scripts[0]!.properties[0]!.formId).toBe(0x01000800);
    expect(byEdid(out, "Door")!.formId >>> 0).toBe(0x01000801);
  });

  it("reports script data it cannot read instead of guessing", async () => {
    const bad: Subrecord = { type: "VMAD", data: Uint8Array.from([9, 0, 9, 0, 1, 0]) };
    const b = plugin("B.esp", [SKYRIM], [top("ACTI", [rec("ACTI", 0x01000800, "Odd", [bad])])]);
    const { result } = await merged([a(), b]);
    expect(result.report.unreadableScripts).toHaveLength(1);
    expect(result.report.issues.some((i) => i.level === "warning" && /script data/.test(i.message))).toBe(true);
  });

  const unknown = (data: Uint8Array): Subrecord => ({ type: "ZZZZ", data });
  const b = () => plugin("B.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwB")]), top("ACTI", [rec("ACTI", 0x01000801, "Thing", [unknown(ids(0x01000800, 5, 0x0001a000))])])]);

  it("renumbers values that clearly point at the plugin's own records in unrecognised fields", async () => {
    const { out, result } = await merged([a(), b()]);
    expect(refsOf(byEdid(out, "Thing")!, "ZZZZ")).toEqual([byEdid(out, "KwB")!.formId >>> 0, 5, 0x0001a000]);
    expect(result.report.unknownRewritten).toBe(1);
  });

  it("leaves them alone when asked to", async () => {
    const { out, result } = await merged([a(), b()], { rewriteUnknown: false });
    expect(refsOf(byEdid(out, "Thing")!, "ZZZZ")).toEqual([0x01000800, 5, 0x0001a000]);
    expect(result.report.unknownRewritten).toBe(0);
  });

  it("renumbers own records used as condition parameters", async () => {
    const ctda = new Uint8Array(32);
    const dv = new DataView(ctda.buffer);
    dv.setUint16(8, 0x47, true); // function
    dv.setUint32(12, 0x01000800, true); // parameter 1: own keyword
    dv.setUint32(16, 5000, true); // parameter 2: a plain number
    dv.setUint32(24, 0x01000800, true); // reference field (a typed FormID)
    const bb = plugin("B.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwB")]), top("ACTI", [rec("ACTI", 0x01000801, "Cond", [{ type: "CTDA", data: ctda }])])]);
    const { out } = await merged([a(), bb]);
    const data = getSubrecords(byEdid(out, "Cond")!).find((s) => s.type === "CTDA")!.data;
    const o = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const kw = byEdid(out, "KwB")!.formId >>> 0;
    expect(o.getUint32(12, true)).toBe(kw);
    expect(o.getUint32(16, true)).toBe(5000);
    expect(o.getUint32(24, true)).toBe(kw);
  });
});

describe("header", () => {
  it("merges the overridden-forms lists of master plugins and flags the result as a master", async () => {
    const a = plugin("A.esm", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")])], { flags: 1, onam: [0x00012345, 0x01000800] });
    const b = plugin("B.esm", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwB")])], { flags: 1, onam: [0x00012345, 0x01000800] });
    const { out, plan } = await merged([a, b]);
    expect(plan.esm).toBe(true);
    expect((out.nodes[0] as EspRecord).flags & 1).toBe(1);
    const onam = getSubrecords(out.nodes[0] as EspRecord).find((s) => s.type === "ONAM")!.data;
    const dv = new DataView(onam.buffer, onam.byteOffset, onam.byteLength);
    // the shared master record once, A's own record unchanged, B's renumbered
    expect(Array.from({ length: onam.length / 4 }, (_, i) => dv.getUint32(i * 4, true))).toEqual([0x00012345, 0x01000800, 0x01000801]);
  });

  it("is a normal plugin when only some inputs are masters, unless asked", async () => {
    const a = plugin("A.esm", [SKYRIM], [], { flags: 1 });
    const b = plugin("B.esp", [SKYRIM], []);
    const plan = (await planMerge([a, b]))!;
    expect(plan.esm).toBe(false);
    expect(plan.issues.some((i) => i.level === "warning" && /masters \(ESM\)/.test(i.message))).toBe(true);
    expect((await planMerge([a, b], { esm: true }))!.esm).toBe(true);
  });

  it("names the file", () => {
    expect(mergedFileName("My Merge", false)).toBe("My Merge.esp");
    expect(mergedFileName("My Merge.esp", true)).toBe("My Merge.esp");
    expect(mergedFileName("My Merge.esl", false)).toBe("My Merge.esp");
    expect(mergedFileName("a/b:c", true)).toBe("a_b_c.esm");
    expect(mergedFileName("", false)).toBe("Merged.esp");
  });
});

describe("things that cannot or should not be merged", () => {
  it("needs two plugins", async () => {
    const plan = (await planMerge([plugin("A.esp", [SKYRIM], [])]))!;
    expect(plan.ok).toBe(false);
  });

  it("refuses localized plugins", async () => {
    const a = plugin("A.esp", [SKYRIM], [], { flags: 0x80 });
    const plan = (await planMerge([a, plugin("B.esp", [SKYRIM], [])]))!;
    expect(plan.ok).toBe(false);
    expect(plan.issues.find((i) => i.level === "error")!.input).toBe(0);
  });

  it("refuses to mix editions", async () => {
    const plan = (await planMerge([plugin("A.esp", [SKYRIM], [], { version: 0.94 }), plugin("B.esp", [SKYRIM], [], { version: 1.7 })]))!;
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => /edition/.test(i.message))).toBe(true);
  });

  it("refuses the same plugin twice", async () => {
    const plan = (await planMerge([plugin("A.esp", [SKYRIM], []), plugin("a.esp", [SKYRIM], [])]))!;
    expect(plan.ok).toBe(false);
  });

  it("leaves out the navigation index and says so", async () => {
    const a = plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")]), top("NAVI", [rec("NAVI", 0x01000900, "Navi")])]);
    const b = plugin("B.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000801, "KwB")])]);
    const { out, plan } = await merged([a, b]);
    expect(recordsOf(out).some((r) => r.type === "NAVI")).toBe(false);
    expect(plan.inputs[0]!.navmeshes).toBe(1);
    expect(plan.issues.some((i) => i.level === "warning" && /navigation/.test(i.message) && i.input === 0)).toBe(true);
  });

  it("warns about overrides of records the merged plugin does not have", async () => {
    const a = plugin("A.esp", [SKYRIM], []);
    const b = plugin("B.esp", [SKYRIM, "A.esp"], [top("KYWD", [rec("KYWD", 0x01000999, "Ghost")])]);
    const plan = (await planMerge([a, b]))!;
    expect(plan.issues.some((i) => i.level === "warning" && /does not contain/.test(i.message))).toBe(true);
  });

  it("refuses a build for a plan with other plugins than it was made from", async () => {
    const files = [plugin("A.esp", [SKYRIM], []), plugin("B.esp", [SKYRIM], [])];
    const plan = (await planMerge(files)) as MergePlan;
    await expect(buildMerged([files[0]!, plugin("C.esp", [SKYRIM], [])], plan)).rejects.toThrow(/Preview the merge again/);
  });

  it("stops when cancelled", async () => {
    const files = [plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")])]), plugin("B.esp", [SKYRIM], [])];
    expect(await planMerge(files, {}, { cancelled: () => true })).not.toBeNull(); // too small to reach a check
    const many = Array.from({ length: 1600 }, (_, i) => rec("KYWD", 0x01000800 + i, `K${i}`));
    const big = [plugin("A.esp", [SKYRIM], [top("KYWD", many)]), plugin("B.esp", [SKYRIM], [])];
    expect(await planMerge(big, {}, { cancelled: () => true })).toBeNull();
  });
});

describe("larger plugins", () => {
  it("merges thousands of records and leaves every FormID unique", async () => {
    const make = (name: string, n: number) =>
      plugin(name, [SKYRIM], [top("ARMO", Array.from({ length: n }, (_, i) => rec("ARMO", 0x01000800 + i, `${name}${i}`, [kwda(0x01000800 + ((i + 1) % n), 0x0001a000)])))]);
    const started = Date.now();
    const { out, plan, result } = await merged([make("A.esp", 4000), make("B.esp", 4000)]);
    expect(recordsOf(out)).toHaveLength(8000);
    expect(new Set(recordsOf(out).map((r) => r.formId >>> 0)).size).toBe(8000);
    expect(plan.counts.renumbered).toBe(4000);
    expect(result.report.verification).toMatchObject({ problems: 0, duplicates: 0 });
    // B's references all follow B's records, not A's
    const b17 = byEdid(out, "B.esp17")!;
    expect(refsOf(b17)[0]).toBe(byEdid(out, "B.esp18")!.formId >>> 0);
    expect(Date.now() - started).toBeLessThan(15000);
  });
});

describe("what the plan reports", () => {
  it("counts what is added, changed and renumbered for each plugin", async () => {
    const a = plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")]), top("ARMO", [rec("ARMO", 0x00012e49, "Boots")])]);
    const b = plugin("B.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwB")]), top("ARMO", [rec("ARMO", 0x00012e49, "Boots")])]);
    const plan = (await planMerge([a, b]))!;
    expect(plan.inputs.map((i) => ({ d: i.defines, o: i.overrides, r: i.renumbered }))).toEqual([
      { d: 1, o: 1, r: 0 },
      { d: 1, o: 1, r: 1 },
    ]);
    expect(plan.counts).toMatchObject({ records: 3, added: 2, overrides: 1, conflicts: 1, dropped: 0, renumbered: 1, identical: 1 });
    // identical copies are one record; nothing is lost by writing it once
    const boots = plan.entries.filter((e) => getEditorId(e.record) === "Boots");
    expect(boots.map((e) => [e.action, e.included, e.origin])).toEqual([
      ["merged", false, SKYRIM],
      ["merged", true, SKYRIM],
    ]);
    expect(hex8(plan.entries.find((e) => getEditorId(e.record) === "KwB")!.newFormId)).toBe("01000801");
  });
});

// ---------- plugins that change the same record ----------

describe("combining changes to the same record", () => {
  const w = (...n: number[]) => ids(...n);
  const acbs = (flags: number, level: number): Subrecord => {
    const d = new Uint8Array(24);
    new DataView(d.buffer).setUint32(0, flags, true);
    new DataView(d.buffer).setUint16(8, level, true);
    return { type: "ACBS", data: d };
  };
  const cnto = (item: number): Subrecord => ({ type: "CNTO", data: w(item, 1) });
  const coct = (n: number): Subrecord => ({ type: "COCT", data: w(n) });
  const GUARD = 0x00013b1e;
  const VANILLA_ITEM = 0x00012eb7;
  const guard = (...subs: Subrecord[]) => top("NPC_", [rec("NPC_", GUARD, "Guard", subs)]);
  const itemsOf = (r: EspRecord) => getSubrecords(r).filter((x) => x.type === "CNTO").map((x) => new DataView(x.data.buffer, x.data.byteOffset).getUint32(0, true));
  const countOf = (r: EspRecord) => new DataView(getSubrecords(r).find((x) => x.type === "COCT")!.data.buffer).getUint32(0, true);
  const levelOf = (r: EspRecord) => new DataView(getSubrecords(r).find((x) => x.type === "ACBS")!.data.buffer).getUint16(8, true);

  const skyrim = () => plugin(SKYRIM, [], [guard(acbs(0, 5), coct(1), cnto(VANILLA_ITEM))], { flags: 1 });
  // one mod makes a sword and gives it to the guard, the other makes armor and gives it to the guard; both use local ID 800
  const swordMod = () => plugin("Sword.esp", [SKYRIM], [top("WEAP", [rec("WEAP", 0x01000800, "NewSword")]), guard(acbs(0, 5), coct(2), cnto(VANILLA_ITEM), cnto(0x01000800))]);
  const armorMod = () => plugin("Armor.esp", [SKYRIM], [top("ARMO", [rec("ARMO", 0x01000800, "NewArmor")]), guard(acbs(0, 5), coct(2), cnto(VANILLA_ITEM), cnto(0x01000800))]);

  it("gives the guard the sword and the armor when the original is added", async () => {
    const { out, plan, result } = await merged([swordMod(), armorMod()], { originals: [skyrim()] });
    const sword = byEdid(out, "NewSword")!.formId >>> 0;
    const armor = byEdid(out, "NewArmor")!.formId >>> 0;
    expect(sword).toBe(0x01000800);
    expect(armor).toBe(0x01000801); // the second mod's local ID was taken
    const g = byEdid(out, "Guard")!;
    expect(itemsOf(g)).toEqual([VANILLA_ITEM, sword, armor]);
    expect(countOf(g)).toBe(3);
    expect(recordsOf(out).filter((r) => r.type === "NPC_")).toHaveLength(1);

    const c = plan.conflicts[0]!;
    expect(c).toMatchObject({ status: "combined", collisions: 0, identical: false });
    expect(c.changes.map((x) => x.input)).toEqual([0, 1]);
    expect(c.changes.every((x) => x.fields.some((f) => /CNTO/.test(f)))).toBe(true);
    expect(plan.entries.filter((e) => e.type === "NPC_").map((e) => e.action)).toEqual(["merged", "merged"]);
    expect(plan.counts).toMatchObject({ combined: 1, unmerged: 0, collisions: 0, dropped: 0 });
    expect(plan.originals).toEqual([{ name: SKYRIM, used: 1, auto: false }]);
    expect(result.report.verification).toMatchObject({ problems: 0, duplicates: 0 });
    expect(plan.issues.some((i) => i.level === "warning")).toBe(false);
  });

  it("keeps one whole version and says which original to add when it is not there", async () => {
    const { out, plan } = await merged([swordMod(), armorMod()]);
    expect(itemsOf(byEdid(out, "Guard")!)).toHaveLength(2); // only one mod's gear
    const c = plan.conflicts[0]!;
    expect(c).toMatchObject({ status: "picked", needs: SKYRIM });
    expect(c.reason).toMatch(/Skyrim\.esm/);
    expect(plan.entries.filter((e) => e.type === "NPC_").map((e) => e.action)).toEqual(["lost", "wins"]);
    expect(plan.counts).toMatchObject({ combined: 0, unmerged: 1, dropped: 1 });
    expect(plan.issues.some((i) => i.level === "warning" && /Skyrim\.esm/.test(i.message) && /Add/.test(i.message))).toBe(true);
  });

  it("can be switched off", async () => {
    const { plan } = await merged([swordMod(), armorMod()], { originals: [skyrim()], combine: false });
    expect(plan.conflicts[0]).toMatchObject({ status: "picked" });
  });

  it("combines three plugins that each change the guard", async () => {
    const thirdMod = plugin("Level.esp", [SKYRIM], [guard(acbs(0, 40), coct(1), cnto(VANILLA_ITEM))]);
    const { out, plan } = await merged([swordMod(), armorMod(), thirdMod], { originals: [skyrim()] });
    const g = byEdid(out, "Guard")!;
    expect(itemsOf(g)).toHaveLength(3);
    expect(levelOf(g)).toBe(40);
    expect(plan.conflicts[0]!.entries).toHaveLength(3);
    expect(plan.conflicts[0]!.collisions).toBe(0);
  });

  it("reports a field two plugins change differently, uses the later plugin and lets the person pick", async () => {
    const mk = (name: string, level: number) => plugin(name, [SKYRIM], [guard(acbs(0, level), coct(1), cnto(VANILLA_ITEM))]);
    const files = () => [mk("A.esp", 10), mk("B.esp", 20)];
    const { out, plan } = await merged(files(), { originals: [skyrim()] });
    expect(levelOf(byEdid(out, "Guard")!)).toBe(20);
    expect(plan.conflicts[0]).toMatchObject({ status: "combined", collisions: 1, winner: 1 });
    expect(plan.conflicts[0]!.collided.some((x) => /ACBS/.test(x))).toBe(true);
    expect(plan.counts.collisions).toBe(1);
    const again = await merged(files(), { originals: [skyrim()], choose: { [plan.conflicts[0]!.id]: 0 } });
    expect(levelOf(byEdid(again.out, "Guard")!)).toBe(10);
    expect(again.plan.conflicts[0]!.winner).toBe(0);
  });

  it("combines changes to a record one of the plugins makes, without any original", async () => {
    const boss = (...subs: Subrecord[]) => top("NPC_", [rec("NPC_", 0x01000800, "Boss", subs)]);
    const a = plugin("A.esp", [SKYRIM], [boss(acbs(0, 5), coct(1), cnto(VANILLA_ITEM))]);
    const b = plugin("B.esp", [SKYRIM, "A.esp"], [boss(acbs(0, 40), coct(1), cnto(VANILLA_ITEM))]); // changes the level
    const c = plugin("C.esp", [SKYRIM, "A.esp"], [boss(acbs(0, 5), coct(2), cnto(VANILLA_ITEM), cnto(0x00000f00))]); // adds an item
    const { out, plan } = await merged([a, b, c]);
    const g = byEdid(out, "Boss")!;
    expect(levelOf(g)).toBe(40);
    expect(itemsOf(g)).toEqual([VANILLA_ITEM, 0x00000f00]);
    expect(countOf(g)).toBe(2);
    expect(plan.conflicts[0]).toMatchObject({ status: "combined", collisions: 0 });
    expect(plan.entries.filter((e) => e.type === "NPC_").map((e) => e.action)).toEqual(["merged", "merged", "merged"]);
    expect(plan.issues.some((i) => i.level === "warning")).toBe(false);
  });

  it("combines the flags in the record header", async () => {
    const orig = plugin(SKYRIM, [], [top("NPC_", [rec("NPC_", GUARD, "Guard", [acbs(0, 5)], 0)])], { flags: 1 });
    const a = plugin("A.esp", [SKYRIM], [top("NPC_", [rec("NPC_", GUARD, "Guard", [acbs(0, 5)], 0x4)])]);
    const b = plugin("B.esp", [SKYRIM], [top("NPC_", [rec("NPC_", GUARD, "Guard", [acbs(0, 5)], 0x1000)])]);
    const { out } = await merged([a, b], { originals: [orig] });
    expect(byEdid(out, "Guard")!.flags).toBe(0x1004);
  });

  it("uses the version a later original (a patch) has as the starting point, and keeps shared additions once without it", async () => {
    const UPDATE = "Update.esm";
    const skyrimOnly = () => plugin(SKYRIM, [], [guard(acbs(0, 5), coct(1), cnto(VANILLA_ITEM))], { flags: 1 });
    const update = () => plugin(UPDATE, [SKYRIM], [guard(acbs(0, 5), coct(2), cnto(VANILLA_ITEM), cnto(0x555))], { flags: 1 });
    // both mods are built on the patched guard and each add one item of their own (local ID 800 in both)
    const mod = (name: string, extra: string) =>
      plugin(name, [SKYRIM, UPDATE], [top("MISC", [rec("MISC", 0x02000800, extra)]), guard(acbs(0, 5), coct(3), cnto(VANILLA_ITEM), cnto(0x555), cnto(0x02000800))]);
    const both = await merged([mod("A.esp", "ItemA"), mod("B.esp", "ItemB")], { originals: [skyrimOnly(), update()] });
    const itemA = byEdid(both.out, "ItemA")!.formId >>> 0;
    const itemB = byEdid(both.out, "ItemB")!.formId >>> 0;
    expect(itemB).not.toBe(itemA);
    expect(itemsOf(byEdid(both.out, "Guard")!)).toEqual([VANILLA_ITEM, 0x555, itemA, itemB]);
    expect(countOf(byEdid(both.out, "Guard")!)).toBe(4);
    // with only the unpatched original, what both mods got from the patch is not added twice
    const onlySkyrim = await merged([mod("A.esp", "ItemA"), mod("B.esp", "ItemB")], { originals: [skyrimOnly()] });
    expect(itemsOf(byEdid(onlySkyrim.out, "Guard")!)).toEqual([VANILLA_ITEM, 0x555, itemA, itemB]);
  });

  describe("originals found by the source", () => {
    it("reads an original that was not given, only when it is needed, and marks it as automatic", async () => {
      const calls: { needed: string[]; masters: string[] }[] = [];
      const originalSource = async (needed: string[], masters: string[]) => {
        calls.push({ needed, masters });
        return [skyrim()];
      };
      const { out, plan } = await merged([swordMod(), armorMod()], { originalSource });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.needed).toEqual([SKYRIM]);
      expect(calls[0]!.masters).toEqual([SKYRIM]);
      expect(itemsOf(byEdid(out, "Guard")!)).toHaveLength(3);
      expect(plan.conflicts[0]).toMatchObject({ status: "combined", collisions: 0 });
      expect(plan.originals).toEqual([{ name: SKYRIM, used: 1, auto: true }]);
      expect(plan.issues.some((i) => i.level === "warning")).toBe(false);
    });

    it("is not asked when the original was given, or when there is nothing to compare", async () => {
      let asked = 0;
      const originalSource = async () => (asked++, [skyrim()]);
      const given = await merged([swordMod(), armorMod()], { originals: [skyrim()], originalSource });
      expect(given.plan.originals).toEqual([{ name: SKYRIM, used: 1, auto: false }]);
      // no shared records at all
      await merged([plugin("A.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000800, "KwA")])]), plugin("B.esp", [SKYRIM], [top("KYWD", [rec("KYWD", 0x01000801, "KwB")])])], { originalSource });
      // the same record, byte for byte, from plugins with the same masters
      const same = () => plugin("S.esp", [SKYRIM], [guard(acbs(0, 5), coct(1), cnto(VANILLA_ITEM))]);
      await merged([same(), plugin("T.esp", [SKYRIM], [guard(acbs(0, 5), coct(1), cnto(VANILLA_ITEM))])], { originalSource });
      // combining switched off
      await merged([swordMod(), armorMod()], { originalSource, combine: false });
      expect(asked).toBe(0);
    });

    it("keeps one whole version and says so when the source finds nothing or fails", async () => {
      const none = await merged([swordMod(), armorMod()], { originalSource: async () => [] });
      expect(none.plan.conflicts[0]).toMatchObject({ status: "picked", needs: SKYRIM });
      const failing = await merged([swordMod(), armorMod()], {
        originalSource: async () => {
          throw new Error("the folder is gone");
        },
      });
      expect(failing.plan.conflicts[0]).toMatchObject({ status: "picked", needs: SKYRIM });
      expect(failing.plan.issues.some((i) => i.level === "warning" && /could not be read automatically \(the folder is gone\)/.test(i.message))).toBe(true);
    });

    it("ignores anything it returns that is already part of the merge", async () => {
      const { plan } = await merged([swordMod(), armorMod()], { originalSource: async () => [skyrim(), swordMod()] });
      expect(plan.originals.map((o) => o.name)).toEqual([SKYRIM]);
    });
  });

  it("does not change the plugins it was given, the originals included", async () => {
    const files = [swordMod(), armorMod()];
    const orig = skyrim();
    const before = [...files, orig].map((f) => serializeEsp(f));
    await merged(files, { originals: [orig] });
    expect([...files, orig].map((f) => serializeEsp(f))).toEqual(before);
  });

  it("keeps references inside a combined record pointing at the right records after renumbering", async () => {
    const { out } = await merged([swordMod(), armorMod()], { originals: [skyrim()] });
    const g = byEdid(out, "Guard")!;
    const wanted = new Set(recordsOf(out).map((r) => r.formId >>> 0));
    for (const id of itemsOf(g)) expect(wanted.has(id) || id === VANILLA_ITEM).toBe(true);
  });
});

// ---------- randomised: every reference keeps pointing at the same record ----------

describe("random merges", () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("never changes which record a reference points at, whatever the master lists look like", async () => {
    const POOL = [SKYRIM, "Update.esm", "Dawnguard.esm", "HearthFires.esm", "Dragonborn.esm", "Extra.esm"];
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed);
      const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]!;
      const shuffle = <T>(list: T[]) => list.map((v) => [rand(), v] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
      const count = 2 + Math.floor(rand() * 3);
      const names = Array.from({ length: count }, (_, i) => `P${i}.esp`);

      interface Spec {
        masters: string[];
        lows: number[];
        refs: Map<number, { kind: "m" | "o"; who: string | number; low: number }[]>;
      }
      const specs: Spec[] = [];
      const files: EspFile[] = [];
      for (let k = 0; k < count; k++) {
        const deps = names.slice(0, k).filter(() => rand() < 0.6);
        const masters = shuffle([...POOL.filter(() => rand() < 0.5), ...deps]);
        const lows = shuffle(Array.from({ length: 30 }, (_, i) => 0x800 + i)).slice(0, 5 + Math.floor(rand() * 20));
        const spec: Spec = { masters, lows, refs: new Map() };
        const slotOf = (name: string) => masters.indexOf(name);
        const records: Uint8Array[] = [];
        for (const low of lows) {
          const list: { kind: "m" | "o"; who: string | number; low: number }[] = [];
          const raw: number[] = [];
          for (let r = 0; r < 5; r++) {
            const roll = rand();
            const dep = deps.length ? pick(deps) : null;
            if (roll < 0.35 && masters.some((m) => POOL.includes(m))) {
              const m = pick(masters.filter((x) => POOL.includes(x)));
              const l = 0x800 + Math.floor(rand() * 50);
              list.push({ kind: "m", who: m, low: l });
              raw.push(((slotOf(m) << 24) | l) >>> 0);
            } else if (roll < 0.7 || !dep) {
              const l = pick(lows);
              list.push({ kind: "o", who: k, low: l });
              raw.push(((masters.length << 24) | l) >>> 0);
            } else {
              const j = names.indexOf(dep);
              const l = pick(specs[j]!.lows);
              list.push({ kind: "o", who: j, low: l });
              raw.push(((slotOf(dep) << 24) | l) >>> 0);
            }
          }
          spec.refs.set(low, list);
          records.push(rec("ARMO", ((masters.length << 24) | low) >>> 0, `P${k}_${low}`, [kwda(...raw)]));
        }
        specs.push(spec);
        files.push(plugin(names[k]!, masters, [top("ARMO", records)]));
      }

      const { out, plan } = await merged(files);
      const ownSlot = plan.masters.length;
      const edidOf = new Map(recordsOf(out).map((r) => [r.formId >>> 0, getEditorId(r)!]));
      expect(recordsOf(out)).toHaveLength(specs.reduce((a, s) => a + s.lows.length, 0));
      expect(new Set(recordsOf(out).map((r) => r.formId >>> 0)).size).toBe(recordsOf(out).length);

      specs.forEach((spec, k) => {
        for (const low of spec.lows) {
          const got = byEdid(out, `P${k}_${low}`)!;
          expect(got).toBeDefined();
          const want = spec.refs.get(low)!;
          const have = refsOf(got).map((id) => {
            const slot = id >>> 24;
            if (slot === ownSlot) {
              const m = /^P(\d+)_(\d+)$/.exec(edidOf.get(id) ?? "");
              return m ? { kind: "o", who: Number(m[1]), low: Number(m[2]) } : { kind: "?", who: id, low: 0 };
            }
            return { kind: "m", who: plan.masters[slot]!.name, low: id & 0xffffff };
          });
          expect(have).toEqual(want);
        }
      });
    }
  });
});
