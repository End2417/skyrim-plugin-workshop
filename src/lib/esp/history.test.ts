import { afterEach, describe, expect, it } from "vitest";
import { applyDraft, makeDraft } from "./draft";
import { canCopy, copyRecord, createRecord, creatableTypes, editorIdProblem, freeEditorId, nextFormId, removeRecord, removeRecords } from "./records";
import { History } from "./history";
import { encodeZString, getEditorId, getSubrecords, markDirty, parseEsp, serializeEsp, walkRecords, type EspFile, type EspRecord } from "./format";
import { buildPlugin } from "./testPlugin";

const data10 = (v: number) => {
  const d = new Uint8Array(10);
  new DataView(d.buffer).setUint32(0, v, true);
  return d;
};
const sample = (): EspFile =>
  buildPlugin("Mod.esp", ["Skyrim.esm"], [
    { type: "WEAP", formId: 0x01000800, edid: "IronSword", subs: [{ type: "DATA", data: data10(25) }] },
    { type: "WEAP", formId: 0x01000801, edid: "SteelSword", subs: [{ type: "DATA", data: data10(45) }] },
    { type: "MISC", formId: 0x01000802, edid: "Gem", subs: [{ type: "DATA", data: new Uint8Array(8) }] },
  ]);
const find = (f: EspFile, edid: string) => [...walkRecords(f.nodes)].find((r) => getEditorId(r) === edid) as EspRecord;
const value = (r: EspRecord) => new DataView(getSubrecords(r).find((s) => s.type === "DATA")!.data.buffer).getUint32(0, true);
const setValue = (r: EspRecord, v: number) => {
  markDirty(r);
  new DataView(getSubrecords(r).find((s) => s.type === "DATA")!.data.buffer).setUint32(0, v, true);
};
const hedr = (f: EspFile) => {
  const d = getSubrecords(f.nodes[0] as EspRecord).find((s) => s.type === "HEDR")!.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { count: dv.getInt32(4, true), next: dv.getUint32(8, true) };
};

let history: History | null = null;
const make = (now = () => 0) => {
  history?.detach();
  history = new History({ now });
  history.attach();
  return history;
};
afterEach(() => history?.detach());

describe("History: edits", () => {
  it("undoes and redoes an edit, back to a clean record", () => {
    const h = make();
    const f = sample();
    const r = find(f, "IronSword");
    setValue(r, 99);
    expect(r.dirty).toBe(true);
    expect(h.canUndo).toBe(true);
    expect(h.undo()).toBe("Edit record");
    expect(r.dirty).toBe(false);
    expect(value(r)).toBe(25);
    expect(h.canRedo).toBe(true);
    h.redo();
    expect(r.dirty).toBe(true);
    expect(value(r)).toBe(99);
  });

  it("joins quick edits to one record into one step, and keeps later ones apart", () => {
    let t = 0;
    const h = make(() => t);
    const r = find(sample(), "IronSword");
    setValue(r, 1);
    t = 300;
    setValue(r, 12);
    t = 600;
    setValue(r, 123);
    h.undo();
    expect(value(r)).toBe(25);
    expect(h.canUndo).toBe(false);

    h.redo();
    t = 10_000;
    setValue(r, 7);
    h.undo();
    expect(value(r)).toBe(123); // the later edit is its own step
    h.undo();
    expect(value(r)).toBe(25);
  });

  it("returns to the earlier edit, not to the original, when the record was already edited", () => {
    let t = 0;
    const h = make(() => t);
    const r = find(sample(), "IronSword");
    setValue(r, 50);
    t = 10_000;
    setValue(r, 60);
    h.undo();
    expect(r.dirty).toBe(true);
    expect(value(r)).toBe(50);
  });

  it("forgets what could be redone after a new edit", () => {
    let t = 0;
    const h = make(() => t);
    const r = find(sample(), "IronSword");
    setValue(r, 50);
    h.undo();
    expect(h.canRedo).toBe(true);
    t = 5000;
    setValue(r, 70);
    expect(h.canRedo).toBe(false);
  });

  it("makes one step of everything changed in a batch", () => {
    const h = make();
    const f = sample();
    h.batch("Bulk edit", () => {
      setValue(find(f, "IronSword"), 1);
      setValue(find(f, "SteelSword"), 2);
      setValue(find(f, "IronSword"), 3);
    });
    expect(h.undoLabel).toBe("Bulk edit");
    h.undo();
    expect([value(find(f, "IronSword")), value(find(f, "SteelSword"))]).toEqual([25, 45]);
    expect(h.canUndo).toBe(false);
    h.redo();
    expect([value(find(f, "IronSword")), value(find(f, "SteelSword"))]).toEqual([3, 2]);
  });

  it("keeps only the newest steps up to its limit", () => {
    const h = new History({ limit: 2, now: () => 0 });
    h.attach();
    history = h;
    const f = sample();
    h.batch("a", () => setValue(find(f, "IronSword"), 1));
    h.batch("b", () => setValue(find(f, "SteelSword"), 2));
    h.batch("c", () => setValue(find(f, "Gem"), 3));
    h.undo();
    h.undo();
    expect(h.undo()).toBeNull();
  });
});

describe("History: deleting records", () => {
  it("brings a deleted record back where it was, with the header and the deleted list", () => {
    const h = make();
    const f = sample();
    const before = hedr(f).count;
    const sword = find(f, "IronSword");
    removeRecord(h, f, sword);
    expect(find(f, "IronSword")).toBeUndefined();
    expect(hedr(f).count).toBe(before - 1);
    expect(f.deleted).toEqual(["WEAP:01000800"]);

    expect(h.undo()).toBe("Delete record");
    expect([...walkRecords(f.nodes)].map((r) => getEditorId(r))).toEqual([null, "IronSword", "SteelSword", "Gem"]);
    expect(hedr(f).count).toBe(before);
    expect(f.deleted ?? []).toEqual([]);
    expect(sword.parent!.children[0]).toBe(sword);

    h.redo();
    expect(find(f, "IronSword")).toBeUndefined();
    expect(hedr(f).count).toBe(before - 1);
    expect(f.deleted).toEqual(["WEAP:01000800"]);
  });

  it("deletes several records as one step", () => {
    const h = make();
    const f = sample();
    removeRecords(h, f, [find(f, "IronSword"), find(f, "Gem")]);
    expect([...walkRecords(f.nodes)].map((r) => getEditorId(r))).toEqual([null, "SteelSword"]);
    h.undo();
    expect([...walkRecords(f.nodes)].map((r) => getEditorId(r))).toEqual([null, "IronSword", "SteelSword", "Gem"]);
    expect(h.canUndo).toBe(false);
  });
});

describe("creating and copying records", () => {
  it("makes a record in the plugin's own ID space, in its type's group, and undoes it", () => {
    const h = make();
    const f = sample();
    const count = hedr(f).count;
    const r = createRecord(h, f, "WEAP", "MyNewSword");
    expect(r.formId >>> 24).toBe(1);
    expect(r.formId & 0xffffff).toBeGreaterThanOrEqual(0x800);
    expect(getEditorId(r)).toBe("MyNewSword");
    expect(r.parent!.children).toContain(r);
    expect(f.created).toEqual([r]);
    expect(hedr(f).count).toBe(count + 1);
    expect(hedr(f).next).toBe((r.formId & 0xffffff) + 1);

    h.undo();
    expect(find(f, "MyNewSword")).toBeUndefined();
    expect(hedr(f).count).toBe(count);
    expect(f.created ?? []).toEqual([]);
    h.redo();
    expect(find(f, "MyNewSword")).toBe(r);
    expect(f.created).toEqual([r]);
  });

  it("makes the type's group when the plugin has none, and removes it again on undo", () => {
    const h = make();
    const f = sample();
    const groups = f.nodes.length;
    const r = createRecord(h, f, "KYWD", "MyKeyword");
    expect(f.nodes.length).toBe(groups + 1);
    expect(String.fromCharCode(...(f.nodes[f.nodes.length - 1] as { label: Uint8Array }).label)).toBe("KYWD");
    expect(r.parent).toBe(f.nodes[f.nodes.length - 1]);
    h.undo();
    expect(f.nodes.length).toBe(groups);
  });

  it("writes a file that reads back with the new record and a header count that matches", () => {
    const h = make();
    const f = sample();
    createRecord(h, f, "KYWD", "MyKeyword");
    createRecord(h, f, "GLOB", "MyGlobal");
    const back = parseEsp(serializeEsp(f), "Mod.esp");
    const ids = [...walkRecords(back.nodes)].map((r) => getEditorId(r));
    expect(ids).toContain("MyKeyword");
    expect(ids).toContain("MyGlobal");
    const glob = [...walkRecords(back.nodes)].find((r) => r.type === "GLOB")!;
    expect(getSubrecords(glob).map((s) => s.type)).toEqual(["EDID", "FNAM", "FLTV"]);
    let nodes = 0;
    const count = (list: typeof back.nodes) => list.forEach((n) => (nodes++, n.kind === "group" && count(n.children)));
    count(back.nodes.slice(1));
    expect(hedr(back).count).toBe(nodes);
  });

  it("copies a record right behind the original with a new ID and Editor ID", () => {
    const h = make();
    const f = sample();
    const src = find(f, "IronSword");
    const copy = copyRecord(h, f, src, "IronSwordCopy");
    expect(copy.formId).not.toBe(src.formId);
    expect(copy.formId >>> 24).toBe(1);
    expect(src.parent!.children.indexOf(copy)).toBe(src.parent!.children.indexOf(src) + 1);
    expect(getEditorId(copy)).toBe("IronSwordCopy");
    expect(value(copy)).toBe(25);
    // the copy has its own data
    markDirty(copy);
    new DataView(getSubrecords(copy).find((s) => s.type === "DATA")!.data.buffer).setUint32(0, 1, true);
    expect(value(src)).toBe(25);
    h.undo();
    h.undo();
    expect(find(f, "IronSwordCopy")).toBeUndefined();
  });

  it("refuses unusable Editor IDs and records it cannot copy", () => {
    const h = make();
    const f = sample();
    expect(editorIdProblem(f, "")).toMatch(/Enter/);
    expect(editorIdProblem(f, "has space")).toMatch(/letters/);
    expect(editorIdProblem(f, "ironsword")).toMatch(/already used/);
    expect(editorIdProblem(f, "Fresh_1")).toBeNull();
    expect(() => createRecord(h, f, "WEAP", "IronSword")).toThrow(/already used/);
    expect(canCopy(find(f, "IronSword"))).toBe(true);
    expect(canCopy(f.nodes[0] as EspRecord)).toBe(false);
    expect(freeEditorId(f, "IronSword")).toBe("IronSword2");
    expect(creatableTypes()).toContain("WEAP");
    expect(creatableTypes()).not.toContain("CELL");
  });

  it("skips IDs that are taken and keeps new ones out of the engine's range", () => {
    const f = sample();
    expect(nextFormId(f) & 0xffffff).toBe(0x803);
    const h = make();
    const a = createRecord(h, f, "MISC", "A1");
    const b = createRecord(h, f, "MISC", "B1");
    expect(b.formId).toBe(a.formId + 1);
    expect(a.formId & 0xffffff).toBeGreaterThanOrEqual(0x800);
  });
});

describe("History: edits to a record made this session", () => {
  it("can undo an edit to a created record and an edit then a delete in order", () => {
    let t = 0;
    const h = make(() => t);
    const f = sample();
    const r = createRecord(h, f, "WEAP", "Fresh");
    t = 5000;
    markDirty(r);
    getSubrecords(r)[0] = { type: "EDID", data: encodeZString("Renamed") };
    removeRecord(h, f, r);
    h.undo(); // delete
    expect(getEditorId(r)).toBe("Renamed");
    h.undo(); // edit
    expect(getEditorId(r)).toBe("Fresh");
    h.undo(); // create
    expect(find(f, "Fresh")).toBeUndefined();
  });
});

describe("drafts and created records", () => {
  it("brings records made this session back, with the header, when the draft is applied to a fresh copy", () => {
    const h = make();
    const f = sample();
    const made = createRecord(h, f, "KYWD", "DraftKeyword");
    copyRecord(h, f, find(f, "IronSword"), "DraftSword");
    const draft = makeDraft(f, "sig")!;
    expect(draft.created?.map((c) => c.type).sort()).toEqual(["KYWD", "WEAP"]);
    // created records are not also listed as edited ones
    expect(draft.records.map((r) => r.key).some((k) => k.includes(made.formId.toString(16).toUpperCase()))).toBe(false);

    const fresh = sample();
    const result = applyDraft(fresh, JSON.parse(JSON.stringify(draft)));
    expect(result.missing).toBe(0);
    expect(getEditorId(find(fresh, "DraftKeyword"))).toBe("DraftKeyword");
    expect(find(fresh, "DraftSword").formId).toBe(find(f, "DraftSword").formId);
    expect(hedr(fresh)).toEqual(hedr(f));
    expect(fresh.created).toHaveLength(2);
    // and it saves
    expect([...walkRecords(parseEsp(serializeEsp(fresh), "x.esp").nodes)].map((r) => getEditorId(r))).toContain("DraftSword");
  });
});

describe("revertWithHistory", () => {
  it("restores an edited record and can be undone, and removes a record made this session instead", async () => {
    const { revertWithHistory } = await import("./records");
    const h = make();
    const f = sample();
    const r = find(f, "IronSword");
    setValue(r, 77);
    expect(revertWithHistory(h, f, r)).toBe(true);
    expect(r.dirty).toBe(false);
    expect(value(r)).toBe(25);
    h.undo();
    expect(value(r)).toBe(77);
    expect(revertWithHistory(h, f, find(f, "SteelSword"))).toBe(false);

    const made = createRecord(h, f, "KYWD", "Fresh");
    expect(revertWithHistory(h, f, made)).toBe(true);
    expect(find(f, "Fresh")).toBeUndefined();
    h.undo();
    expect(find(f, "Fresh")).toBe(made);
  });
});
