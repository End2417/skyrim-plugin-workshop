import { useMemo, useState } from "react";
import { PackageOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { downloadPlugin } from "@/lib/esp/download";
import { extractPlugin, fieldKey, findLocalizedFields, listChangedRecords } from "@/lib/esp/extract";
import { getEditorId, hex8, type EspFile, type EspRecord } from "@/lib/esp/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  selected: EspRecord | null;
}

export function ExtractDialog({ open, onOpenChange, file, selected }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so the list is rebuilt from the current edits each time. */}
        <ExtractForm file={file} selected={selected} />
      </DialogContent>
    </Dialog>
  );
}

const label = (r: EspRecord) => `${getEditorId(r) ?? "(no Editor ID)"}  [${r.type}:${hex8(r.formId)}]`;

function ExtractForm({ file, selected }: { file: EspFile; selected: EspRecord | null }) {
  const changed = useMemo(() => listChangedRecords(file), [file]);
  const extra = selected && selected.type !== "TES4" && !selected.dirty ? selected : null;
  const candidates = extra ? [...changed, extra] : changed;

  const base = file.name.replace(/\.(esp|esm|esl)$/i, "");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(changed.map((r) => r.uid)));
  const [outName, setOutName] = useState(`${base}_Changes.esp`);
  const [sourceName, setSourceName] = useState(file.name);
  const [text, setText] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const chosen = candidates.filter((r) => picked.has(r.uid));
  const localized = useMemo(() => findLocalizedFields(file, chosen), [file, chosen.length, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(r: EspRecord, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(r.uid);
    else next.delete(r.uid);
    setPicked(next);
    setStatus(null);
  }

  async function run() {
    setBusy(true);
    setStatus(null);
    try {
      const name = /\.(esp)$/i.test(outName.trim()) ? outName.trim() : `${outName.trim().replace(/\.(esm|esl)$/i, "")}.esp`;
      const bytes = extractPlugin(file, chosen, {
        sourceName,
        text: new Map(Object.entries(text)),
      });
      await downloadPlugin(bytes, name);
      setStatus({
        ok: true,
        message: `${name} was handed to your device (${chosen.length} record${chosen.length === 1 ? "" : "s"}, ${(bytes.length / 1024).toFixed(1)} KB). This app cannot confirm where it was saved. Put it in Skyrim's Data folder and enable it after ${sourceName} in your load order.`,
      });
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <PackageOpen className="size-5" /> Extract changes as a new plugin
        </DialogTitle>
        <DialogDescription>
          Saves only the records below into a small .esp that overrides them in {sourceName || "the source plugin"}, like a mod. The
          original plugin is not touched.
        </DialogDescription>
      </DialogHeader>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has been changed yet. Edit a record (for example a weapon's damage), then come back here. You can also select a record
          in the tree to extract it unchanged.
        </p>
      ) : (
        <ul className="max-h-48 divide-y overflow-auto rounded-md border text-sm">
          {candidates.map((r) => (
            <li key={r.uid} className="flex items-center gap-3 px-3 py-2">
              <Checkbox id={`ex-${r.uid}`} checked={picked.has(r.uid)} onCheckedChange={(v) => toggle(r, v === true)} />
              <label htmlFor={`ex-${r.uid}`} className="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs">
                {label(r)}
              </label>
              <span className="text-xs text-muted-foreground">{r.dirty ? "edited" : "unchanged"}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
        <label htmlFor="ex-out" className="text-muted-foreground">New file name</label>
        <Input id="ex-out" value={outName} onChange={(e) => setOutName(e.target.value)} className="h-8 font-mono text-xs" />
        <label htmlFor="ex-src" className="text-muted-foreground">Source plugin</label>
        <Input id="ex-src" value={sourceName} onChange={(e) => setSourceName(e.target.value)} className="h-8 font-mono text-xs" />
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        The source plugin must be named exactly as it appears in your game's Data folder (for example Skyrim.esm).
      </p>

      {localized.length > 0 && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Text in {sourceName || "the source"} is stored in string tables</p>
          <p className="text-xs text-muted-foreground">
            A new plugin can't use those tables, so enter the text to store directly. Leave a name blank to use its Editor ID. Blank
            descriptions are left out.
          </p>
          {localized.map((f) => (
            <div key={fieldKey(f)} className="grid grid-cols-[8rem_1fr] items-center gap-2 text-xs">
              <span className="truncate font-mono text-muted-foreground" title={label(f.record)}>
                {getEditorId(f.record) ?? hex8(f.record.formId)} · {f.sub}
              </span>
              <Input
                aria-label={`${f.sub} text for ${label(f.record)}`}
                placeholder={f.sub === "FULL" ? (getEditorId(f.record) ?? "Name") : "(omit)"}
                value={text[fieldKey(f)] ?? ""}
                onChange={(e) => setText({ ...text, [fieldKey(f)]: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
          ))}
        </div>
      )}

      {status && (
        <p role={status.ok ? "status" : "alert"} className={`text-sm ${status.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {status.message}
        </p>
      )}

      <Button onClick={run} disabled={busy || chosen.length === 0}>
        <PackageOpen /> {busy ? "Building…" : `Extract ${chosen.length} record${chosen.length === 1 ? "" : "s"} to .esp`}
      </Button>
    </>
  );
}
