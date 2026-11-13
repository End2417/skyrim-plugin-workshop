// Bulk edit: change one numeric field in many records at once (halve every armor's weight, raise all weapon damage by
// 10%...), with a preview of every change before anything is written. UI-free so it stays testable.
import { decodeSubrecord, readLeafValue, writeLeaf, type DecodeContext, type FieldNode, type Leaf } from "./decode";
import { getDisplayName, getEditorId, getSubrecords, markDirty, type EspRecord } from "./format";

/** A numeric field that records of one type have: a subrecord plus the path to a value inside it. */
export interface BulkField {
  /** Stable identity: subrecord signature and the names leading to the value. */
  key: string;
  /** What the person sees, e.g. "DATA - Data › Weight". */
  label: string;
  sub: string;
  path: string[];
  integer: boolean;
}

export type BulkOp = "set" | "add" | "multiply" | "percent";

export const BULK_OP_LABELS: Record<BulkOp, string> = {
  set: "Set to",
  add: "Add",
  multiply: "Multiply by",
  percent: "Change by %",
};

export interface BulkEdit {
  field: BulkField;
  op: BulkOp;
  value: number;
}

export interface BulkChange {
  record: EspRecord;
  /** Which subrecord of the record. */
  subIndex: number;
  leaf: Leaf;
  before: number;
  after: number;
  /** Why this one cannot be written (for example out of range), or null. */
  error: string | null;
  edid: string;
  name: string;
}

const noIds = (id: number) => id.toString(16);
const ctxOf = (localized: boolean): DecodeContext => ({ localized, resolveFormId: noIds });

/** Whether a leaf is a plain number: not an enum, a set of flags or a hex parameter. */
function isPlainNumber(leaf: Leaf | undefined): boolean {
  if (!leaf) return false;
  const d = leaf.def;
  if (d.k === "f32") return true;
  if (d.k === "fid" || d.k === "str" || d.k === "lstr" || d.k === "bytes" || d.k === "struct" || d.k === "array") return false;
  return !d.enum && !d.flags && !d.hex;
}

/** Finds the node at `path` below a subrecord's root. Arrays are not entered: their entries are not a stable place to point at. */
function nodeAt(root: FieldNode, path: string[]): FieldNode | null {
  let node: FieldNode = root;
  for (const step of path) {
    if (node.array) return null;
    const next: FieldNode | undefined = node.children?.find((c) => c.label === step);
    if (!next) return null;
    node = next;
  }
  return node;
}

function collect(root: FieldNode, out: Map<string, BulkField>, sub: string) {
  const walk = (node: FieldNode, path: string[]) => {
    if (node.leaf && isPlainNumber(node.leaf)) {
      const key = `${sub}|${path.join(">")}`;
      if (!out.has(key)) {
        out.set(key, {
          key,
          sub,
          path,
          label: path.length ? `${root.label} › ${path.join(" › ")}` : root.label,
          integer: node.leaf.def.k !== "f32",
        });
      }
    }
    if (node.array) return;
    for (const c of node.children ?? []) walk(c, [...path, c.label]);
  };
  walk(root, []);
}

/** The numeric fields found in a sample of the records (all of one type), in the order they appear. */
export function listBulkFields(records: EspRecord[], localized: boolean, sample = 60): BulkField[] {
  const out = new Map<string, BulkField>();
  const ctx = ctxOf(localized);
  for (const r of records.slice(0, sample)) {
    const edid = getEditorId(r) ?? "";
    for (const s of getSubrecords(r)) collect(decodeSubrecord(r.type, s, edid, ctx), out, s.type);
  }
  return [...out.values()];
}

/** Whether every word is in the record's Editor ID or name (ignoring case). No words matches everything. */
export function matchesWords(r: EspRecord, words: string, localized: boolean): boolean {
  const terms = words.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = `${getEditorId(r) ?? ""} ${getDisplayName(r, localized) ?? ""}`.toLowerCase();
  return terms.every((t) => text.includes(t));
}

function compute(op: BulkOp, before: number, v: number): number {
  switch (op) {
    case "set": return v;
    case "add": return before + v;
    case "multiply": return before * v;
    case "percent": return before * (1 + v / 100);
  }
}

/** Every change the edit would make, without writing anything. Values that would not change are left out. */
export function planBulkEdit(records: EspRecord[], edit: BulkEdit, localized: boolean): BulkChange[] {
  const ctx = ctxOf(localized);
  const changes: BulkChange[] = [];
  for (const r of records) {
    const edid = getEditorId(r) ?? "";
    const name = getDisplayName(r, localized) ?? "";
    getSubrecords(r).forEach((s, subIndex) => {
      if (s.type !== edit.field.sub) return;
      const node = nodeAt(decodeSubrecord(r.type, s, edid, ctx), edit.field.path);
      if (!node?.leaf || !isPlainNumber(node.leaf)) return;
      const raw = readLeafValue(node.leaf.def, s.data, node.leaf, localized) as number;
      const div = node.leaf.def.k !== "f32" && "div" in node.leaf.def && node.leaf.def.div ? node.leaf.def.div : 1;
      const before = raw / div;
      let after = compute(edit.op, before, edit.value);
      after = edit.field.integer && div === 1 ? Math.round(after) : Number(after.toPrecision(7));
      if (after === before) return;
      let error: string | null = null;
      try {
        writeLeaf(s.data, node.leaf, String(after), localized); // checks the range; the result is thrown away
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      changes.push({ record: r, subIndex, leaf: node.leaf, before, after, error, edid, name });
    });
  }
  return changes;
}

/** Writes the changes that can be written. Returns how many records were changed. */
export function applyBulkChanges(changes: BulkChange[], localized: boolean): number {
  const touched = new Set<EspRecord>();
  for (const c of changes) {
    if (c.error) continue;
    const subs = getSubrecords(c.record);
    const s = subs[c.subIndex];
    if (!s) continue;
    markDirty(c.record);
    subs[c.subIndex] = { type: s.type, data: writeLeaf(s.data, c.leaf, String(c.after), localized) };
    touched.add(c.record);
  }
  return touched.size;
}
