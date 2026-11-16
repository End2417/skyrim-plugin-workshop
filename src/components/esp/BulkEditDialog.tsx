import { useMemo, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  applyBulkChanges,
  BULK_OP_LABELS,
  BULK_OPS_FOR,
  bulkEditProblem,
  deletePreset,
  exportBulkCsv,
  formatBulkValue,
  listBulkFields,
  loadPresets,
  matchesWords,
  planBulkEdits,
  planCsvImport,
  presetEdits,
  presetFromEdits,
  savePreset,
  type BulkChange,
  type BulkEdit,
  type BulkField,
  type BulkOp,
  type BulkPreset,
} from "@/lib/esp/bulk";
import { RECORD_DEFS, SIGNATURE_NAMES } from "@/lib/esp/defs";
import { downloadPlugin } from "@/lib/esp/download";
import { walkRecords, type EspFile, type EspRecord } from "@/lib/esp/format";
import type { History } from "@/lib/esp/history";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  history: History;
  localized: boolean;
  /** Called after changes were written, so the editor can refresh and remember there is something to save. */
  onApplied: (records: number) => void;
}

const SHOWN = 200;
const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function BulkEditDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so it starts fresh and sees the records as they are now. */}
        <BulkForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** One change the person is setting up: which field, what to do, and with what. */
interface Row {
  id: number;
  fieldKey: string;
  op: BulkOp;
  valueText: string;
  choice: string;
  bits: number[];
}

const newRow = (id: number): Row => ({ id, fieldKey: "", op: "multiply", valueText: "", choice: "", bits: [] });

function BulkForm({ file, history, localized, onApplied, onOpenChange }: Props) {
  const byType = useMemo(() => {
    const map = new Map<string, EspRecord[]>();
    for (const r of walkRecords(file.nodes)) {
      if (r.type === "TES4" || !RECORD_DEFS[r.type]) continue;
      const list = map.get(r.type);
      if (list) list.push(r);
      else map.set(r.type, [r]);
    }
    return map;
  }, [file]);
  const types = useMemo(() => [...byType.keys()].sort((a, b) => (SIGNATURE_NAMES[a] ?? a).localeCompare(SIGNATURE_NAMES[b] ?? b)), [byType]);

  const nextId = useRef(1);
  const csvInput = useRef<HTMLInputElement>(null);
  const [type, setType] = useState("");
  const [rows, setRows] = useState<Row[]>([newRow(0)]);
  const [words, setWords] = useState("");
  const [plan, setPlan] = useState<BulkChange[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [presets, setPresets] = useState<BulkPreset[]>(() => loadPresets());
  const [presetName, setPresetName] = useState("");

  const records = useMemo(() => (type ? (byType.get(type) ?? []) : []), [type, byType]);
  const fields = useMemo(() => listBulkFields(records, localized), [records, localized]);
  const fieldOf = (key: string): BulkField | null => fields.find((f) => f.key === key) ?? null;

  function reset() {
    setPlan(null);
    setNotes([]);
    setExcluded(new Set());
    setError(null);
    setDone(null);
  }
  const update = (id: number, patch: Partial<Row>) => {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    reset();
  };

  /** The edits the rows describe, or the first thing wrong with them. */
  function edits(): BulkEdit[] | string {
    const out: BulkEdit[] = [];
    for (const [i, row] of rows.entries()) {
      const field = fieldOf(row.fieldKey);
      if (!field) return `Change ${i + 1}: choose a field.`;
      let value: number;
      let op = row.op;
      if (field.kind === "number") {
        value = Number(row.valueText);
        if (row.valueText.trim() === "" || Number.isNaN(value)) return `Change ${i + 1}: enter a number.`;
        if (!BULK_OPS_FOR.number.includes(op)) op = "multiply";
      } else if (field.kind === "choice") {
        if (row.choice === "") return `Change ${i + 1}: choose a value.`;
        value = Number(row.choice);
        op = "choose";
      } else {
        value = row.bits.reduce((a, b) => a + b, 0);
        if (!BULK_OPS_FOR.flags.includes(op)) op = "setFlags";
      }
      const edit: BulkEdit = { field, op, value };
      const problem = bulkEditProblem(edit);
      if (problem) return `Change ${i + 1}: ${problem}`;
      out.push(edit);
    }
    return out;
  }

  function preview() {
    reset();
    if (!type) return setError("Choose a record type.");
    const e = edits();
    if (typeof e === "string") return setError(e);
    const chosen = records.filter((r) => matchesWords(r, words, localized));
    if (chosen.length === 0) return setError("No records match those words.");
    try {
      const result = planBulkEdits(chosen, e, localized);
      if (result.length === 0) return setError(`None of the ${chosen.length.toLocaleString()} matching records would change.`);
      setPlan(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const toApply = plan ? plan.filter((c, i) => !c.error && !excluded.has(i)) : [];
  const unwritable = plan ? plan.filter((c) => c.error).length : 0;

  function apply() {
    if (!plan) return;
    // One undo step for the whole run
    const n = history.batch("Bulk edit", () => applyBulkChanges(toApply, localized));
    onApplied(n);
    setPlan(null);
    setNotes([]);
    setDone(`Changed ${n.toLocaleString()} record${n === 1 ? "" : "s"}. You can undo this with the undo button, or review them with the checklist button.`);
  }

  // ----- CSV -----
  async function exportCsv() {
    reset();
    if (!type) return setError("Choose a record type.");
    const chosenFields = rows.map((r) => fieldOf(r.fieldKey)).filter((f): f is BulkField => f !== null);
    const columns = chosenFields.length > 0 ? chosenFields : fields;
    if (columns.length === 0) return setError("This type has no fields the editor can export.");
    const chosen = records.filter((r) => matchesWords(r, words, localized));
    const csv = exportBulkCsv(chosen, columns, localized);
    try {
      const where = await downloadPlugin(new TextEncoder().encode(csv), `${type}-bulk-edit.csv`);
      setDone(`Exported ${chosen.length.toLocaleString()} record${chosen.length === 1 ? "" : "s"}${where ? ` to ${where}` : ""}. Change the numbers, then bring the file back with Import CSV.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function importCsv(f: File) {
    reset();
    if (!type) return setError("Choose a record type first, then import a CSV made for it.");
    try {
      const result = planCsvImport(records, await f.text(), fields, localized);
      setNotes([...(result.matched ? [`${result.matched.toLocaleString()} of ${result.rows.toLocaleString()} rows matched a record.`] : []), ...result.problems]);
      if (result.changes.length === 0) return setError(result.problems[0] ?? "Nothing in the file would change a record.");
      setPlan(result.changes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ----- presets -----
  const typePresets = presets.filter((p) => p.type === type);

  function rowsFromPreset(p: BulkPreset) {
    const { edits: es, missing } = presetEdits(p, fields);
    setRows(
      es.map((e) => ({
        id: nextId.current++,
        fieldKey: e.field.key,
        op: e.op,
        valueText: e.field.kind === "number" ? String(e.value) : "",
        choice: e.field.kind === "choice" ? String(e.value) : "",
        bits: e.field.kind === "flags" ? Object.keys(e.field.options ?? {}).map(Number).filter((b) => (e.value & b) !== 0) : [],
      })),
    );
    if (es.length === 0) setRows([newRow(nextId.current++)]);
    setWords(p.words);
    reset();
    if (missing.length) setError(`Not found in these records, so left out: ${missing.join(", ")}.`);
  }

  function saveCurrent() {
    const name = presetName.trim();
    if (!type || !name) return setError("Choose a type and give the preset a name.");
    const e = edits();
    if (typeof e === "string") return setError(e);
    if (!savePreset(presetFromEdits(name, type, words, e))) return setError("The preset could not be stored on this device.");
    setPresets(loadPresets());
    setDone(`Saved preset "${name}".`);
    setError(null);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Bulk edit</DialogTitle>
        <DialogDescription>Change fields in many records at once. You see every change before anything is written, and it is one undo step.</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        <label className="block space-y-1">
          <span className="font-medium">Records</span>
          <select
            className={selectClass}
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setRows([newRow(nextId.current++)]);
              reset();
            }}
          >
            <option value="">Choose a type…</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {SIGNATURE_NAMES[t] ?? t} ({byType.get(t)!.length.toLocaleString()})
              </option>
            ))}
          </select>
        </label>

        {type && typePresets.length > 0 && (
          <div className="space-y-1">
            <span className="font-medium">Saved presets</span>
            <ul className="divide-y rounded-md border">
              {typePresets.map((p) => (
                <li key={`${p.type}:${p.name}`} className="flex items-center gap-2 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => rowsFromPreset(p)}>
                    Use
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-destructive"
                    onClick={() => {
                      deletePreset(p.name, p.type);
                      setPresets(loadPresets());
                    }}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {type &&
          rows.map((row, i) => {
            const field = fieldOf(row.fieldKey);
            return (
              <div key={row.id} className="space-y-2 rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Change {i + 1}</span>
                  {rows.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 px-2 text-destructive"
                      onClick={() => {
                        setRows((cur) => cur.filter((r) => r.id !== row.id));
                        reset();
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <select className={selectClass} value={row.fieldKey} onChange={(e) => update(row.id, { fieldKey: e.target.value, op: "multiply", valueText: "", choice: "", bits: [] })} aria-label={`Field for change ${i + 1}`}>
                  <option value="">Choose a field…</option>
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                      {f.kind === "choice" ? " (choice)" : f.kind === "flags" ? " (flags)" : ""}
                    </option>
                  ))}
                </select>
                {fields.length === 0 && <p className="text-xs text-muted-foreground">This type has no fields the editor can change in bulk.</p>}

                {field?.kind === "number" && (
                  <>
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                      <select className={selectClass} value={BULK_OPS_FOR.number.includes(row.op) ? row.op : "multiply"} onChange={(e) => update(row.id, { op: e.target.value as BulkOp })} aria-label="What to do">
                        {BULK_OPS_FOR.number.map((o) => (
                          <option key={o} value={o}>
                            {BULK_OP_LABELS[o]}
                          </option>
                        ))}
                      </select>
                      <Input
                        inputMode="decimal"
                        autoCorrect="off"
                        value={row.valueText}
                        onChange={(e) => update(row.id, { valueText: e.target.value })}
                        placeholder={row.op === "multiply" ? "0.5" : row.op === "percent" ? "10" : "1"}
                        className="h-9"
                        aria-label="Number"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {row.op === "multiply" && "0.5 halves it, 2 doubles it."}
                      {row.op === "percent" && "10 raises it by 10%, -50 halves it."}
                      {row.op === "add" && "A negative number subtracts."}
                      {row.op === "set" && "Every matching record gets this value."}
                    </p>
                  </>
                )}

                {field?.kind === "choice" && (
                  <select className={selectClass} value={row.choice} onChange={(e) => update(row.id, { choice: e.target.value })} aria-label="Value">
                    <option value="">Set it to…</option>
                    {Object.entries(field.options ?? {}).map(([v, name]) => (
                      <option key={v} value={v}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}

                {field?.kind === "flags" && (
                  <>
                    <select className={selectClass} value={BULK_OPS_FOR.flags.includes(row.op) ? row.op : "setFlags"} onChange={(e) => update(row.id, { op: e.target.value as BulkOp })} aria-label="Turn on or off">
                      {BULK_OPS_FOR.flags.map((o) => (
                        <option key={o} value={o}>
                          {BULK_OP_LABELS[o]}
                        </option>
                      ))}
                    </select>
                    <div className="grid gap-1">
                      {Object.entries(field.options ?? {}).map(([bit, name]) => {
                        const b = Number(bit);
                        return (
                          <label key={bit} className="flex items-center gap-2 text-xs">
                            <Checkbox checked={row.bits.includes(b)} onCheckedChange={(v) => update(row.id, { bits: v === true ? [...row.bits, b] : row.bits.filter((x) => x !== b) })} />
                            <span>{name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            );
          })}

        {type && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRows((cur) => [...cur, newRow(nextId.current++)]);
                reset();
              }}
            >
              Add another change
            </Button>
            <label className="block space-y-1">
              <span className="font-medium">Only records whose Editor ID or name has these words (optional)</span>
              <Input
                value={words}
                onChange={(e) => {
                  setWords(e.target.value);
                  reset();
                }}
                autoCorrect="off"
                spellCheck={false}
                placeholder="for example: iron"
                className="h-9"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={preview}>
                <SlidersHorizontal /> Preview changes
              </Button>
              <Button variant="secondary" onClick={() => void exportCsv()}>
                Export CSV
              </Button>
              <Button variant="secondary" onClick={() => csvInput.current?.click()}>
                Import CSV
              </Button>
              <input
                ref={csvInput}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void importCsv(f);
                }}
              />
            </div>
            <div className="flex gap-2">
              <Input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Name to save these changes as a preset" className="h-9" aria-label="Preset name" />
              <Button variant="secondary" size="sm" className="h-9" onClick={saveCurrent}>
                Save preset
              </Button>
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-muted-foreground">
            {done}
          </p>
        )}
        {notes.length > 0 && (
          <ul className="max-h-28 overflow-auto text-xs text-muted-foreground">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>

      {plan && (
        <div className="space-y-2 text-sm">
          <p className="font-medium">
            {toApply.length.toLocaleString()} of {plan.length.toLocaleString()} change{plan.length === 1 ? "" : "s"} selected
            {unwritable > 0 && ` · ${unwritable.toLocaleString()} cannot be written`}
          </p>
          <ul className="max-h-72 divide-y overflow-auto rounded-md border">
            {plan.slice(0, SHOWN).map((c, i) => (
              <li key={i} className="flex items-start gap-2 px-2 py-1.5">
                <Checkbox
                  className="mt-0.5"
                  checked={!c.error && !excluded.has(i)}
                  disabled={!!c.error}
                  aria-label={`Include ${c.edid || c.name}`}
                  onCheckedChange={(v) =>
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (v === true) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1 text-xs">
                  <span className="block break-words font-mono">{c.edid || "(no Editor ID)"}</span>
                  {c.name && <span className="block break-words text-muted-foreground">{c.name}</span>}
                  <span className="block text-muted-foreground">{c.field.label}</span>
                  <span className="block text-muted-foreground">
                    {formatBulkValue(c.field, c.before)} → {c.error ? <span className="text-destructive">{formatBulkValue(c.field, c.after)} ({c.error})</span> : formatBulkValue(c.field, c.after)}
                  </span>
                </span>
              </li>
            ))}
            {plan.length > SHOWN && <li className="px-2 py-2 text-xs text-muted-foreground">…and {(plan.length - SHOWN).toLocaleString()} more. They are all included.</li>}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button onClick={apply} disabled={toApply.length === 0}>
              Apply {toApply.length.toLocaleString()} change{toApply.length === 1 ? "" : "s"}
            </Button>
            <Button variant="secondary" onClick={() => setPlan(null)}>
              Back
            </Button>
          </div>
        </div>
      )}

      <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    </>
  );
}
