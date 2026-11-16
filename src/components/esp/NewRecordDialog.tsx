import { useState } from "react";
import { Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SIGNATURE_NAMES } from "@/lib/esp/defs";
import { getEditorId, type EspFile, type EspRecord } from "@/lib/esp/format";
import type { History } from "@/lib/esp/history";
import { copyRecord, createRecord, creatableTypes, editorIdProblem, freeEditorId } from "@/lib/esp/records";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  history: History;
  /** When set, the dialog copies this record instead of making an empty one. */
  source: EspRecord | null;
  onCreated: (r: EspRecord) => void;
}

export function NewRecordDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-md">
        {/* Mounted only while open, so the suggested Editor ID is free at the moment it opens. */}
        <Form {...props} />
      </DialogContent>
    </Dialog>
  );
}

const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function Form({ file, history, source, onCreated, onOpenChange }: Props) {
  const copying = source !== null;
  const types = creatableTypes();
  const [type, setType] = useState("WEAP");
  const [edid, setEdid] = useState(() => (source ? freeEditorId(file, `${getEditorId(source) ?? source.type}Copy`) : ""));
  const [error, setError] = useState<string | null>(null);
  const problem = edid ? editorIdProblem(file, edid) : null;

  function go() {
    try {
      const r = source ? copyRecord(history, file, source, edid.trim()) : createRecord(history, file, type, edid.trim());
      onOpenChange(false);
      onCreated(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {copying ? <Copy className="size-5" /> : <Plus className="size-5" />} {copying ? "Copy record" : "New record"}
        </DialogTitle>
        <DialogDescription>
          {copying
            ? `Makes a new ${source.type} record in this plugin with the same fields, right behind the original. It gets its own FormID.`
            : "Makes an empty record in this plugin with its own FormID. Add its fields afterwards with the record's \"add field\" list."}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        {!copying && (
          <label className="block space-y-1">
            <span className="font-medium">Type</span>
            <select className={selectClass} value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {SIGNATURE_NAMES[t] ?? t} ({t})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block space-y-1">
          <span className="font-medium">Editor ID</span>
          <Input
            value={edid}
            onChange={(e) => {
              setEdid(e.target.value);
              setError(null);
            }}
            autoCorrect="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="for example: MyIronSword"
            className="h-9 font-mono"
          />
          {problem && <span className="block text-xs text-destructive">{problem}</span>}
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={go} disabled={!edid || !!problem}>
            {copying ? "Copy" : "Create"}
          </Button>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">You can undo this with the undo button.</p>
      </div>
    </>
  );
}
