import { useMemo, useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { checkEsl } from "@/lib/esp/esl";
import type { EspFile } from "@/lib/esp/format";
import { addMaster, addMasterProblem, HEADER_FLAG_ESL, HEADER_FLAG_ESM, readHeader, renameMaster, setHeaderFlag, setHeaderText, validMasterName } from "@/lib/esp/header";
import type { History } from "@/lib/esp/history";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  history: History;
  /** Called after the header was changed, so the editor can refresh and remember there is something to save. */
  onApplied: () => void;
}

export function HeaderDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-lg">
        <Form {...props} />
      </DialogContent>
    </Dialog>
  );
}

function Form({ file, history, onApplied, onOpenChange }: Props) {
  const info = useMemo(() => readHeader(file), [file]);
  const esl = useMemo(() => checkEsl(file), [file]);
  const [author, setAuthor] = useState(info?.author ?? "");
  const [description, setDescription] = useState(info?.description ?? "");
  const [isEsm, setIsEsm] = useState(((info?.flags ?? 0) & HEADER_FLAG_ESM) !== 0);
  const [isEsl, setIsEsl] = useState(((info?.flags ?? 0) & HEADER_FLAG_ESL) !== 0);
  const [names, setNames] = useState<string[]>(info?.masters ?? []);
  const [added, setAdded] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!info) return <p className="p-4 text-sm">This file has no header record.</p>;

  const addProblem = added.trim() ? addMasterProblem(file, added.trim()) : null;

  function apply() {
    // Check everything first, so the header is never left half changed
    for (const [i, n] of names.entries()) {
      if (n !== info!.masters[i] && !validMasterName(n)) return setError(`Master ${i + 1}: enter a file name ending in .esm, .esp or .esl.`);
    }
    if (added.trim() && addProblem) return setError(addProblem);
    try {
      history.batch("Edit header", () => {
        if (author !== info!.author) setHeaderText(file, "CNAM", author);
        if (description !== info!.description) setHeaderText(file, "SNAM", description);
        if (isEsm !== ((info!.flags & HEADER_FLAG_ESM) !== 0)) setHeaderFlag(file, HEADER_FLAG_ESM, isEsm);
        if (isEsl !== ((info!.flags & HEADER_FLAG_ESL) !== 0)) setHeaderFlag(file, HEADER_FLAG_ESL, isEsl);
        names.forEach((n, i) => {
          if (n !== info!.masters[i]) renameMaster(file, i, n);
        });
        if (added.trim()) addMaster(file, added.trim());
      });
      onApplied();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Settings className="size-5" /> File header
        </DialogTitle>
        <DialogDescription>
          Author, description, flags and masters of <span className="font-mono">{file.name}</span>. Header version {info.version.toFixed(2)} · {info.recordCount.toLocaleString()} records and
          groups · {info.ownRecords.toLocaleString()} of its own.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <label className="block space-y-1">
          <span className="font-medium">Author</span>
          <Input value={author} onChange={(e) => setAuthor(e.target.value)} className="h-9" />
        </label>
        <label className="block space-y-1">
          <span className="font-medium">Description</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} className="h-9" />
        </label>

        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <Checkbox checked={isEsm} onCheckedChange={(v) => setIsEsm(v === true)} />
            <span>Master file (ESM flag)</span>
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={isEsl} onCheckedChange={(v) => setIsEsl(v === true)} />
            <span>Light plugin (ESL flag)</span>
          </label>
          {isEsl && esl && !esl.eligible && (
            <p className="text-xs text-destructive">
              This plugin does not fit the light-plugin window: {esl.reasons[0]} The game may refuse to load it as light.
            </p>
          )}
          {isEsl && esl?.eligible && <p className="text-xs text-muted-foreground">All {esl.newRecords.toLocaleString()} new records fit the light-plugin window.</p>}
        </div>

        <div className="space-y-2">
          <p className="font-medium">Masters</p>
          {names.length === 0 && <p className="text-xs text-muted-foreground">No masters.</p>}
          {names.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{i.toString(16).toUpperCase().padStart(2, "0")}</span>
              <Input
                value={n}
                onChange={(e) => setNames((list) => list.map((x, k) => (k === i ? e.target.value : x)))}
                autoCorrect="off"
                spellCheck={false}
                className="h-9 font-mono"
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            You can fix a master's spelling here. The order cannot change, because every FormID starts with the number of its master.
          </p>
          <label className="block space-y-1">
            <span className="font-medium">Add a master</span>
            <Input value={added} onChange={(e) => setAdded(e.target.value)} autoCorrect="off" spellCheck={false} placeholder="for example: Update.esm" className="h-9 font-mono" />
            {addProblem && <span className="block text-xs text-destructive">{addProblem}</span>}
          </label>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={apply}>Apply</Button>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}
