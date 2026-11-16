import { useEffect, useRef, useState } from "react";
import { GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { compareFiles, describeDifference, type CompareMode, type CompareResult, type DifferenceKind, type RecordDifference } from "@/lib/esp/compare";
import { fileInfo, hex8, parseEsp, type EspFile, type EspRecord } from "@/lib/esp/format";
import type { History } from "@/lib/esp/history";
import { removeRecords } from "@/lib/esp/records";
import { findPluginsByName, scanSkyrimFolder, type FolderItem } from "@/lib/esp/skyrimFolder";
import { listFolder, nativeFilesAvailable, readFolderFile, usableSkyrimFolder } from "@/lib/native/espFiles";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  history: History;
  onGoTo: (r: EspRecord) => void;
  /** Called after records were removed, so the editor can refresh. */
  onRemoved: () => void;
}

export function CompareDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so it always compares the plugin as it is now. */}
        <CompareForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

const PAGE = 25;
const MODE_LABEL: Record<CompareMode, string> = { auto: "Detect", master: "Against its master", versions: "Two versions" };
const KIND_LABEL: Record<DifferenceKind, string> = { added: "Only in this plugin", changed: "Changed", removed: "Only in the other" };
const keyOf = (d: RecordDifference) => `${d.kind}:${d.type}:${d.formId}`;

function CompareForm({ file, history, onGoTo, onRemoved, onOpenChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const [other, setOther] = useState<EspFile | null>(null);
  const [mode, setMode] = useState<CompareMode>("auto");
  const [strict, setStrict] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DifferenceKind>("changed");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [masters, setMasters] = useState<FolderItem[]>([]);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  // Masters of this plugin that are in the Skyrim folder the person gave access to, so they are one tap away
  useEffect(() => {
    if (!nativeFilesAvailable()) return;
    let live = true;
    void (async () => {
      try {
        const folder = await usableSkyrimFolder();
        if (!folder) return;
        const scan = await scanSkyrimFolder((path) => listFolder(folder, path));
        if (scan && live) setMasters(findPluginsByName(scan, fileInfo(file).masters).found);
      } catch {
        /* the folder is optional: picking a file still works */
      }
    })();
    return () => {
      live = false;
    };
  }, [file]);

  async function run(target: EspFile, nextMode: CompareMode = mode, nextStrict: boolean = strict) {
    setBusy(true);
    setStatus(`Comparing with ${target.name}…`);
    setError(null);
    setResult(null);
    setShown(PAGE);
    setOpen(new Set());
    try {
      const r = await compareFiles(file, target, { mode: nextMode, compareFormVersion: nextStrict }, () => cancelled.current);
      if (r && !cancelled.current) {
        setResult(r);
        setTab(r.counts.changed > 0 ? "changed" : r.counts.added > 0 ? "added" : r.counts.removed > 0 ? "removed" : "changed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function load(read: () => Promise<Uint8Array>, name: string) {
    setBusy(true);
    setError(null);
    setStatus(`Reading ${name}…`);
    try {
      const bytes = await read();
      await new Promise<void>((r) => setTimeout(r, 0)); // let the status show before the heavy part
      const parsed = parseEsp(bytes, name);
      if (cancelled.current) return;
      setOther(parsed);
      await run(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setStatus("");
    }
  }

  function changeMode(next: CompareMode) {
    setMode(next);
    if (other) void run(other, next, strict);
  }

  const [removedNote, setRemovedNote] = useState<string | null>(null);

  function removeIdentical() {
    if (!result || result.identicalRecords.length === 0) return;
    const n = result.identicalRecords.length;
    if (!confirm(`Remove ${n.toLocaleString()} record${n === 1 ? "" : "s"} that are exactly the same as in ${result.theirs}? You can undo this with the undo button.`)) return;
    removeRecords(history, file, result.identicalRecords, "Remove identical records");
    setResult({ ...result, identicalRecords: [], identical: 0 });
    setRemovedNote(`Removed ${n.toLocaleString()} identical record${n === 1 ? "" : "s"}.`);
    onRemoved();
  }

  const go = (r: EspRecord) => {
    onGoTo(r);
    onOpenChange(false);
  };

  const list = result ? result[tab] : [];
  const tabs: DifferenceKind[] = result?.mode === "master" ? ["changed", "added"] : ["changed", "added", "removed"];

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <GitCompare className="size-5" /> Compare plugins
        </DialogTitle>
        <DialogDescription>
          Compares <span className="font-mono">{file.name}</span> with another plugin: its master, or another version of the same mod (for example the Special
          Edition and Legendary Edition copies). Nothing is changed.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2 rounded-md border p-3 text-sm">
        <p className="font-medium">Compare with</p>
        <input
          ref={inputRef}
          type="file"
          accept=".esp,.esm,.esl,application/octet-stream"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void load(async () => new Uint8Array(await f.arrayBuffer()), f.name);
            e.target.value = "";
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {other ? "Choose another file" : "Choose file"}
          </Button>
          {masters.map((m) => (
            <Button key={m.uri} size="sm" variant="secondary" disabled={busy} onClick={() => void load(() => readFolderFile(m), m.name)}>
              {m.name}
            </Button>
          ))}
        </div>
        {masters.length > 0 && <p className="text-xs text-muted-foreground">Large masters such as Skyrim.esm take a while to read on a phone.</p>}
        {other && (
          <p className="text-xs text-muted-foreground">
            Other plugin: <span className="font-mono">{other.name}</span>
          </p>
        )}
      </div>

      {other && (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Read as:</span>
            {(["auto", "master", "versions"] as CompareMode[]).map((m) => (
              <Button key={m} size="sm" variant={mode === m ? "default" : "secondary"} className="h-7 px-2 text-xs" disabled={busy} onClick={() => changeMode(m)}>
                {MODE_LABEL[m]}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={strict}
              disabled={busy}
              onChange={(e) => {
                setStrict(e.target.checked);
                void run(other, mode, e.target.checked);
              }}
            />
            <span>Also report records that differ only in form version (Special Edition writes 44, Legendary Edition 43)</span>
          </label>
        </div>
      )}

      {busy && status && <p className="text-sm text-muted-foreground">{status}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-3" role="status">
          <p className="text-sm">
            {result.mode === "master"
              ? `${result.mine} against its master ${result.theirs}: ${result.counts.changed.toLocaleString()} changed, ${result.counts.added.toLocaleString()} new, ${result.identical.toLocaleString()} identical to the original, ${result.untouched.toLocaleString()} not touched.`
              : `${result.mine} against ${result.theirs}: ${result.counts.changed.toLocaleString()} changed, ${result.counts.added.toLocaleString()} only here, ${result.counts.removed.toLocaleString()} only there, ${result.identical.toLocaleString()} identical.`}
          </p>
          {result.mode === "master" && result.identicalRecords.length > 0 && (
            <div className="space-y-1 rounded-md border p-2 text-xs">
              <p>
                {result.identicalRecords.length.toLocaleString()} record{result.identicalRecords.length === 1 ? " is" : "s are"} exactly the same as in {result.theirs} (ITM). They add
                nothing, but one can be there on purpose: an identical copy puts the master's version above another plugin's changes. Remove them only if that is not the case.
              </p>
              <Button size="sm" variant="secondary" onClick={removeIdentical}>
                Remove {result.identicalRecords.length.toLocaleString()} identical record{result.identicalRecords.length === 1 ? "" : "s"}
              </Button>
            </div>
          )}
          {removedNote && <p className="text-xs text-muted-foreground">{removedNote}</p>}
          {result.mastersDiffer && (
            <p className="text-xs text-muted-foreground">
              The two plugins list different masters, so a reference to a record can look changed even when it points at the same one.
            </p>
          )}
          {result.truncated && <p className="text-xs text-muted-foreground">Each list shows the first {list.length.toLocaleString()} records; the counts above are complete.</p>}

          <div className="flex flex-wrap gap-2">
            {tabs.map((k) => (
              <Button
                key={k}
                size="sm"
                variant={tab === k ? "default" : "secondary"}
                onClick={() => {
                  setTab(k);
                  setShown(PAGE);
                }}
              >
                {KIND_LABEL[k]} ({result.counts[k].toLocaleString()})
              </Button>
            ))}
          </div>

          {list.length === 0 && <p className="text-sm text-muted-foreground">Nothing in this list.</p>}
          <ul className="space-y-2">
            {list.slice(0, shown).map((d) => {
              const k = keyOf(d);
              const expanded = open.has(k);
              return (
                <li key={k} className="rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{d.type}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {d.editorId ?? "(no Editor ID)"} [{hex8(d.formId)}]
                    </span>
                    {d.kind === "changed" && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          })
                        }
                      >
                        {expanded ? "Hide" : "Details"}
                      </Button>
                    )}
                    {d.mine && (
                      <Button variant="secondary" size="sm" onClick={() => go(d.mine!)}>
                        Go to
                      </Button>
                    )}
                  </div>
                  {d.kind === "changed" && <p className="mt-1 text-xs text-muted-foreground">Differs in: {d.what.join(", ")}</p>}
                  {expanded && (
                    <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
                      {describeDifference(d, result.localized).map((c, i) => (
                        <li key={i} className="break-words">
                          <span className="font-medium">{c.label}</span>: <span className="text-muted-foreground">{c.before}</span> → <span>{c.after}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {list.length > shown && (
            <Button variant="secondary" size="sm" onClick={() => setShown(shown + PAGE * 2)}>
              Show more ({list.length - shown} left)
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            "Before" is the other plugin's value and "after" is this plugin's. Only fields the editor knows are shown by name; other changes appear as raw data.
          </p>
        </div>
      )}
    </>
  );
}
