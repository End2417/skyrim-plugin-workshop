// Builds a small standalone plugin from selected records of a loaded plugin
// (e.g. change a sword in Skyrim.esm, then export just that sword as an .esp override).
// UI-free so it stays testable.
import { findSubDef } from "./defs";
import {
  buildFormIdIndex,
  encodeZString,
  fileInfo,
  getEditorId,
  getSubrecords,
  markDirty,
  serializeEsp,
  walkRecords,
  type EspFile,
  type EspGroup,
  type EspNode,
  type EspRecord,
  type Subrecord,
} from "./format";
import { forEachFormIdRef } from "./refs";
import { lookupString } from "./strings";

const FLAG_ESM = 0x00000001;
const FLAG_LOCALIZED = 0x00000080;
const FLAG_ESL = 0x00000200;

/** Records the user has edited (the TES4 header is never extracted). */
export function listChangedRecords(file: EspFile): EspRecord[] {
  const out: EspRecord[] = [];
  for (const r of walkRecords(file.nodes)) if (r.dirty && r.type !== "TES4") out.push(r);
  return out;
}

/** A localized-string field (name, description...) that must become plain text in the new plugin. */
export interface LocalizedField {
  record: EspRecord;
  sub: string;
  /** Index of the subrecord within the record, so repeated signatures stay distinct. */
  index: number;
  stringId: number;
}

function isLstr(recordType: string, subType: string): boolean {
  const def = findSubDef(recordType, subType)?.def;
  return typeof def === "object" && def !== null && def.k === "lstr";
}

/**
 * Skyrim.esm and other localized plugins store text as IDs into their own string tables.
 * A new plugin has no such tables, so those fields need real text. Only top-level text
 * subrecords (FULL, DESC, ...) are detected.
 */
export function findLocalizedFields(file: EspFile, records: EspRecord[]): LocalizedField[] {
  if (!fileInfo(file).localized) return [];
  const out: LocalizedField[] = [];
  for (const record of records) {
    getSubrecords(record).forEach((s, index) => {
      if (s.data.length === 4 && isLstr(record.type, s.type)) {
        out.push({ record, sub: s.type, index, stringId: new DataView(s.data.buffer, s.data.byteOffset, 4).getUint32(0, true) });
      }
    });
  }
  return out;
}

export interface ExtractOptions {
  /** Plugin the records come from; becomes the new plugin's master. Defaults to the open file's name. */
  sourceName?: string;
  /** Replacement text for localized fields, keyed like {@link fieldKey}. Missing/blank = fallback. */
  text?: Map<string, string>;
  author?: string;
}

export const fieldKey = (f: Pick<LocalizedField, "record" | "index">) => `${f.record.uid}:${f.index}`;

function cloneRecord(r: EspRecord, parent: EspGroup | null, subrecords?: Subrecord[]): EspRecord {
  return { ...r, parent, ...(subrecords ? { subrecords, dirty: true } : {}), editorIdCache: undefined, nameCache: undefined };
}

/** Owner record a children group hangs off (cell, worldspace, dialogue topic), if any. */
function ownerIds(g: EspGroup): number | null {
  if (g.groupType === 1 || g.groupType === 6 || g.groupType === 7) {
    return new DataView(g.label.buffer, g.label.byteOffset, 4).getUint32(0, true);
  }
  return null;
}

function buildHeader(file: EspFile, sourceName: string, recordCount: number, author: string): EspRecord {
  const src = file.nodes[0] as EspRecord;
  const srcSubs = getSubrecords(src);
  const hedrSrc = srcSubs.find((s) => s.type === "HEDR")?.data;
  const hedr = new Uint8Array(12);
  const dv = new DataView(hedr.buffer);
  if (hedrSrc && hedrSrc.length >= 12) hedr.set(hedrSrc.subarray(0, 12));
  else dv.setFloat32(0, 1.7, true);
  dv.setInt32(4, recordCount, true);
  if (!hedrSrc) dv.setUint32(8, 0x800, true);

  const subs: Subrecord[] = [
    { type: "HEDR", data: hedr },
    { type: "CNAM", data: encodeZString(author) },
    { type: "SNAM", data: encodeZString(`Records extracted from ${sourceName}`) },
  ];
  const masters = srcSubs.filter((s) => s.type === "MAST").map((s) => s.data);
  // The source file is the last master: its own FormID index (= its master count) then
  // points at it, so every extracted record's FormID stays valid unchanged.
  masters.push(encodeZString(sourceName));
  for (const m of masters) {
    subs.push({ type: "MAST", data: m });
    subs.push({ type: "DATA", data: new Uint8Array(8) });
  }

  return {
    kind: "record",
    uid: -1,
    type: "TES4",
    // Plain .esp: not a master, not light, not localized (text is written inline below).
    flags: src.flags & ~(FLAG_ESM | FLAG_ESL | FLAG_LOCALIZED),
    formId: 0,
    stamp: src.stamp,
    version: src.version,
    unknown: src.unknown,
    raw: new Uint8Array(0),
    subrecords: subs,
    dirty: true,
    parent: null,
  };
}

/** Plain-text replacements for localized fields, as a map from record uid to subrecords. */
function rewriteLocalized(file: EspFile, records: EspRecord[], opts: ExtractOptions): Map<EspRecord, Subrecord[]> {
  const out = new Map<EspRecord, Subrecord[]>();
  const fields = findLocalizedFields(file, records);
  if (fields.length === 0) return out;
  const byRecord = new Map<EspRecord, LocalizedField[]>();
  for (const f of fields) byRecord.set(f.record, [...(byRecord.get(f.record) ?? []), f]);
  for (const [record, list] of byRecord) {
    const subs = getSubrecords(record).slice();
    const drop = new Set<number>();
    for (const f of list) {
      const typed = opts.text?.get(fieldKey(f))?.trim() || lookupString(f.stringId) || ""; // typed text, else the loaded strings files
      if (typed) subs[f.index] = { type: f.sub, data: encodeZString(typed) };
      else if (f.sub === "FULL") subs[f.index] = { type: "FULL", data: encodeZString(getEditorId(record) ?? "Unnamed") };
      else drop.add(f.index); // no text known: omit rather than leave an unreadable string ID
    }
    out.set(record, subs.filter((_, i) => !drop.has(i)));
  }
  return out;
}

/** Records, in file order and original group nesting, ready to write into a plugin. */
interface ExtractTree {
  nodes: EspNode[];
  recordCount: number;
  groupCount: number;
  /** Clones of records that were only pulled in to make others valid (owners, dependencies). */
  weak: Set<EspRecord>;
}

function buildTree(file: EspFile, records: EspRecord[], opts: ExtractOptions, weakRecords: EspRecord[] = []): ExtractTree {
  const picked = records.filter((r) => r.type !== "TES4");
  if (picked.length === 0) throw new Error("Select at least one record to extract.");

  const included = new Set<EspRecord>(picked);
  const weakSource = new Set<EspRecord>(weakRecords);
  // Records inside a cell / worldspace / topic need that owner record present in the new file.
  const byId = new Map<number, EspRecord>();
  for (const r of walkRecords(file.nodes)) byId.set(r.formId >>> 0, r);
  const addOwners = (r: EspRecord) => {
    for (let g = r.parent; g; g = g.parent) {
      const id = ownerIds(g);
      const owner = id === null ? undefined : byId.get(id);
      if (owner && !included.has(owner)) {
        included.add(owner);
        weakSource.add(owner);
        addOwners(owner);
      }
    }
  };
  for (const r of picked) addOwners(r);

  const rewritten = rewriteLocalized(file, picked, opts);

  let groupCount = 0;
  let recordCount = 0;
  const weak = new Set<EspRecord>();
  // Keep the original order and group nesting, dropping everything not selected.
  const prune = (nodes: EspNode[], parent: EspGroup | null): EspNode[] => {
    const out: EspNode[] = [];
    for (const n of nodes) {
      if (n.kind === "record") {
        if (included.has(n)) {
          const clone = cloneRecord(n, parent, rewritten.get(n));
          if (weakSource.has(n)) weak.add(clone);
          recordCount++;
          out.push(clone);
        }
      } else {
        const g: EspGroup = { ...n, parent, children: [] };
        g.children = prune(n.children, g);
        if (g.children.length > 0) {
          groupCount++;
          out.push(g);
        }
      }
    }
    return out;
  };
  const nodes = prune(file.nodes.slice(1), null);
  return { nodes, recordCount, groupCount, weak };
}

export function extractPlugin(file: EspFile, records: EspRecord[], opts: ExtractOptions = {}): Uint8Array {
  const sourceName = (opts.sourceName ?? file.name).trim();
  if (!sourceName) throw new Error("Enter the name of the plugin these records come from.");
  const tree = buildTree(file, records, opts);
  const header = buildHeader(file, sourceName, tree.recordCount + tree.groupCount, opts.author ?? "Skyrim ESP Editor");
  return serializeEsp({ name: "extract.esp", nodes: [header, ...tree.nodes] });
}

// ---------- records a change depends on ----------

export interface DependencyOptions {
  /** How many steps of references to follow (1 = only what the chosen records point at). Default 1. */
  depth?: number;
  /** Stop adding after this many records. Default 500. */
  limit?: number;
  /** FormID index of the file, when the caller already has one. */
  index?: Map<number, EspRecord>;
}

export interface DependencyResult {
  records: EspRecord[];
  /** True when the limit cut the search short. */
  truncated: boolean;
}

/**
 * Records of the same plugin that `roots` point at (keywords, sounds, items, ...), following references
 * `depth` steps. References into other plugins are not followed, since those records are not in this file.
 * Only fields the editor has layouts for are inspected.
 */
export function findDependencies(file: EspFile, roots: EspRecord[], opts: DependencyOptions = {}): DependencyResult {
  const depth = Math.max(1, opts.depth ?? 1);
  const limit = opts.limit ?? 500;
  const index = opts.index ?? buildFormIdIndex(file);
  const localized = fileInfo(file).localized;
  const seen = new Set<EspRecord>(roots);
  const found: EspRecord[] = [];
  let truncated = false;
  let frontier = roots;
  for (let step = 0; step < depth && frontier.length > 0 && !truncated; step++) {
    const next: EspRecord[] = [];
    for (const r of frontier) {
      if (r.type === "TES4") continue;
      forEachFormIdRef(r, localized, ({ id }) => {
        const target = index.get(id >>> 0);
        if (!target || target.type === "TES4" || seen.has(target)) return;
        if (found.length >= limit) {
          truncated = true;
          return;
        }
        seen.add(target);
        found.push(target);
        next.push(target);
      });
    }
    frontier = next;
  }
  return { records: found, truncated };
}

// ---------- adding records to an existing patch plugin ----------

export type MasterPlan = { ok: true; add: string[] } | { ok: false; reason: string };

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether records of `source` can be copied into `target` without renumbering any FormID.
 * FormIDs start with the slot of a plugin in the master list, so the patch must list the source's
 * masters, then the source itself, in the same slots. Missing ones at the end can be appended,
 * provided the patch has no records of its own (those use the slot right after the last master).
 */
export function planMasters(target: EspFile, source: EspFile, sourceName: string): MasterPlan {
  const t = fileInfo(target);
  if (t.localized) {
    return { ok: false, reason: "This patch is a localized plugin, which stores text in string tables. Pick a plain .esp." };
  }
  const expected = [...fileInfo(source).masters, sourceName];
  const have = t.masters;
  const common = Math.min(have.length, expected.length);
  for (let i = 0; i < common; i++) {
    if (!sameName(have[i]!, expected[i]!)) {
      return {
        ok: false,
        reason: `Master slot ${i} is ${have[i]} in the patch but ${expected[i]} in the records you are adding, so their FormIDs would point at the wrong files. Renumbering FormIDs is not supported. Extract into a new plugin instead, or use a patch made from the same source.`,
      };
    }
  }
  if (have.length >= expected.length) return { ok: true, add: [] };
  for (const r of walkRecords(target.nodes)) {
    if (r.type !== "TES4" && r.formId >>> 24 >= have.length) {
      return {
        ok: false,
        reason: `The patch has records of its own, and adding ${expected.slice(have.length).join(", ")} to its master list would shift their FormIDs. Renumbering is not supported.`,
      };
    }
  }
  return { ok: true, add: expected.slice(have.length) };
}

export interface MergeOptions extends ExtractOptions {
  /** Records copied only if the patch lacks them, e.g. dependencies, so edits already in the patch are kept. */
  weak?: EspRecord[];
  /** Replace a record the patch already has with the same FormID. Default true. */
  replaceExisting?: boolean;
}

export interface MergeResult {
  bytes: Uint8Array;
  added: number;
  replaced: number;
  /** Records skipped because the patch already had them (kept as they were). */
  kept: number;
  mastersAdded: string[];
}

const sameLabel = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function countNodes(nodes: EspNode[]): number {
  let c = 0;
  for (const n of nodes) c += n.kind === "record" ? 1 : 1 + countNodes(n.children);
  return c;
}

/**
 * Copies `records` of `source` into `target` (a parsed existing patch), replacing same-FormID records,
 * appends any missing master and fixes the header's record count. Mutates `target`; parse it afresh per call.
 */
export function mergeIntoPlugin(target: EspFile, source: EspFile, records: EspRecord[], opts: MergeOptions = {}): MergeResult {
  const sourceName = (opts.sourceName ?? source.name).trim();
  if (!sourceName) throw new Error("Enter the name of the plugin these records come from.");
  const plan = planMasters(target, source, sourceName);
  if (!plan.ok) throw new Error(plan.reason);

  const tree = buildTree(source, records, opts, opts.weak);
  const replaceExisting = opts.replaceExisting ?? true;
  const stats = { added: 0, replaced: 0, kept: 0 };

  const mergeInto = (dest: EspNode[], parent: EspGroup | null, incoming: EspNode[]) => {
    for (const n of incoming) {
      if (n.kind === "group") {
        const match = dest.find((d): d is EspGroup => d.kind === "group" && d.groupType === n.groupType && sameLabel(d.label, n.label));
        if (match) {
          mergeInto(match.children, match, n.children);
        } else {
          n.parent = parent;
          dest.push(n);
          stats.added += countRecordsIn(n);
        }
        continue;
      }
      const at = dest.findIndex((d) => d.kind === "record" && d.type === n.type && d.formId >>> 0 === n.formId >>> 0);
      n.parent = parent;
      if (at < 0) {
        dest.push(n);
        stats.added++;
      } else if (replaceExisting && !tree.weak.has(n)) {
        dest[at] = n;
        stats.replaced++;
      } else {
        stats.kept++;
      }
    }
  };
  mergeInto(target.nodes, null, tree.nodes); // slot 0 is the TES4 header, which no incoming record matches

  const tes4 = target.nodes[0] as EspRecord;
  markDirty(tes4);
  const subs = getSubrecords(tes4);
  if (plan.add.length > 0) {
    let at = subs.map((s) => s.type).lastIndexOf("MAST");
    if (at >= 0) at += subs[at + 1]?.type === "DATA" ? 2 : 1;
    else at = subs.filter((s) => ["HEDR", "CNAM", "SNAM"].includes(s.type)).length;
    const pairs: Subrecord[] = plan.add.flatMap((name) => [
      { type: "MAST", data: encodeZString(name) },
      { type: "DATA", data: new Uint8Array(8) },
    ]);
    subs.splice(at, 0, ...pairs);
  }
  const hedr = subs.find((s) => s.type === "HEDR");
  if (hedr && hedr.data.length >= 8) {
    new DataView(hedr.data.buffer, hedr.data.byteOffset, hedr.data.byteLength).setInt32(4, countNodes(target.nodes.slice(1)), true);
  }

  return { bytes: serializeEsp(target), ...stats, mastersAdded: plan.add };
}

function countRecordsIn(g: EspGroup): number {
  let c = 0;
  for (const n of g.children) c += n.kind === "record" ? 1 : countRecordsIn(n);
  return c;
}
