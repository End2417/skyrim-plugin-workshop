// Builds a small standalone plugin from selected records of a loaded plugin
// (e.g. change a sword in Skyrim.esm, then export just that sword as an .esp override).
// UI-free so it stays testable.
import { findSubDef } from "./defs";
import {
  encodeZString,
  fileInfo,
  getEditorId,
  getSubrecords,
  serializeEsp,
  walkRecords,
  type EspFile,
  type EspGroup,
  type EspNode,
  type EspRecord,
  type Subrecord,
} from "./format";
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

export function extractPlugin(file: EspFile, records: EspRecord[], opts: ExtractOptions = {}): Uint8Array {
  const picked = records.filter((r) => r.type !== "TES4");
  if (picked.length === 0) throw new Error("Select at least one record to extract.");
  const sourceName = (opts.sourceName ?? file.name).trim();
  if (!sourceName) throw new Error("Enter the name of the plugin these records come from.");

  const included = new Set<EspRecord>(picked);
  // Records inside a cell / worldspace / topic need that owner record present in the new file.
  const byId = new Map<number, EspRecord>();
  for (const r of walkRecords(file.nodes)) byId.set(r.formId >>> 0, r);
  const addOwners = (r: EspRecord) => {
    for (let g = r.parent; g; g = g.parent) {
      const id = ownerIds(g);
      const owner = id === null ? undefined : byId.get(id);
      if (owner && !included.has(owner)) {
        included.add(owner);
        addOwners(owner);
      }
    }
  };
  for (const r of picked) addOwners(r);

  const rewritten = rewriteLocalized(file, picked, opts);

  let groupCount = 0;
  // Keep the original order and group nesting, dropping everything not selected.
  const prune = (nodes: EspNode[], parent: EspGroup | null): EspNode[] => {
    const out: EspNode[] = [];
    for (const n of nodes) {
      if (n.kind === "record") {
        if (included.has(n)) out.push(cloneRecord(n, parent, rewritten.get(n)));
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
  const body = prune(file.nodes.slice(1), null);

  const header = buildHeader(file, sourceName, included.size + groupCount, opts.author ?? "Skyrim ESP Editor");
  return serializeEsp({ name: "extract.esp", nodes: [header, ...body] });
}
