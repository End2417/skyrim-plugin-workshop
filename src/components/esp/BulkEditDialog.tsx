import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { applyBulkChanges, BULK_OP_LABELS, listBulkFields, matchesWords, planBulkEdit, type BulkChange, type BulkOp } from "@/lib/esp/bulk";
import { RECORD_DEFS, SIGNATURE_NAMES } from "@/lib/esp/defs";
import { walkRecords, type EspFile, type EspRecord } from "@/lib/esp/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
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

function BulkForm({ file, localized, onApplied, onOpenChange }: Props) {
  // Record types in this plugin that the editor knows the fields of
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

  const [type, setType] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [op, setOp] = useState<BulkOp>("multiply");
  const [valueText, setValueText] = useState("");
  const [words, setWords] = useState("");
  const [plan, setPlan] = useState<BulkChange[] | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const records = useMemo(() => (type ? (byType.get(type) ?? []) : []), [type, byType]);
  const fields = useMemo(() => listBulkFields(records, localized), [records, localized]);
  const field = fields.find((f) => f.key === fieldKey) ?? null;

  function reset() {
    setPlan(null);
    setExcluded(new Set());
    setError(null);
    setDone(null);
  }

  function preview() {
    reset();
    if (!field) return setError("Choose a record type and a field.");
    const value = Number(valueText);
    if (valueText.trim() === "" || Number.isNaN(value)) return setError("Enter a number.");
    const chosen = records.filter((r) => matchesWords(r, words, localized));
    if (chosen.length === 0) return setError("No records match those words.");
    const result = planBulkEdit(chosen, { field, op, value }, localized);
    if (result.length === 0) return setError(`None of the ${chosen.length.toLocaleString()} matching records would change.`);
    setPlan(result);
  }

  const toApply = plan ? plan.filter((c, i) => !c.error && !excluded.has(i)) : [];
  const unwritable = plan ? plan.filter((c) => c.error).length : 0;

  function apply() {
    if (!plan) return;
    const n = applyBulkChanges(toApply, localized);
    onApplied(n);
    setPlan(null);
    setDone(`Changed ${n.toLocaleString()} record${n === 1 ? "" : "s"}. Review them with the checklist button, and revert any you do not want there.`);
  }

  const fmt = (n: number) => String(Number(n.toFixed(4)));

  return (
    <>
      <DialogHeader>
        <DialogTitle>Bulk edit</DialogTitle>
        <DialogDescription>Change one number in many records at once. You see every change before anything is written.</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        <label className="block space-y-1">
          <span className="font-medium">Records</span>
          <select
            className={selectClass}
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setFieldKey("");
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

        {type && (
          <label className="block space-y-1">
            <span className="font-medium">Field</span>
            <select
              className={selectClass}
              value={fieldKey}
              onChange={(e) => {
                setFieldKey(e.target.value);
                reset();
              }}
            >
              <option value="">Choose a field…</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            {fields.length === 0 && <span className="block text-xs text-muted-foreground">This type has no plain number fields the editor knows.</span>}
          </label>
        )}

        {field && (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
              <label className="block space-y-1">
                <span className="font-medium">Change</span>
                <select
                  className={selectClass}
                  value={op}
                  onChange={(e) => {
                    setOp(e.target.value as BulkOp);
                    reset();
                  }}
                >
                  {(Object.keys(BULK_OP_LABELS) as BulkOp[]).map((o) => (
                    <option key={o} value={o}>
                      {BULK_OP_LABELS[o]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Number</span>
                <Input
                  inputMode="decimal"
                  autoCorrect="off"
                  value={valueText}
                  onChange={(e) => {
                    setValueText(e.target.value);
                    reset();
                  }}
                  placeholder={op === "multiply" ? "0.5" : op === "percent" ? "10" : "1"}
                  className="h-9"
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {op === "multiply" && "0.5 halves it, 2 doubles it."}
              {op === "percent" && "10 raises it by 10%, -50 halves it."}
              {op === "add" && "A negative number subtracts."}
              {op === "set" && "Every matching record gets this value."}
            </p>
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
            <Button onClick={preview}>
              <SlidersHorizontal /> Preview changes
            </Button>
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
                  <span className="block text-muted-foreground">
                    {fmt(c.before)} → {c.error ? <span className="text-destructive">{fmt(c.after)} ({c.error})</span> : fmt(c.after)}
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

      {!plan && done && (
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      )}
    </>
  );
}
