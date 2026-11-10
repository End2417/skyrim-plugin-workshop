import { Fragment, useState } from "react";
import { MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { findSubDef, knownSubSignatures, recordFlagNames, RECORD_DEFS, SIGNATURE_NAMES } from "@/lib/esp/defs";
import {
  addArrayEntry,
  decodeSubrecord,
  defaultData,
  flagList,
  removeArrayEntry,
  resolveSubDef,
  syncCounters,
  writeLeaf,
  type DecodeContext,
  type FieldNode,
} from "@/lib/esp/decode";
import {
  deleteRecord,
  getEditorId,
  getSubrecords,
  hex8,
  markDirty,
  toHex,
  type EspFile,
  type EspRecord,
  type Subrecord,
} from "@/lib/esp/format";
import { FlagsEditor, LeafEditor, RawFieldEditor } from "./FieldEditors";

interface Props {
  file: EspFile;
  record: EspRecord;
  ctx: DecodeContext;
  onChange: (opts?: { reindex?: boolean }) => void;
  onDeleted: () => void;
}

export function RecordView({ file, record, ctx, onChange, onDeleted }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [rawEditing, setRawEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSig, setNewSig] = useState("");

  let subs: Subrecord[] = [];
  let loadError: string | null = null;
  try {
    subs = getSubrecords(record);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  const edid = getEditorId(record) ?? "";

  const mutate = (fn: () => void, opts?: { reindex?: boolean }) => {
    markDirty(record);
    fn();
    syncCounters(subs);
    setEditing(null);
    setError(null);
    onChange(opts);
  };
  const tryMutate = (fn: () => void) => {
    try {
      mutate(fn);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const startEdit = (key: string) => {
    setEditing(key);
    setError(null);
  };

  const present = new Set(subs.map((s) => s.type));
  const missing = RECORD_DEFS[record.type] ? knownSubSignatures(record.type).filter((s) => !present.has(s) && findSubDef(record.type, s)) : [];

  const addField = (type: string) => {
    const def = findSubDef(record.type, type) ? resolveSubDef(record.type, { type, data: new Uint8Array(0) }, edid) : null;
    mutate(() => subs.push({ type, data: defaultData(def, ctx.localized) }));
  };

  const flagNames = recordFlagNames(record.type);

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h2 className="font-display text-xl text-primary">{SIGNATURE_NAMES[record.type] ?? record.type}</h2>
        {record.dirty && <span className="text-xs text-modified">edited</span>}
        {record.type !== "TES4" && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive"
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

      <table className="w-full table-fixed border-collapse text-sm">
        <colgroup>
          <col className="w-[42%] sm:w-[34%]" />
          <col />
          <col className="w-9" />
        </colgroup>
        <thead>
          <tr className="border-b bg-muted text-left text-xs text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Field</th>
            <th className="px-3 py-1.5 font-medium text-primary">{file.name}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <SectionRow label="Record Header" />
          <PlainRow depth={1} label="Signature" value={record.type} />
          <PlainRow depth={1} label="Data Size" value={record.dirty ? "(recalculated on save)" : String(record.raw.length)} />
          <EditableRow
            depth={1}
            label="Record Flags"
            value={flagList(record.flags, flagNames).join(", ") || "(none)"}
            active={editing === "hdr:flags"}
            onStart={() => startEdit("hdr:flags")}
            editor={
              <FlagsEditor
                value={record.flags}
                names={flagNames}
                onCancel={() => setEditing(null)}
                onCommit={(v) => mutate(() => (record.flags = v))}
              />
            }
          />
          <EditableRow
            depth={1}
            label="FormID"
            value={`[${record.type}:${hex8(record.formId)}]`}
            active={editing === "hdr:fid"}
            onStart={() => startEdit("hdr:fid")}
            editor={
              <HexIdEditor
                initial={hex8(record.formId)}
                error={error}
                onCancel={() => setEditing(null)}
                onCommit={(v) => mutate(() => (record.formId = v), { reindex: true })}
              />
            }
          />
          <PlainRow depth={1} label="Version Control Info 1" value={toHex(u32Bytes(record.stamp))} />
          <PlainRow depth={1} label="Form Version" value={String(record.version)} />
          <PlainRow depth={1} label="Version Control Info 2" value={toHex(u16Bytes(record.unknown))} />

          {loadError ? (
            <tr>
              <td colSpan={3} className="p-3 text-sm text-destructive">
                Couldn't read this record's fields: {loadError}
              </td>
            </tr>
          ) : (
            subs.map((s, i) => {
              const node = decodeSubrecord(record.type, s, edid, ctx);
              const commit = (leafNode: FieldNode) => (v: string | number) =>
                tryMutate(() => {
                  subs[i] = { type: s.type, data: writeLeaf(s.data, leafNode.leaf!, v, ctx.localized) };
                });
              return (
                <Fragment key={i}>
                  <NodeRows
                    node={node}
                    depth={0}
                    path={`${i}`}
                    data={s.data}
                    ctx={ctx}
                    editing={editing}
                    error={error}
                    onStart={startEdit}
                    onCancel={() => setEditing(null)}
                    commit={commit}
                    onArrayAdd={(n) => mutate(() => (subs[i] = { type: s.type, data: addArrayEntry(s.data, n.array!) }))}
                    onArrayRemove={(n) => mutate(() => (subs[i] = { type: s.type, data: removeArrayEntry(s.data, n.entry!) }))}
                    menu={
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`${s.type} actions`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setRawEditing(i)}>Edit raw bytes</DropdownMenuItem>
                          <DropdownMenuItem disabled={i === 0} onSelect={() => mutate(() => subs.splice(i - 1, 2, subs[i]!, subs[i - 1]!))}>
                            Move up
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={i === subs.length - 1} onSelect={() => mutate(() => subs.splice(i, 2, subs[i + 1]!, subs[i]!))}>
                            Move down
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onSelect={() => mutate(() => subs.splice(i, 1))}>
                            Remove field
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                  {rawEditing === i && (
                    <tr>
                      <td colSpan={3}>
                        <RawFieldEditor
                          initial={s}
                          onCancel={() => setRawEditing(null)}
                          onSave={(n) => {
                            mutate(() => (subs[i] = n));
                            setRawEditing(null);
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          )}

          {!loadError &&
            missing.map((sig) => (
              <tr key={sig} className="border-b border-border/40 text-muted-foreground/60">
                <td className="truncate px-3 py-1">{`${sig} - ${findSubDef(record.type, sig)!.label}`}</td>
                <td />
                <td>
                  <Button variant="ghost" size="icon" className="size-7" aria-label={`Add ${sig}`} title={`Add ${sig}`} onClick={() => addField(sig)}>
                    <Plus />
                  </Button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      {!loadError && (
        <form
          className="flex items-center gap-2 px-3 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const sig = newSig.trim().toUpperCase();
            if (!/^[A-Z0-9_]{4}$/.test(sig)) return setError("A field signature is 4 letters/digits, e.g. KWDA");
            addField(sig);
            setNewSig("");
          }}
        >
          <Input value={newSig} onChange={(e) => setNewSig(e.target.value)} maxLength={4} placeholder="SIGN" className="h-8 w-24 font-mono uppercase" />
          <Button size="sm" variant="secondary" type="submit">
            <Plus /> Add field
          </Button>
        </form>
      )}
      {error && !editing && <p className="px-3 pt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

const u32Bytes = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u16Bytes = (n: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};

const indent = (depth: number) => ({ paddingLeft: `${depth * 14 + 12}px` });

function SectionRow({ label }: { label: string }) {
  return (
    <tr className="border-b bg-secondary/60">
      <td colSpan={3} className="px-3 py-1 font-medium">
        {label}
      </td>
    </tr>
  );
}

function PlainRow({ label, value, depth }: { label: string; value: string; depth: number }) {
  return (
    <tr className="border-b border-border/60">
      <td className="truncate py-1 pr-2 text-muted-foreground" style={indent(depth)} title={label}>
        {label}
      </td>
      <td className="break-words px-3 py-1 font-mono text-xs">{value}</td>
      <td />
    </tr>
  );
}

function EditableRow({
  label,
  value,
  depth,
  active,
  onStart,
  editor,
  labelClass,
  actions,
}: {
  label: string;
  value: string;
  depth: number;
  active: boolean;
  onStart: () => void;
  editor: React.ReactNode;
  labelClass?: string;
  actions?: React.ReactNode;
}) {
  return (
    <tr className="border-b border-border/60 align-top">
      <td className={cn("truncate py-1 pr-2", labelClass ?? "text-muted-foreground")} style={indent(depth)} title={label}>
        {label}
      </td>
      <td className="px-2 py-0.5">
        {active ? (
          editor
        ) : (
          <button
            onClick={onStart}
            className="w-full break-words rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-accent focus-visible:outline-1 focus-visible:outline-ring"
            title="Click to edit"
          >
            {value || <span className="text-muted-foreground">(empty)</span>}
          </button>
        )}
      </td>
      <td className="py-0.5">{actions}</td>
    </tr>
  );
}

interface NodeRowsProps {
  node: FieldNode;
  depth: number;
  path: string;
  data: Uint8Array;
  ctx: DecodeContext;
  editing: string | null;
  error: string | null;
  onStart: (key: string) => void;
  onCancel: () => void;
  commit: (n: FieldNode) => (v: string | number) => void;
  onArrayAdd: (n: FieldNode) => void;
  onArrayRemove: (n: FieldNode) => void;
  menu?: React.ReactNode;
}

function NodeRows(props: NodeRowsProps) {
  const { node, depth, path, data, ctx, editing, error, onStart, onCancel, commit, onArrayAdd, onArrayRemove, menu } = props;
  const top = depth === 0;
  const labelClass = top ? "font-medium text-foreground" : "text-muted-foreground";
  const removeBtn = node.entry ? (
    <Button variant="ghost" size="icon" className="size-7" aria-label="Remove entry" title="Remove entry" onClick={() => onArrayRemove(node)}>
      <Trash2 />
    </Button>
  ) : null;

  const head = node.leaf ? (
    <EditableRow
      depth={depth}
      label={node.label}
      value={node.display}
      labelClass={labelClass}
      active={editing === path}
      onStart={() => onStart(path)}
      actions={menu ?? removeBtn}
      editor={
        <LeafEditor
          leaf={node.leaf}
          data={data}
          localized={ctx.localized}
          resolveFormId={ctx.resolveFormId}
          onCommit={commit(node)}
          onCancel={onCancel}
          error={error}
        />
      }
    />
  ) : (
    <tr className={cn("border-b border-border/60", top && "bg-secondary/30")}>
      <td className={cn("truncate py-1 pr-2", labelClass)} style={indent(depth)} title={node.label}>
        {node.label}
      </td>
      <td className="px-3 py-1 text-xs text-muted-foreground">
        {node.array ? (
          <button onClick={() => onArrayAdd(node)} className="inline-flex items-center gap-1 text-primary hover:underline">
            <Plus className="size-3" /> Add entry
          </button>
        ) : (
          node.display
        )}
      </td>
      <td className="py-0.5">{menu ?? removeBtn}</td>
    </tr>
  );

  return (
    <>
      {head}
      {node.warning && (
        <tr>
          <td colSpan={3} className="px-3 py-0.5 text-xs text-warning" style={indent(depth + 1)}>
            {node.warning}
          </td>
        </tr>
      )}
      {node.children?.map((c, j) => (
        <NodeRows key={j} {...props} node={c} depth={depth + 1} path={`${path}.${j}`} menu={undefined} />
      ))}
    </>
  );
}

function HexIdEditor({
  initial,
  error,
  onCommit,
  onCancel,
}: {
  initial: string;
  error: string | null;
  onCommit: (v: number) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    if (!/^(0x)?[0-9a-f]{1,8}$/i.test(v.trim())) return setErr("Up to 8 hex digits");
    onCommit(parseInt(v.trim().replace(/^0x/i, ""), 16));
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <Input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
          className="h-8 font-mono text-sm"
        />
        <Button size="sm" className="h-8" onClick={submit}>
          Apply
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {(err ?? error) && <p className="text-xs text-destructive">{err ?? error}</p>}
    </div>
  );
}
