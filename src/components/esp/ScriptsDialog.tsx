import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Copy, FileCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getEditorId, hex8, type EspFile, type EspRecord } from "@/lib/esp/format";
import { scanScripts, scriptFileList, type ScriptReport } from "@/lib/esp/scripts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  onGoTo: (r: EspRecord) => void;
}

export function ScriptsDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so it always reads the plugin as it is now. */}
        <ScriptsForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

const PAGE = 25;

const label = (r: EspRecord) => getEditorId(r) ?? hex8(r.formId);

function ScriptsForm({ file, onGoTo, onOpenChange }: Props) {
  const [report, setReport] = useState<ScriptReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setReport(null);
    setError(null);
    scanScripts(file, () => stop)
      .then((r) => {
        if (!stop && r) setReport(r);
      })
      .catch((e) => {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stop = true;
    };
  }, [file]);

  async function copyList() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(scriptFileList(report));
      setCopyNote("Copied. These are the .pex files the plugin expects in Data/Scripts.");
    } catch {
      setCopyNote("Could not copy here. Select the names in the list instead.");
    }
  }

  const go = (r: EspRecord) => {
    onGoTo(r);
    onOpenChange(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FileCode className="size-5" /> Scripts
        </DialogTitle>
        <DialogDescription>
          Lists the Papyrus scripts this plugin uses and the libraries they look like they come from. The scripts themselves (.pex files) are not inside a
          plugin, so a mod can load fine and still not work if its scripts or their requirements are missing.
        </DialogDescription>
      </DialogHeader>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!report && !error && <p className="text-sm text-muted-foreground">Reading scripts…</p>}

      {report && (
        <div className="space-y-3" role="status">
          <p className="flex items-start gap-2 text-sm">
            {report.scripts.length === 0 ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" /> : <FileCode className="mt-0.5 size-4 shrink-0 text-primary" />}
            <span>
              {report.scripts.length === 0
                ? `No scripts found in ${report.scanned.toLocaleString()} records.`
                : `${report.scripts.length.toLocaleString()} script${report.scripts.length === 1 ? "" : "s"} used by ${report.records.length.toLocaleString()} record${report.records.length === 1 ? "" : "s"}.`}
            </span>
          </p>

          {report.libraries.length > 0 && (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">Needs more than the plugin</p>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                {report.libraries.map((l) => (
                  <li key={l.library.name}>
                    <span className="font-medium">{l.library.needs}</span>
                    <span className="text-muted-foreground"> — {l.scripts.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.scripts.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Libraries are recognised by script name only. Any other script may need SKSE too, and that cannot be seen from the plugin, so check the mod's
              requirements.
            </p>
          )}

          {report.issues.length > 0 && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CircleAlert className="size-4 text-destructive" /> {report.issues.length.toLocaleString()} script propert{report.issues.length === 1 ? "y points" : "ies point"} nowhere
              </p>
              <ul className="space-y-2">
                {report.issues.slice(0, shown).map((issue, i) => (
                  <li key={i} className="rounded-md border p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {label(issue.record)} [{issue.record.type}] · {issue.script}.{issue.property}
                      </span>
                      <Button variant="secondary" size="sm" onClick={() => go(issue.record)}>
                        Go to
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{issue.message}</p>
                  </li>
                ))}
              </ul>
              {report.issues.length > shown && (
                <Button variant="secondary" size="sm" onClick={() => setShown(shown + PAGE * 2)}>
                  Show more ({report.issues.length - shown} left)
                </Button>
              )}
            </div>
          )}

          {report.unreadable.length > 0 && (
            <div className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">
                {report.unreadable.length.toLocaleString()} record{report.unreadable.length === 1 ? "" : "s"} could not be read completely
              </p>
              <p>Scripts found before the problem are listed. Fragment, alias or scene scripts after it may be missing from this report.</p>
              <ul className="space-y-1">
                {report.unreadable.slice(0, 5).map((u, i) => (
                  <li key={i} className="break-words">
                    <button className="font-mono underline underline-offset-2" onClick={() => go(u.record)}>
                      {label(u.record)} [{u.record.type}]
                    </button>
                    : {u.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.scripts.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void copyList()}>
                  <Copy /> Copy .pex list
                </Button>
                {copyNote && <span className="text-xs text-muted-foreground">{copyNote}</span>}
              </div>
              <ul className="space-y-2">
                {report.scripts.map((s) => (
                  <li key={`${s.kind}:${s.name}`} className="rounded-md border p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 break-all font-mono text-xs">{s.name}</span>
                      {s.library && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium">{s.library.name}</span>}
                      {s.kind !== "script" && <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{s.kind === "fragment" ? "fragment" : "alias"}</span>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {s.recordCount.toLocaleString()} record{s.recordCount === 1 ? "" : "s"} ({Object.entries(s.types).map(([t, n]) => `${t} ${n}`).join(", ")})
                      {s.removed > 0 && ` · removed in ${s.removed}`}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.examples.map((r) => (
                        <Button key={r.uid} variant="secondary" size="sm" className="h-6 max-w-full px-2 text-xs" onClick={() => go(r)}>
                          <span className="truncate">{label(r)}</span>
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
