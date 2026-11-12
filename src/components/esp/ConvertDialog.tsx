import { useMemo, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NOT_CONVERTED, convertToLe, detectEdition, leFileName, type ConvertReport } from "@/lib/esp/convert";
import { downloadPlugin } from "@/lib/esp/download";
import { hex8, type EspFile } from "@/lib/esp/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
}

export function ConvertDialog({ open, onOpenChange, file }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so the detection reflects the file as it is now. */}
        <ConvertForm file={file} />
      </DialogContent>
    </Dialog>
  );
}

function ConvertForm({ file }: { file: EspFile }) {
  const edition = useMemo(() => detectEdition(file), [file]);
  const [renameEsl, setRenameEsl] = useState(true);
  const [trim, setTrim] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; report?: ConvertReport } | null>(null);
  const outName = leFileName(file.name);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const out = convertToLe(file, { renameEslMasters: renameEsl, trimToLeLayout: trim });
      const savedTo = await downloadPlugin(out.bytes, out.name);
      setResult({
        ok: true,
        report: out.report,
        message: `${savedTo ? `Saved to ${savedTo}` : `${out.name} was handed to your device`} (${(out.bytes.length / 1024).toFixed(1)} KB). Your open file was not changed.`,
      });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const report = result?.report;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Convert to Legendary Edition</DialogTitle>
        <DialogDescription>
          Makes a Legendary Edition copy of {file.name} for versions of Skyrim that cannot load Special Edition plugins. Unsaved edits are included.
        </DialogDescription>
      </DialogHeader>

      <div className="rounded-md border p-3 text-sm">
        {edition.edition === "SE" && (
          <>
            <p className="font-medium">This looks like a Special Edition plugin</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {edition.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
        {edition.edition === "LE" && <p className="font-medium">This already looks like a Legendary Edition plugin. Converting it changes nothing important.</p>}
        {edition.edition === "unknown" && <p className="font-medium">Could not tell which edition this plugin is for. Converting it is still safe; the original is kept.</p>}
      </div>

      <div className="space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <Checkbox checked={renameEsl} onCheckedChange={(v) => setRenameEsl(v === true)} className="mt-0.5" />
          <span>
            Rename <span className="font-mono text-xs">.esl</span> masters to <span className="font-mono text-xs">.esp</span>
            <span className="block text-xs text-muted-foreground">Legendary Edition cannot load .esl files, so the copies you make of those plugins must be .esp.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <Checkbox checked={trim} onCheckedChange={(v) => setTrim(v === true)} className="mt-0.5" />
          <span>
            Trim fields longer than the Legendary Edition layout (experimental)
            <span className="block text-xs text-muted-foreground">
              Special Edition sometimes adds data to the end of a field. The editor's layouts are hand-written and incomplete, so leave this off unless the game crashes on the plugin.
            </span>
          </span>
        </label>
        <p className="text-xs text-muted-foreground">
          The new file is saved as <span className="font-mono">{outName}</span>.
        </p>
      </div>

      {result && (
        <p role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {result.message}
        </p>
      )}

      {report && (
        <div className="space-y-3 text-sm">
          <section>
            <p className="font-medium">Changed</p>
            {report.changes.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing needed changing.</p>
            ) : (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {report.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </section>
          {report.warnings.length > 0 && (
            <section>
              <p className="font-medium">Check these</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {report.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}
          {report.layout.length > 0 && (
            <section>
              <p className="font-medium">Fields that differ from the Legendary Edition layout</p>
              <p className="text-xs text-muted-foreground">
                Checked {report.scanned.toLocaleString()} records the editor has layouts for. These fields are longer than Legendary Edition's. That may be a Special Edition addition, or just a layout the editor does not describe fully.
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {report.layout.map((l) => (
                  <li key={`${l.recordType}:${l.sub}:${l.actual}`}>
                    <span className="font-mono">
                      {l.recordType} › {l.sub}
                    </span>
                    : {l.actual} bytes instead of {l.expected}, in {l.count.toLocaleString()} record{l.count === 1 ? "" : "s"}
                    {l.trimmed ? " (trimmed)" : ""}. For example {l.exampleEditorId ?? "(no Editor ID)"} [{hex8(l.exampleFormId)}].
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">What this does not convert</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {NOT_CONVERTED.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>

      <Button onClick={run} disabled={busy}>
        <ArrowLeftRight /> {busy ? "Converting…" : `Convert to ${outName}`}
      </Button>
    </>
  );
}
