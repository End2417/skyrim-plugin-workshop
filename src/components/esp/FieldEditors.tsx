import { useContext, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { flagList, parseFormIdInput, readLeafValue, type Leaf } from "@/lib/esp/decode";
import {
  decodeText,
  encodeText,
  encodeZString,
  fromHex,
  hex8,
  looksLikeZString,
  toHex,
  zstringValue,
  type Subrecord,
} from "@/lib/esp/format";
import { RecordFinderContext } from "./recordPicker";

interface LeafEditorProps {
  leaf: Leaf;
  data: Uint8Array;
  localized: boolean;
  resolveFormId: (id: number) => string;
  onCommit: (value: string | number) => void;
  onCancel: () => void;
  error: string | null;
}

/** Inline editor for one value, shaped by its type (number, list, flags, reference, text). */
export function LeafEditor({ leaf, data, localized, resolveFormId, onCommit, onCancel, error }: LeafEditorProps) {
  const def = leaf.def;
  const current = readLeafValue(def, data, leaf, localized);

  if ("enum" in def && def.enum) {
    const n = current as number;
    const options = Object.entries(def.enum).map(([v, name]) => [Number(v), name] as const);
    if (!(n in def.enum)) options.unshift([n, `<Unknown: ${n}>`]);
    return (
      <div className="flex items-center gap-1">
        <select
          autoFocus
          defaultValue={n}
          onChange={(e) => onCommit(Number(e.target.value))}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          {options.map(([v, name]) => (
            <option key={v} value={v}>
              {name}
            </option>
          ))}
        </select>
        <CancelBtn onCancel={onCancel} />
      </div>
    );
  }

  if ("flags" in def && def.flags) return <FlagsEditor value={current as number} names={def.flags} onCommit={onCommit} onCancel={onCancel} />;

  return <TextLeafEditor {...{ leaf, current, localized, resolveFormId, onCommit, onCancel, error }} />;
}

function TextLeafEditor({
  leaf,
  current,
  localized,
  resolveFormId,
  onCommit,
  onCancel,
  error,
}: Omit<LeafEditorProps, "data"> & { current: number | string }) {
  const def = leaf.def;
  const isRef = def.k === "fid";
  const initial =
    isRef || (def.k === "lstr" && localized)
      ? hex8(current as number)
      : def.k === "f32"
        ? String(+(current as number).toPrecision(7))
        : "div" in def && def.div
          ? String((current as number) / def.div)
          : "hex" in def && def.hex
            ? `0x${(current as number).toString(16).toUpperCase()}`
            : String(current);
  const [value, setValue] = useState(initial);

  // Reference fields can also be filled by name: typing words lists the records in this plugin that match.
  const finder = useContext(RecordFinderContext);
  const [touched, setTouched] = useState(false);
  const [matches, setMatches] = useState<number[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const [listOpen, setListOpen] = useState(true);
  const typed = value.trim();
  const isFullId = /^(0x)?[0-9a-f]{8}$/i.test(typed);
  const looksLikeId = /^(0x)?[0-9a-f]{1,8}$/i.test(typed);

  useEffect(() => {
    if (!isRef || !finder || !touched || isFullId || typed.length < 2) {
      setMatches(null);
      setNotReady(false);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const t = setTimeout(() => {
      void finder(typed, 30, () => cancelled).then((res) => {
        if (cancelled) return;
        if (res === null) {
          // The search index is still being built in the background; try again shortly
          setNotReady(true);
          setMatches(null);
          retryTimer = setTimeout(() => setRetry((n) => n + 1), 700);
        } else {
          setNotReady(false);
          setMatches(res);
          setListOpen(true);
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearTimeout(retryTimer);
    };
  }, [isRef, finder, touched, isFullId, typed, retry]);

  const choose = (id: number) => {
    setValue(hex8(id));
    setMatches(null);
    setNotReady(false);
    setTouched(false);
  };

  let preview: string | null = null;
  if (isRef) {
    try {
      preview = resolveFormId(parseFormIdInput(value));
    } catch {
      preview = null;
    }
  }
  const long = def.k === "bytes" || ((def.k === "str" || def.k === "lstr") && String(current).length > 60);

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-1">
        {long ? (
          <Textarea
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onCancel()}
            rows={4}
            className="font-mono text-xs"
          />
        ) : (
          <Input
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Words rather than a FormID: Enter takes the best match instead of failing
                if (isRef && !looksLikeId && matches && matches.length > 0) choose(matches[0]!);
                else onCommit(value);
              }
              if (e.key === "Escape") onCancel();
            }}
            className="h-8 font-mono text-sm"
          />
        )}
        <Button size="icon" className="size-8 shrink-0" aria-label="Apply" onClick={() => onCommit(value)}>
          <Check />
        </Button>
        <CancelBtn onCancel={onCancel} />
      </div>
      {isRef && <p className="text-xs text-muted-foreground">{preview ?? "Type a name to search, or enter a FormID in hex"}</p>}
      {isRef && (matches !== null || notReady) && (
        <div className="rounded-md border bg-card">
          <button
            type="button"
            onClick={() => setListOpen((o) => !o)}
            aria-expanded={listOpen}
            className="flex w-full items-center justify-between px-2 py-1 text-xs text-muted-foreground"
          >
            <span>{notReady || !matches ? "Preparing search…" : `${matches.length}${matches.length >= 30 ? "+" : ""} match${matches.length === 1 ? "" : "es"}`}</span>
            {listOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
          {listOpen && matches && (
            <ul className="max-h-56 divide-y overflow-auto border-t">
              {matches.map((r) => (
                <li key={r}>
                  <button type="button" onClick={() => choose(r)} className="block w-full break-words px-2 py-1.5 text-left font-mono text-xs hover:bg-accent">
                    {resolveFormId(r)}
                  </button>
                </li>
              ))}
              {matches.length === 0 && (
                <li className="px-2 py-2 text-xs text-muted-foreground">Nothing matches in this plugin or the masters the app remembers. Masters are added in Check plugin; or type the FormID.</li>
              )}
            </ul>
          )}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function CancelBtn({ onCancel }: { onCancel: () => void }) {
  return (
    <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Cancel" onClick={onCancel}>
      <X />
    </Button>
  );
}

export function FlagsEditor({
  value,
  names,
  onCommit,
  onCancel,
}: {
  value: number;
  names: Record<number, string>;
  onCommit: (v: number) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(value >>> 0);
  const bits = Object.keys(names).map(Number);
  for (let b = 0; b < 32; b++) if (Math.floor(value / 2 ** b) % 2 === 1 && !names[2 ** b]) bits.push(2 ** b);
  bits.sort((a, b) => a - b);
  const has = (bit: number) => Math.floor(v / bit) % 2 === 1;
  return (
    <div className="space-y-2 rounded-md border bg-background p-2">
      {bits.map((bit) => (
        <label key={bit} className="flex items-center gap-2 text-sm">
          <Checkbox checked={has(bit)} onCheckedChange={(c) => setV(c ? v + (has(bit) ? 0 : bit) : v - (has(bit) ? bit : 0))} />
          {names[bit] || flagList(bit, {})[0]}
        </label>
      ))}
      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={() => onCommit(v)}>
          Apply
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------- raw subrecord editor (for unknown data or manual fixes) ----------

type Mode = "text" | "rawtext" | "hex";

const encodeRaw = (mode: Mode, value: string) =>
  mode === "text" ? encodeZString(value) : mode === "rawtext" ? encodeText(value) : fromHex(value);
const decodeRaw = (mode: Mode, d: Uint8Array) =>
  mode === "text" ? zstringValue(d) : mode === "rawtext" ? decodeText(d) : toHex(d);

export function RawFieldEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Subrecord;
  onSave: (s: Subrecord) => void;
  onCancel: () => void;
}) {
  const startMode: Mode = looksLikeZString(initial.data) ? "text" : "hex";
  const [type, setType] = useState(initial.type);
  const [mode, setMode] = useState<Mode>(startMode);
  const [value, setValue] = useState(decodeRaw(startMode, initial.data));
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="space-y-3 bg-muted p-3">
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-muted-foreground">
          Signature
          <Input value={type} maxLength={4} onChange={(e) => setType(e.target.value.toUpperCase())} className="mt-1 w-24 font-mono" />
        </label>
        <label className="text-xs text-muted-foreground">
          Edit as
          <select
            value={mode}
            onChange={(e) => {
              const m = e.target.value as Mode;
              try {
                setValue(decodeRaw(m, encodeRaw(mode, value)));
              } catch {
                setValue(decodeRaw(m, initial.data));
              }
              setMode(m);
            }}
            className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="text">Text</option>
            <option value="rawtext">Text (no terminator)</option>
            <option value="hex">Hex bytes</option>
          </select>
        </label>
      </div>
      <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={mode === "hex" ? 6 : 3} className="font-mono text-sm" />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            if (!/^[\x20-\x7E]{4}$/.test(type)) return setErr("Signature must be exactly 4 characters.");
            try {
              onSave({ type, data: encodeRaw(mode, value) });
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
