// Compares two plugins record by record: what was added, removed or changed. UI-free so it stays testable.
//
// Two ways to read the pair:
//  - "master": the other plugin is a master of the open one (Skyrim.esm). The result is what the open plugin does to it:
//    new records, and overrides that change something or are identical to the original (ITM). Records only the master
//    has are not "removed", so they are left out.
//  - "versions": two versions of the same mod (Special Edition and Legendary Edition, old and new). Each plugin's own
//    records count as the same set, whatever the file is called, so renamed copies line up.
//
// Records are matched by where they come from (the master a FormID points at, or "this plugin") and their ID inside it, so
// plugins with different master lists still line up. FormIDs inside the data are compared as they are stored, so if the
// master lists differ, references to records can show up as changed even though they point at the same thing.
import { diffSubrecordLists, type FieldChange } from "./changes";
import { pluginBase } from "./bsa";
import type { DecodeContext } from "./decode";
import { FLAG_COMPRESSED, fileInfo, getEditorId, getOriginalSubrecords, getSubrecords, hex8, walkRecords, type EspFile, type EspRecord, type Subrecord } from "./format";

export type CompareMode = "auto" | "master" | "versions";
export type DifferenceKind = "added" | "removed" | "changed";
/** What differs in a changed record. */
export type DifferenceAspect = "data" | "flags" | "type" | "version";

export interface RecordDifference {
  kind: DifferenceKind;
  type: string;
  /** FormID in the file the record is from (the open plugin for added and changed, the other for removed). */
  formId: number;
  editorId: string | null;
  /** The record in the open plugin (added, changed). */
  mine: EspRecord | null;
  /** The record in the other plugin (removed, changed). */
  theirs: EspRecord | null;
  what: DifferenceAspect[];
}

export interface CompareOptions {
  mode?: CompareMode;
  /** Also report records whose only difference is the form version (SE writes 44, LE 43). Off by default. */
  compareFormVersion?: boolean;
}

export interface CompareResult {
  mode: Exclude<CompareMode, "auto">;
  mine: string;
  theirs: string;
  added: RecordDifference[];
  removed: RecordDifference[];
  changed: RecordDifference[];
  /** Records found in both and exactly the same. */
  identical: number;
  /** In "master" mode: the open plugin's records that are exactly the same as the master's (ITM), so they could be removed. */
  identicalRecords: EspRecord[];
  /** In "master" mode: records of the other plugin that the open one does not touch (not listed). */
  untouched: number;
  /** True when the lists above stop short of the real counts. */
  truncated: boolean;
  counts: { added: number; removed: number; changed: number };
  /** "versions" mode: the two plugins list different masters, so references inside records may differ for that reason alone. */
  mastersDiffer: boolean;
  localized: boolean;
}

export const MAX_LISTED = 3000;
const SLICE = 1500;
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Where a record's FormID comes from: a master's base name, or `own` for the plugin's own records. */
export function originOf(masters: string[], formId: number, own: string): string {
  const i = formId >>> 24;
  return i < masters.length ? pluginBase(masters[i]!) : own;
}

class Keys {
  private origins = new Map<string, number>();
  key(origin: string, formId: number): number {
    let i = this.origins.get(origin);
    if (i === undefined) {
      i = this.origins.size;
      this.origins.set(origin, i);
    }
    return i * 0x1000000 + (formId & 0xffffff);
  }
}

const bodyFlags = (f: number) => (f & ~FLAG_COMPRESSED) >>> 0;

/** The record's subrecords as they are now (edits included) without keeping every record's parse in memory. */
function subsOf(r: EspRecord): Subrecord[] {
  return r.dirty ? getSubrecords(r) : getOriginalSubrecords(r);
}

function sameSubs(a: Subrecord[], b: Subrecord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.type !== y.type || x.data.length !== y.data.length) return false;
    for (let k = 0; k < x.data.length; k++) if (x.data[k] !== y.data[k]) return false;
  }
  return true;
}

function rawEqual(a: EspRecord, b: EspRecord): boolean {
  if (a.dirty || b.dirty || a.raw.length !== b.raw.length) return false;
  for (let i = 0; i < a.raw.length; i++) if (a.raw[i] !== b.raw[i]) return false;
  return true;
}

/** How two records with the same identity differ; empty if they do not. */
export function aspectsOf(mine: EspRecord, theirs: EspRecord, compareFormVersion = false): DifferenceAspect[] {
  const what: DifferenceAspect[] = [];
  if (mine.type !== theirs.type) what.push("type");
  if (bodyFlags(mine.flags) !== bodyFlags(theirs.flags)) what.push("flags");
  if (compareFormVersion && mine.version !== theirs.version) what.push("version");
  // Same bytes with the same compression need no unpacking. Otherwise compare what is inside.
  if (!(rawEqual(mine, theirs) && (mine.flags & FLAG_COMPRESSED) === (theirs.flags & FLAG_COMPRESSED))) {
    let same = false;
    try {
      same = sameSubs(subsOf(mine), subsOf(theirs));
    } catch {
      same = false; // one of them cannot be unpacked: report it as different rather than hide it
    }
    if (!same) what.push("data");
  }
  return what;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/** Compares the open plugin with another. Returns null if cancelled. */
export async function compareFiles(mine: EspFile, theirs: EspFile, opts: CompareOptions = {}, cancelled: () => boolean = () => false): Promise<CompareResult | null> {
  if (cancelled()) return null;
  const a = fileInfo(mine);
  const b = fileInfo(theirs);
  const theirBase = pluginBase(theirs.name);
  const requested = opts.mode ?? "auto";
  const mode: "master" | "versions" = requested === "auto" ? (a.masters.some((m) => pluginBase(m) === theirBase) ? "master" : "versions") : requested;

  const ownMine = mode === "versions" ? "@own" : pluginBase(mine.name);
  const ownTheirs = mode === "versions" ? "@own" : theirBase;
  const mastersA = a.masters;
  const mastersB = b.masters;
  const keys = new Keys();

  const result: CompareResult = {
    mode,
    mine: mine.name,
    theirs: theirs.name,
    added: [],
    removed: [],
    changed: [],
    identical: 0,
    identicalRecords: [],
    untouched: 0,
    truncated: false,
    counts: { added: 0, removed: 0, changed: 0 },
    mastersDiffer: mode === "versions" && !sameList(mastersA.map(pluginBase), mastersB.map(pluginBase)),
    localized: a.localized,
  };

  const list = (kind: DifferenceKind, d: RecordDifference) => {
    result.counts[kind]++;
    const target = result[kind];
    if (target.length < MAX_LISTED) target.push(d);
    else result.truncated = true;
  };

  // Where each of the open plugin's records is
  const mineByKey = new Map<number, EspRecord>();
  for (const r of walkRecords(mine.nodes)) if (r.type !== "TES4") mineByKey.set(keys.key(originOf(mastersA, r.formId, ownMine), r.formId), r);

  // The other plugin's records. In master mode only the ones the open plugin has a counterpart for are kept.
  const theirsByKey = new Map<number, EspRecord>();
  let theirCount = 0;
  let n = 0;
  for (const r of walkRecords(theirs.nodes)) {
    if (r.type === "TES4") continue;
    if (++n % (SLICE * 4) === 0) {
      await yieldToUi();
      if (cancelled()) return null;
    }
    theirCount++;
    const k = keys.key(originOf(mastersB, r.formId, ownTheirs), r.formId);
    if (mode === "versions" || mineByKey.has(k)) theirsByKey.set(k, r);
  }

  n = 0;
  for (const [k, r] of mineByKey) {
    if (++n % SLICE === 0) {
      await yieldToUi();
      if (cancelled()) return null;
    }
    const other = theirsByKey.get(k);
    if (!other) {
      list("added", { kind: "added", type: r.type, formId: r.formId, editorId: getEditorId(r), mine: r, theirs: null, what: [] });
      continue;
    }
    const what = aspectsOf(r, other, opts.compareFormVersion ?? false);
    if (what.length === 0) {
      result.identical++;
      if (mode === "master") result.identicalRecords.push(r);
    } else list("changed", { kind: "changed", type: r.type, formId: r.formId, editorId: getEditorId(r), mine: r, theirs: other, what });
  }

  if (mode === "versions") {
    n = 0;
    for (const [k, r] of theirsByKey) {
      if (++n % SLICE === 0) {
        await yieldToUi();
        if (cancelled()) return null;
      }
      if (!mineByKey.has(k)) list("removed", { kind: "removed", type: r.type, formId: r.formId, editorId: getEditorId(r), mine: null, theirs: r, what: [] });
    }
  } else {
    result.untouched = Math.max(0, theirCount - theirsByKey.size);
  }
  return result;
}

/** Field-by-field detail of a changed record: the other plugin's value ("before") against the open plugin's ("after"). */
export function describeDifference(d: RecordDifference, localized: boolean): FieldChange[] {
  if (d.kind !== "changed" || !d.mine || !d.theirs) return [];
  const ctx: DecodeContext = { localized, resolveFormId: (id) => `[${hex8(id)}]` };
  const out: FieldChange[] = [];
  if (d.what.includes("type")) out.push({ label: "Record type", before: d.theirs.type, after: d.mine.type });
  if (d.what.includes("flags")) out.push({ label: "Record flags", before: hex8(d.theirs.flags), after: hex8(d.mine.flags) });
  if (d.what.includes("version")) out.push({ label: "Form version", before: String(d.theirs.version), after: String(d.mine.version) });
  if (d.what.includes("data")) {
    let fields: FieldChange[] = [];
    try {
      fields = diffSubrecordLists(d.mine.type, getEditorId(d.mine) ?? "", subsOf(d.theirs), subsOf(d.mine), ctx, 60);
    } catch {
      out.push({ label: "Data", before: "(could not be read)", after: "(could not be read)" });
    }
    out.push(...fields);
    if (fields.length === 0 && !out.some((f) => f.label === "Data")) out.push({ label: "Data", before: "(see raw data)", after: "(differs)" });
  }
  return out;
}
