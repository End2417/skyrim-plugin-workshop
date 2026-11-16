// Making, copying and deleting records, each as one undoable step. UI-free so it stays testable.
//
// Records are made in the plugin's own FormID space (the master-count byte), take the next free ID from the header, and go
// into the top-level group of their type (made if the plugin has none yet). The header's record count and next object ID are
// kept in step, as deleteRecord already does for deletions.
import { defaultData, resolveSubDef } from "./decode";
import { RECORD_DEFS } from "./defs";
import type { History } from "./history";
import {
  deleteRecord,
  encodeZString,
  fileInfo,
  getEditorId,
  getSubrecords,
  markDirty,
  nextUid,
  revertRecord,
  walkRecords,
  type EspFile,
  type EspGroup,
  type EspRecord,
  type Subrecord,
} from "./format";

/** Types that sit in a top-level group of their own and make sense as a stand-alone new record. */
const NOT_CREATABLE = new Set(["TES4", "CELL", "WRLD", "REFR", "ACHR", "ACRE", "INFO", "DIAL", "LAND", "NAVM", "NAVI", "GMST", "PGRE", "PMIS", "PHZD"]);

export const creatableTypes = (): string[] => Object.keys(RECORD_DEFS).filter((t) => !NOT_CREATABLE.has(t)).sort();

/** Records that own nested groups (children) or are placed in a cell, which a copy would leave behind or break. */
const NOT_COPYABLE = new Set(["TES4", "CELL", "WRLD", "DIAL", "REFR", "ACHR", "ACRE", "LAND", "NAVM", "NAVI", "INFO"]);

/** Whether the record can be copied: it must be in a top-level group and not a type that has child groups. */
export function canCopy(r: EspRecord): boolean {
  return r.parent !== null && r.parent.groupType === 0 && !NOT_COPYABLE.has(r.type);
}

const tes4Of = (file: EspFile): EspRecord => {
  const t = file.nodes[0];
  if (!t || t.kind !== "record" || t.type !== "TES4") throw new Error("This file has no header record");
  return t;
};

const hedrOf = (file: EspFile): Subrecord => {
  const h = getSubrecords(tes4Of(file)).find((s) => s.type === "HEDR");
  if (!h || h.data.length < 12) throw new Error("The file header has no HEDR data");
  return h;
};

/** Why this Editor ID cannot be used for a new record, or null if it can. */
export function editorIdProblem(file: EspFile, edid: string): string | null {
  if (!edid) return "Enter an Editor ID.";
  if (!/^[A-Za-z0-9_]+$/.test(edid)) return "Use only letters, digits and underscores.";
  if (edid.length > 200) return "That Editor ID is too long.";
  const want = edid.toLowerCase();
  for (const r of walkRecords(file.nodes)) {
    if (r.type !== "TES4" && getEditorId(r)?.toLowerCase() === want) return `${edid} is already used by another record in this plugin.`;
  }
  return null;
}

/** A free Editor ID based on `base` ("IronSword" -> "IronSwordCopy", "IronSwordCopy2"...). */
export function freeEditorId(file: EspFile, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_]/g, "") || "NewRecord";
  const taken = new Set<string>();
  for (const r of walkRecords(file.nodes)) {
    const e = getEditorId(r);
    if (e) taken.add(e.toLowerCase());
  }
  let n = 0;
  for (;;) {
    const candidate = n === 0 ? clean : `${clean}${n + 1}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    n++;
  }
}

/** The next unused FormID of this plugin's own records. */
export function nextFormId(file: EspFile): number {
  const own = fileInfo(file).masters.length;
  const hedr = hedrOf(file);
  let next = new DataView(hedr.data.buffer, hedr.data.byteOffset, hedr.data.byteLength).getUint32(8, true) & 0xffffff;
  if (next < 0x800) next = 0x800; // below this the IDs belong to the engine
  const used = new Set<number>();
  for (const r of walkRecords(file.nodes)) if (r.type !== "TES4" && r.formId >>> 24 === own) used.add(r.formId & 0xffffff);
  while (used.has(next)) next++;
  if (next > 0xffffff) throw new Error("This plugin has run out of FormIDs");
  return ((own << 24) | next) >>> 0;
}

const sigBytes = (t: string) => Uint8Array.from(Array.from(t, (c) => c.charCodeAt(0) & 0xff));

export function topLevelGroup(file: EspFile, type: string): EspGroup | null {
  for (const n of file.nodes) {
    if (n.kind === "group" && n.groupType === 0 && String.fromCharCode(...n.label) === type) return n;
  }
  return null;
}

/** A record's form version to give new ones: that of the plugin's existing records, else by header version (SE writes 44, LE 43). */
function formVersionFor(file: EspFile): number {
  for (const r of walkRecords(file.nodes)) if (r.type !== "TES4") return r.version;
  const hedr = hedrOf(file);
  return new DataView(hedr.data.buffer, hedr.data.byteOffset).getFloat32(0, true) >= 1.5 ? 44 : 43;
}

/** The subrecords a new record of this type starts with: its Editor ID plus the few that the game needs to be present. */
export function startingSubrecords(type: string, edid: string, localized: boolean): Subrecord[] {
  const subs: Subrecord[] = [{ type: "EDID", data: encodeZString(edid) }];
  if (RECORD_DEFS[type]?.subs["OBND"] || ["WEAP", "ARMO", "AMMO", "BOOK", "MISC", "KEYM", "SLGM", "ALCH", "INGR", "SCRL", "LIGH", "CONT", "ACTI", "DOOR", "FURN", "STAT", "FLOR", "TREE"].includes(type)) {
    subs.push({ type: "OBND", data: new Uint8Array(12) });
  }
  if (type === "GLOB") subs.push({ type: "FNAM", data: Uint8Array.from([102]) }, { type: "FLTV", data: new Uint8Array(4) }); // a float global
  else {
    // Fixed-size subrecords the layout marks as the record's main data start at zero, as the editor's "add field" does
    const def = RECORD_DEFS[type]?.subs["DATA"];
    if (def && type !== "GMST") {
      const resolved = resolveSubDef(type, { type: "DATA", data: new Uint8Array(0) }, edid);
      const data = defaultData(resolved, localized);
      if (data.length > 0) subs.push({ type: "DATA", data });
    }
  }
  return subs;
}

function bumpHeader(file: EspFile, add: number, id?: number): void {
  const tes4 = tes4Of(file);
  markDirty(tes4);
  const hedr = hedrOf(file);
  const dv = new DataView(hedr.data.buffer, hedr.data.byteOffset, hedr.data.byteLength);
  dv.setInt32(4, dv.getInt32(4, true) + add, true);
  if (id === undefined) return;
  const next = (id & 0xffffff) + 1;
  if (next > (dv.getUint32(8, true) & 0xffffff)) dv.setUint32(8, (dv.getUint32(8, true) & 0xff000000) | next, true);
}

function newRecordObject(file: EspFile, type: string, formId: number, flags: number, version: number, subs: Subrecord[], parent: EspGroup): EspRecord {
  return {
    kind: "record",
    uid: nextUid(),
    type,
    flags,
    formId,
    stamp: 0,
    version,
    unknown: 0,
    raw: new Uint8Array(0),
    subrecords: subs,
    dirty: true,
    parent,
    editorIdCache: undefined,
    nameCache: undefined,
  };
}

/** Puts a record into the tree as one undoable step. `after` places it right behind that record, else at the end of the group. */
function place(history: History, file: EspFile, type: string, make: (group: EspGroup) => EspRecord, after: EspRecord | null, label: string): EspRecord {
  return history.batch(label, () => {
    let group = after ? after.parent : topLevelGroup(file, type);
    if (!group) {
      const g: EspGroup = { kind: "group", uid: nextUid(), label: sigBytes(type), groupType: 0, stamp: 0, unknown: 0, children: [], parent: null };
      history.trackPresence(label, file, g, () => file.nodes.push(g), true);
      group = g;
      bumpHeader(file, 1); // a group counts in the header like a record
    }
    const record = make(group);
    history.trackPresence(
      label,
      file,
      record,
      () => {
        const at = after ? group.children.indexOf(after) + 1 : group.children.length;
        group.children.splice(at, 0, record);
        (file.created ??= []).push(record);
      },
      true,
    );
    bumpHeader(file, 1, record.formId);
    return record;
  });
}

/** Makes a new record of `type` with the given Editor ID. Throws if the Editor ID cannot be used. */
export function createRecord(history: History, file: EspFile, type: string, edid: string): EspRecord {
  const problem = editorIdProblem(file, edid);
  if (problem) throw new Error(problem);
  const localized = fileInfo(file).localized;
  const formId = nextFormId(file);
  return place(history, file, type, (group) => newRecordObject(file, type, formId, 0, formVersionFor(file), startingSubrecords(type, edid, localized), group), null, `Create ${type} record`);
}

/** Copies a record into a new one of this plugin, right behind the original, under a new Editor ID. */
export function copyRecord(history: History, file: EspFile, source: EspRecord, edid: string): EspRecord {
  if (!canCopy(source)) throw new Error(`${source.type} records cannot be copied here.`);
  const problem = editorIdProblem(file, edid);
  if (problem) throw new Error(problem);
  const formId = nextFormId(file);
  const subs = getSubrecords(source).map((s): Subrecord => ({ type: s.type, data: s.data.slice() }));
  const at = subs.findIndex((s) => s.type === "EDID");
  const id: Subrecord = { type: "EDID", data: encodeZString(edid) };
  if (at >= 0) subs[at] = id;
  else subs.unshift(id);
  return place(history, file, source.type, (group) => newRecordObject(file, source.type, formId, source.flags & ~0x20, source.version, subs, group), source, `Copy ${source.type} record`);
}

/** Deletes a record as one undoable step. */
export function removeRecord(history: History, file: EspFile, r: EspRecord): void {
  history.batch("Delete record", () => {
    history.trackPresence("Delete record", file, r, () => deleteRecord(file, r), false);
  });
}

/** Deletes many records as one undoable step. */
export function removeRecords(history: History, file: EspFile, records: EspRecord[], label = "Delete records"): void {
  history.batch(label, () => {
    for (const r of records) history.trackPresence(label, file, r, () => deleteRecord(file, r), false);
  });
}

/** Brings back a record made earlier in the session (from a draft): same ID and header values, no history, header untouched. */
export function insertCreated(file: EspFile, type: string, header: { flags: number; formId: number; stamp: number; version: number; unknown: number }, subs: Subrecord[]): EspRecord {
  let group = topLevelGroup(file, type);
  if (!group) {
    group = { kind: "group", uid: nextUid(), label: sigBytes(type), groupType: 0, stamp: 0, unknown: 0, children: [], parent: null };
    file.nodes.push(group);
  }
  const r = newRecordObject(file, type, header.formId, header.flags, header.version, subs, group);
  r.stamp = header.stamp;
  r.unknown = header.unknown;
  group.children.push(r);
  (file.created ??= []).push(r);
  return r;
}

/**
 * Undoes every edit to a record, as one undoable step. A record made in this session has nothing to go back to, so it is
 * removed instead. Returns false if there was nothing to revert.
 */
export function revertWithHistory(history: History, file: EspFile, r: EspRecord): boolean {
  if (file.created?.includes(r)) {
    removeRecord(history, file, r);
    return true;
  }
  if (!r.dirty) return false;
  return history.batch("Revert record", () => {
    history.before(r);
    return revertRecord(r);
  });
}
