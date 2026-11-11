import { useMemo, useState } from "react";
import { ListChecks, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DecodeContext } from "@/lib/esp/decode";
import { diffRecord } from "@/lib/esp/changes";
import { getEditorId, hex8, walkRecords, type EspFile, type EspRecord } from "@/lib/esp/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  ctx: DecodeContext;
  /** Bumps whenever something is edited, so the list stays current. */
  rev: number;
  onRevert: (r: EspRecord) => void;
  onGoTo: (r: EspRecord) => void;
}

export function ChangesDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so it always reads the current edits. */}
        <ChangesList {...props} />
      </DialogContent>
    </Dialog>
  );
}

const PAGE = 25;

function ChangesList({ file, ctx, rev, onRevert, onGoTo, onOpenChange }: Props) {
  const [shown, setShown] = useState(PAGE);
  const records = useMemo(() => {
    const out: EspRecord[] = [];
    for (const r of walkRecords(file.nodes)) if (r.dirty) out.push(r);
    return out;
  }, [file, rev]);
  const deleted = file.deleted ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ListChecks className="size-5" /> Your changes
        </DialogTitle>
        <DialogDescription>
          {records.length === 0 && deleted.length === 0
            ? "Nothing has been changed yet."
            : `${records.length} edited record${records.length === 1 ? "" : "s"}${deleted.length ? `, ${deleted.length} deleted` : ""}. Values are shown as old → new.`}
        </DialogDescription>
      </DialogHeader>

      <ul className="space-y-4">
        {records.slice(0, shown).map((r) => (
          <RecordChanges key={r.uid} record={r} ctx={ctx} rev={rev} onRevert={onRevert} onGoTo={(rec) => (onGoTo(rec), onOpenChange(false))} />
        ))}
      </ul>
      {records.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown(shown + PAGE)}>
          Show more ({records.length - shown} left)
        </Button>
      )}

      {deleted.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">Deleted records</p>
          <p className="break-words font-mono text-xs text-muted-foreground">
            {deleted.slice(0, 50).map((k) => k.replace(":", " ")).join(", ")}
            {deleted.length > 50 ? ` … and ${deleted.length - 50} more` : ""}
          </p>
          <p className="text-xs text-muted-foreground">Deleted records can't be restored here. Reopen the original file to get them back.</p>
        </div>
      )}
    </>
  );
}

function RecordChanges({ record, ctx, rev, onRevert, onGoTo }: { record: EspRecord; ctx: DecodeContext; rev: number; onRevert: (r: EspRecord) => void; onGoTo: (r: EspRecord) => void }) {
  const changes = useMemo(() => {
    try {
      return diffRecord(record, ctx);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, rev]);

  return (
    <li className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted px-3 py-2">
        <button className="min-w-0 flex-1 truncate text-left font-mono text-xs underline-offset-2 hover:underline" onClick={() => onGoTo(record)}>
          {getEditorId(record) ?? "(no Editor ID)"} [{record.type}:{hex8(record.formId)}]
        </button>
        {record.type !== "TES4" && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onRevert(record)}>
            <Undo2 className="size-3.5" /> Revert
          </Button>
        )}
      </div>
      {changes === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Could not read this record's changes.</p>
      ) : changes.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Edited, but the values are the same as the original.</p>
      ) : (
        <dl className="divide-y text-xs">
          {changes.map((c, i) => (
            <div key={i} className="px-3 py-1.5">
              <dt className="break-words text-muted-foreground">{c.label}</dt>
              <dd className="break-words font-mono">
                <span className="text-muted-foreground line-through decoration-muted-foreground/60">{c.before}</span>
                <span className="px-1.5 text-muted-foreground">→</span>
                <span className="text-modified">{c.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
