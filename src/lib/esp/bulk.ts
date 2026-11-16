// Bulk edit: change fields in many records at once (halve every armor's weight, raise all weapon damage by 10%, turn a flag
// on for every iron item...), with a preview of every change before anything is written. Several fields can be changed in one
// run, numbers as well as choices and flags, values can go out to and come back from a CSV file, and a set of edits can be
// saved as a preset. UI-free so it stays testable.
import { decodeSubrecord, flagList, readLeafValue, writeLeaf, type DecodeContext, type FieldNode, type Leaf } from "./decode";
import { getDisplayName, getEditorId, getSubrecords, hex8, markDirty, type EspRecord } from "./format";

/** What a field holds: a plain number, one choice out of a list (an enum), or a set of flags (bits). */
export type BulkKind = "number" | "choice" | "flags";

/** A field that records of one type have: a subrecord plus the path to a value inside it. */
export interface BulkField {
  /** Stable identity: subrecord signature and the names leading to the value. */
  key: string;
  /** What the person sees, e.g. "DATA - Data › Weight". */
  label: string;
  sub: string;
  path: string[];
  integer: boolean;
  kind: BulkKind;
  /** The choices (kind "choice") or the flag names by bit value (kind "flags"). */
  options?: Record<number, string>;
}

export type BulkOp = "set" | "add" | "multiply" | "percent" | "choose" | "setFlags" | "clearFlags";

export const BULK_OP_LABELS: Record<BulkOp, string> = {
  set: "Set to",
  add: "Add",
  multiply: "Multiply by",
  percent: "Change by %",
  choose: "Set to",
  setFlags: "Turn on",
  clearFlags: "Turn off",
};

/** The changes that make sense for each kind of field. */
export const BULK_OPS_FOR: Record<BulkKind, BulkOp[]> = {
  number: ["set", "add", "multiply", "percent"],
  choice: ["choose"],
  flags: ["setFlags", "clearFlags"],
};

export interface BulkEdit {
  field: BulkField;
  op: BulkOp;
  value: number;
}

export interface BulkChange {
  record: EspRecord;
  field: BulkField;
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

const INT_KINDS = new Set(["u8", "u16", "u32", "i8", "i16", "i32"]);

/** Which kind of bulk field a leaf is, or null if it cannot be changed in bulk (text, FormIDs, hex data...). */
function leafKind(leaf: Leaf | undefined): BulkKind | null {
  if (!leaf) return null;
  if (isPlainNumber(leaf)) return "number";
  const d = leaf.def;
  if (!INT_KINDS.has(d.k)) return null;
  if ("enum" in d && d.enum) return "choice";
  if ("flags" in d && d.flags) return "flags";
  return null;
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
    const kind = leafKind(node.leaf);
    if (node.leaf && kind) {
      const key = `${sub}|${path.join(">")}`;
      if (!out.has(key)) {
        const d = node.leaf.def;
        const options = kind === "choice" && "enum" in d ? d.enum : kind === "flags" && "flags" in d ? d.flags : undefined;
        out.set(key, {
          key,
          sub,
          path,
          label: path.length ? `${root.label} › ${path.join(" › ")}` : root.label,
          integer: node.leaf.def.k !== "f32",
          kind,
          ...(options ? { options } : {}),
        });
      }
    }
    if (node.array) return;
    for (const c of node.children ?? []) walk(c, [...path, c.label]);
  };
  walk(root, []);
}

/** The fields found in a sample of the records (all of one type), in the order they appear. */
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

/** Bit operations on the 32 bits of a value, returned in the range of the field's own integer type. */
function bits(before: number, mask: number, set: boolean, signed: boolean): number {
  const r = set ? ((before | mask) >>> 0) : ((before & ~mask) >>> 0);
  return signed && r > 0x7fffffff ? r - 0x100000000 : r;
}

function compute(op: BulkOp, before: number, v: number, signed = false): number {
  switch (op) {
    case "set":
    case "choose":
      return v;
    case "add": return before + v;
    case "multiply": return before * v;
    case "percent": return before * (1 + v / 100);
    case "setFlags": return bits(before, v, true, signed);
    case "clearFlags": return bits(before, v, false, signed);
  }
}

/** Why an edit cannot be run as it is, or null. */
export function bulkEditProblem(edit: BulkEdit): string | null {
  if (!Number.isFinite(edit.value)) return "Enter a number.";
  if (!BULK_OPS_FOR[edit.field.kind].includes(edit.op) && !(edit.op === "set" && edit.field.kind !== "number")) {
    return `"${BULK_OP_LABELS[edit.op]}" does not apply to ${edit.field.label}.`;
  }
  if (edit.field.kind === "choice" && !(edit.field.options && edit.value in edit.field.options)) return "Choose one of the listed values.";
  if (edit.field.kind === "flags" && edit.op !== "set" && (!Number.isInteger(edit.value) || edit.value <= 0)) return "Choose at least one flag.";
  return null;
}

/** Plans one edit for one record. */
function planFor(r: EspRecord, edit: BulkEdit, localized: boolean, out: BulkChange[]): void {
  const ctx = ctxOf(localized);
  const edid = getEditorId(r) ?? "";
  const name = getDisplayName(r, localized) ?? "";
  getSubrecords(r).forEach((s, subIndex) => {
    if (s.type !== edit.field.sub) return;
    const node = nodeAt(decodeSubrecord(r.type, s, edid, ctx), edit.field.path);
    if (!node?.leaf || leafKind(node.leaf) !== edit.field.kind) return;
    const raw = readLeafValue(node.leaf.def, s.data, node.leaf, localized) as number;
    const div = node.leaf.def.k !== "f32" && "div" in node.leaf.def && node.leaf.def.div ? node.leaf.def.div : 1;
    const before = raw / div;
    let after = compute(edit.op, before, edit.value, node.leaf.def.k.startsWith("i"));
    if (edit.field.kind === "number") after = edit.field.integer && div === 1 ? Math.round(after) : Number(after.toPrecision(7));
    if (after === before) return;
    let error: string | null = null;
    try {
      writeLeaf(s.data, node.leaf, String(after), localized); // checks the range; the result is thrown away
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    out.push({ record: r, field: edit.field, subIndex, leaf: node.leaf, before, after, error, edid, name });
  });
}

/** Every change the edit would make, without writing anything. Values that would not change are left out. */
export function planBulkEdit(records: EspRecord[], edit: BulkEdit, localized: boolean): BulkChange[] {
  const changes: BulkChange[] = [];
  for (const r of records) planFor(r, edit, localized, changes);
  return changes;
}

/**
 * Several edits in one run. Each field may appear once: two edits to one field would both start from the old value, and
 * the second would silently win.
 */
export function planBulkEdits(records: EspRecord[], edits: BulkEdit[], localized: boolean): BulkChange[] {
  const seen = new Set<string>();
  for (const e of edits) {
    if (seen.has(e.field.key)) throw new Error(`${e.field.label} is changed twice. Use one change per field.`);
    seen.add(e.field.key);
  }
  return edits.flatMap((e) => planBulkEdit(records, e, localized));
}

/** A value of a field as text: the choice's name, the flags that are on, or the number. */
export function formatBulkValue(field: BulkField, n: number): string {
  if (field.kind === "choice") return field.options?.[n] ?? `<Unknown: ${n}>`;
  if (field.kind === "flags") return flagList(n >>> 0, field.options ?? {}).join(", ") || "(none)";
  return String(Number(n.toFixed(4)));
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

// ---------- CSV ----------

/** Splits CSV text into rows of cells: quotes, doubled quotes, commas and line breaks inside quotes, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The current value of a field in a record, or null if the record does not have it. */
function readField(r: EspRecord, field: BulkField, localized: boolean): number | null {
  const ctx = ctxOf(localized);
  const edid = getEditorId(r) ?? "";
  for (const s of getSubrecords(r)) {
    if (s.type !== field.sub) continue;
    const node = nodeAt(decodeSubrecord(r.type, s, edid, ctx), field.path);
    if (!node?.leaf || leafKind(node.leaf) !== field.kind) return null;
    const raw = readLeafValue(node.leaf.def, s.data, node.leaf, localized) as number;
    const div = node.leaf.def.k !== "f32" && "div" in node.leaf.def && node.leaf.def.div ? node.leaf.def.div : 1;
    return raw / div;
  }
  return null;
}

/**
 * The records and their values for these fields as CSV: FormID, Type, Editor ID and Name, then one column per field headed by
 * its key. Choices and flags are written as the number the game stores. Edit the numbers elsewhere and bring them back with
 * {@link planCsvImport}.
 */
export function exportBulkCsv(records: EspRecord[], fields: BulkField[], localized: boolean): string {
  const lines = [["FormID", "Type", "Editor ID", "Name", ...fields.map((f) => f.key)].map(csvCell).join(",")];
  for (const r of records) {
    const cells = [hex8(r.formId), r.type, getEditorId(r) ?? "", getDisplayName(r, localized) ?? ""];
    for (const f of fields) {
      const v = readField(r, f, localized);
      cells.push(v === null ? "" : String(Number(v.toPrecision(9))));
    }
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export interface CsvImportPlan {
  changes: BulkChange[];
  /** Things that were skipped or could not be understood, for the person to read. */
  problems: string[];
  rows: number;
  /** Rows that were matched to a record. */
  matched: number;
}

const MAX_PROBLEMS = 40;

/**
 * Turns a CSV (as made by {@link exportBulkCsv}) into changes. Rows are matched to records by FormID, or by Editor ID if
 * there is no FormID column. Cells that are empty or equal to the current value change nothing.
 */
export function planCsvImport(records: EspRecord[], text: string, fields: BulkField[], localized: boolean): CsvImportPlan {
  const plan: CsvImportPlan = { changes: [], problems: [], rows: 0, matched: 0 };
  const problem = (m: string) => {
    if (plan.problems.length < MAX_PROBLEMS) plan.problems.push(m);
  };
  const rows = parseCsv(text);
  const head = rows[0];
  if (!head) {
    problem("The file is empty.");
    return plan;
  }
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = col("formid");
  const edidCol = col("editor id");
  if (idCol < 0 && edidCol < 0) {
    problem('The first row needs a "FormID" or an "Editor ID" column.');
    return plan;
  }
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const byLabel = new Map(fields.map((f) => [f.label.toLowerCase(), f]));
  const columns: { index: number; field: BulkField }[] = [];
  head.forEach((h, index) => {
    if (index === idCol || index === edidCol || ["type", "name", ""].includes(h.trim().toLowerCase())) return;
    const f = byKey.get(h.trim()) ?? byLabel.get(h.trim().toLowerCase());
    if (f) columns.push({ index, field: f });
    else problem(`Column "${h.trim()}" is not a field of these records and was ignored.`);
  });
  if (columns.length === 0) problem("No column matches a field of these records.");

  const byId = new Map(records.map((r) => [r.formId >>> 0, r]));
  const byEdid = new Map<string, EspRecord>();
  for (const r of records) {
    const e = getEditorId(r);
    if (e) byEdid.set(e.toLowerCase(), r);
  }
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    plan.rows++;
    let record: EspRecord | undefined;
    const idText = idCol >= 0 ? (row[idCol] ?? "").trim().replace(/^0x/i, "") : "";
    if (idText) {
      if (/^[0-9a-f]{1,8}$/i.test(idText)) record = byId.get(parseInt(idText, 16) >>> 0);
      else {
        problem(`Row ${i + 1}: "${idText}" is not a FormID.`);
        continue;
      }
    } else if (edidCol >= 0) record = byEdid.get((row[edidCol] ?? "").trim().toLowerCase());
    if (!record) {
      problem(`Row ${i + 1}: no ${idText ? `record ${idText}` : "matching record"} among the records chosen.`);
      continue;
    }
    plan.matched++;
    for (const { index, field } of columns) {
      const cell = (row[index] ?? "").trim();
      if (cell === "") continue;
      const value = Number(cell);
      if (!Number.isFinite(value)) {
        problem(`Row ${i + 1}: "${cell}" is not a number (${field.label}).`);
        continue;
      }
      planFor(record, { field, op: field.kind === "choice" ? "choose" : "set", value }, localized, plan.changes);
    }
  }
  return plan;
}

// ---------- presets ----------

export interface BulkPresetEdit {
  fieldKey: string;
  op: BulkOp;
  value: number;
}

/** A saved set of edits for one record type, with the words that narrow the records down. */
export interface BulkPreset {
  name: string;
  type: string;
  words: string;
  edits: BulkPresetEdit[];
}

const PRESET_KEY = "esp-editor-bulk-presets";

export function loadPresets(): BulkPreset[] {
  try {
    const list = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]") as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((p): p is BulkPreset => !!p && typeof p.name === "string" && typeof p.type === "string" && Array.isArray(p.edits));
  } catch {
    return [];
  }
}

function storePresets(list: BulkPreset[]): boolean {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Saves a preset, replacing one with the same name and type. Returns false if storage is unavailable. */
export function savePreset(preset: BulkPreset): boolean {
  const rest = loadPresets().filter((p) => !(p.name === preset.name && p.type === preset.type));
  return storePresets([preset, ...rest].slice(0, 50));
}

export function deletePreset(name: string, type: string): boolean {
  return storePresets(loadPresets().filter((p) => !(p.name === name && p.type === type)));
}

export const presetFromEdits = (name: string, type: string, words: string, edits: BulkEdit[]): BulkPreset => ({
  name,
  type,
  words,
  edits: edits.map((e) => ({ fieldKey: e.field.key, op: e.op, value: e.value })),
});

/** The edits of a preset for fields that exist in these records now; the names of the ones that do not are returned too. */
export function presetEdits(preset: BulkPreset, fields: BulkField[]): { edits: BulkEdit[]; missing: string[] } {
  const edits: BulkEdit[] = [];
  const missing: string[] = [];
  for (const p of preset.edits) {
    const field = fields.find((f) => f.key === p.fieldKey);
    if (field) edits.push({ field, op: p.op, value: p.value });
    else missing.push(p.fieldKey);
  }
  return { edits, missing };
}
