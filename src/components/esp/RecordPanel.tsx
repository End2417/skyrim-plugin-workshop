import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  RECORD_FLAG_NAMES,
  decodeText,
  deleteRecord,
  encodeText,
  encodeZString,
  fromHex,
  getSubrecords,
  hex8,
  looksLikeZString,
  markDirty,
  toHex,
  zstringValue,
  type EspFile,
  type EspRecord,
  type Subrecord,
} from "@/lib/esp/format";

interface Props {
  file: EspFile;
  record: EspRecord;
  onChange: () => void;
  onDeleted: () => void;
}

export function RecordPanel({ file, record, onChange, onDeleted }: Props) {
  let subs: Subrecord[] = [];
  let loadError: string | null = null;
  try {
    subs = getSubrecords(record);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  const [editing, setEditing] = useState<number | "new" | null>(null);

  const mutate = (fn: () => void) => {
    markDirty(record);
    fn();
    onChange();
  };

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <HeaderForm record={record} disabled={!!loadError} onSave={(apply) => mutate(apply)} />

      {loadError ? (
        <p className="rounded-md border border-destructive bg-destructive/15 p-3 text-sm">
          Couldn't read this record's fields: {loadError}
        </p>
      ) : (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Fields ({subs.length})</h3>
            <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
              <Plus /> Add field
            </Button>
          </div>
          <div className="divide-y rounded-md border">
            {editing === "new" && (
              <SubrecordEditor
                initial={{ type: "EDID", data: new Uint8Array([0]) }}
                onCancel={() => setEditing(null)}
                onSave={(s) => {
                  mutate(() => subs.push(s));
                  setEditing(null);
                }}
              />
            )}
            {subs.map((s, i) =>
              editing === i ? (
                <SubrecordEditor
                  key={i}
                  initial={s}
                  onCancel={() => setEditing(null)}
                  onSave={(n) => {
                    mutate(() => (subs[i] = n));
                    setEditing(null);
                  }}
                />
              ) : (
                <div key={i} className="flex items-start gap-3 px-3 py-2">
                  <span className="w-12 shrink-0 font-mono text-sm text-primary">{s.type}</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-mono text-xs">{preview(s.data)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{s.data.length} bytes</p>
                  </div>
                  <div className="flex shrink-0">
                    <IconBtn label="Edit" onClick={() => setEditing(i)}>
                      <Pencil />
                    </IconBtn>
                    <IconBtn
                      label="Move up"
                      disabled={i === 0}
                      onClick={() => mutate(() => ([subs[i - 1], subs[i]] = [subs[i], subs[i - 1]]))}
                    >
                      <ArrowUp />
                    </IconBtn>
                    <IconBtn
                      label="Move down"
                      disabled={i === subs.length - 1}
                      onClick={() => mutate(() => ([subs[i + 1], subs[i]] = [subs[i], subs[i + 1]]))}
                    >
                      <ArrowDown />
                    </IconBtn>
                    <IconBtn
                      label="Delete field"
                      onClick={() => {
                        if (confirm(`Delete the ${s.type} field?`)) mutate(() => subs.splice(i, 1));
                      }}
                    >
                      <Trash2 />
                    </IconBtn>
                  </div>
                </div>
              ),
            )}
          </div>
        </section>
      )}

      {record.type !== "TES4" && (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            if (confirm(`Delete this ${record.type} record?`)) {
              deleteRecord(file, record);
              onDeleted();
            }
          }}
        >
          <Trash2 /> Delete record
        </Button>
      )}
    </div>
  );
}

function IconBtn(props: React.ComponentProps<typeof Button> & { label: string }) {
  const { label, ...rest } = props;
  return <Button variant="ghost" size="icon" aria-label={label} title={label} {...rest} />;
}

function preview(d: Uint8Array): string {
  if (looksLikeZString(d)) return `"${zstringValue(d)}"`;
  if (d.length === 4) {
    const dv = new DataView(d.buffer, d.byteOffset, 4);
    const f = dv.getFloat32(0, true);
    return `${hex8(dv.getUint32(0, true))}  ·  int ${dv.getInt32(0, true)}  ·  float ${Number.isFinite(f) ? +f.toPrecision(7) : f}`;
  }
  if (d.length === 2) return `${toHex(d)}  ·  ${new DataView(d.buffer, d.byteOffset, 2).getUint16(0, true)}`;
  if (d.length === 0) return "(empty)";
  const shown = toHex(d.subarray(0, 48));
  return d.length > 48 ? `${shown} …` : shown;
}

function HeaderForm({
  record,
  disabled,
  onSave,
}: {
  record: EspRecord;
  disabled: boolean;
  onSave: (apply: () => void) => void;
}) {
  const [formId, setFormId] = useState(hex8(record.formId));
  const [flags, setFlags] = useState(hex8(record.flags));
  const [err, setErr] = useState<string | null>(null);
  const parse = (s: string) => (/^(0x)?[0-9a-f]{1,8}$/i.test(s.trim()) ? parseInt(s.trim().replace(/^0x/i, ""), 16) : null);
  const f = parse(flags);
  const flagNames = f === null ? [] : Object.entries(RECORD_FLAG_NAMES).filter(([bit]) => f & Number(bit)).map(([, n]) => n);
  const changed = formId !== hex8(record.formId) || flags !== hex8(record.flags);

  return (
    <section>
      <div className="flex items-baseline gap-3">
        <h2 className="font-display text-2xl text-primary">{record.type}</h2>
        {record.dirty && <span className="text-xs text-modified">edited</span>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-md">
        <label className="text-xs text-muted-foreground">
          Form ID
          <Input value={formId} onChange={(e) => setFormId(e.target.value)} className="mt-1 font-mono" />
        </label>
        <label className="text-xs text-muted-foreground">
          Flags
          <Input value={flags} onChange={(e) => setFlags(e.target.value)} className="mt-1 font-mono" />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {flagNames.length ? flagNames.join(", ") : "No known flags set"} · version {record.version}
      </p>
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      {changed && (
        <Button
          size="sm"
          className="mt-3"
          disabled={disabled}
          onClick={() => {
            const id = parse(formId);
            const fl = parse(flags);
            if (id === null || fl === null) return setErr("Form ID and flags must be hex, up to 8 digits.");
            setErr(null);
            onSave(() => {
              record.formId = id;
              record.flags = fl;
            });
            setFormId(hex8(id));
            setFlags(hex8(fl));
          }}
        >
          Apply header changes
        </Button>
      )}
    </section>
  );
}

type Mode = "text" | "rawtext" | "hex" | "uint32" | "int32" | "float";

function encode(mode: Mode, value: string): Uint8Array {
  switch (mode) {
    case "text":
      return encodeZString(value);
    case "rawtext":
      return encodeText(value);
    case "hex":
      return fromHex(value);
    default: {
      const out = new Uint8Array(4);
      const dv = new DataView(out.buffer);
      const v = value.trim();
      if (mode === "float") {
        const n = Number(v);
        if (v === "" || Number.isNaN(n)) throw new Error("Enter a number");
        dv.setFloat32(0, n, true);
      } else {
        const n = /^0x/i.test(v) ? parseInt(v, 16) : Number(v);
        if (v === "" || !Number.isInteger(n)) throw new Error("Enter a whole number (or 0x… hex)");
        if (mode === "uint32") {
          if (n < 0 || n > 0xffffffff) throw new Error("Out of range for uint32");
          dv.setUint32(0, n, true);
        } else {
          if (n < -0x80000000 || n > 0x7fffffff) throw new Error("Out of range for int32");
          dv.setInt32(0, n, true);
        }
      }
      return out;
    }
  }
}

function decode(mode: Mode, d: Uint8Array): string {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  switch (mode) {
    case "text":
      return zstringValue(d);
    case "rawtext":
      return decodeText(d);
    case "hex":
      return toHex(d);
    case "uint32":
      return d.length === 4 ? String(dv.getUint32(0, true)) : "0";
    case "int32":
      return d.length === 4 ? String(dv.getInt32(0, true)) : "0";
    case "float":
      return d.length === 4 ? String(+dv.getFloat32(0, true).toPrecision(7)) : "0";
  }
}

function SubrecordEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Subrecord;
  onSave: (s: Subrecord) => void;
  onCancel: () => void;
}) {
  const startMode: Mode = looksLikeZString(initial.data) || (initial.data.length === 1 && initial.data[0] === 0) ? "text" : "hex";
  const [type, setType] = useState(initial.type);
  const [mode, setMode] = useState<Mode>(startMode);
  const [value, setValue] = useState(decode(startMode, initial.data));
  const [err, setErr] = useState<string | null>(null);

  const switchMode = (m: Mode) => {
    try {
      const bytes = encode(mode, value);
      setValue(decode(m, bytes));
      setErr(null);
    } catch {
      setValue(decode(m, initial.data));
    }
    setMode(m);
  };

  return (
    <div className="space-y-3 bg-muted p-3">
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-muted-foreground">
          Field
          <Input
            value={type}
            maxLength={4}
            onChange={(e) => setType(e.target.value.toUpperCase())}
            className="mt-1 w-24 font-mono"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Edit as
          <select
            value={mode}
            onChange={(e) => switchMode(e.target.value as Mode)}
            className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="text">Text</option>
            <option value="rawtext">Text (no terminator)</option>
            <option value="hex">Hex bytes</option>
            <option value="uint32">Unsigned int (4 bytes)</option>
            <option value="int32">Signed int (4 bytes)</option>
            <option value="float">Float (4 bytes)</option>
          </select>
        </label>
      </div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={mode === "hex" ? 6 : 3}
        className="font-mono text-sm"
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            if (!/^[\x20-\x7E]{4}$/.test(type)) return setErr("Field name must be exactly 4 characters.");
            try {
              onSave({ type, data: encode(mode, value) });
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save field
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
