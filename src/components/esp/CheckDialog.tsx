import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { checkPlugin, localIds, type CheckReport, type IssueKind, type MasterIds } from "@/lib/esp/check";
import { fileInfo, getEditorId, hex8, parseEsp, type EspFile, type EspRecord } from "@/lib/esp/format";
import { importMasterFiles, importMasterSources, type ImportResult } from "@/lib/esp/masterImport";
import { findPluginsByName, scanSkyrimFolder } from "@/lib/esp/skyrimFolder";
import { listFolder, nativeFilesAvailable, readFolderFile, usableSkyrimFolder, type SaveFolder } from "@/lib/native/espFiles";
import { forgetMaster, listRememberedMasters, recallMasterIds } from "@/lib/esp/masterStore";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  onGoTo: (r: EspRecord) => void;
}

export function CheckDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so it always checks the plugin as it is now. */}
        <CheckForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

const KIND_LABEL: Record<IssueKind, string> = {
  "undeclared-master": "Missing master",
  "missing-record": "Missing record",
  "own-id": "Bad FormID",
};

const PAGE = 25;

function CheckForm({ file, onGoTo, onOpenChange }: Props) {
  const [masterFiles, setMasterFiles] = useState<{ name: string; count: number; remembered: boolean; named?: number; needsStrings?: boolean }[]>([]);
  const idsRef = useRef<MasterIds>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [skyrimFolder, setSkyrimFolder] = useState<SaveFolder | null>(null);
  useEffect(() => {
    let live = true;
    if (nativeFilesAvailable()) void usableSkyrimFolder().then((f) => live && setSkyrimFolder(f));
    return () => {
      live = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    // Master files added in an earlier session are still on this device
    void listRememberedMasters().then((list) => {
      if (cancelled.current) return;
      setMasterFiles((prev) => [
        ...prev,
        ...list.filter((m) => !prev.some((p) => p.name.toLowerCase() === m.name.toLowerCase())).map((m) => ({ name: m.name, count: m.count, remembered: true, ...(m.named !== undefined ? { named: m.named } : {}) })),
      ]);
    });
    return () => {
      cancelled.current = true;
    };
  }, []);

  function applyImport(result: ImportResult) {
    for (const m of result.masters) {
      idsRef.current.set(m.name.toLowerCase(), m.ids);
      setMasterFiles((prev) => [
        ...prev.filter((x) => x.name.toLowerCase() !== m.name.toLowerCase()),
        { name: m.name, count: m.count, remembered: m.remembered, named: m.named, needsStrings: m.needsStrings },
      ]);
    }
    setReport(null); // results no longer reflect the files supplied
  }

  async function addMasters(list: File[]) {
    if (list.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const result = await importMasterFiles(list);
      applyImport(result);
      if (result.masters.length === 0) setError("Pick the master plugin itself (for example Skyrim.esm) along with its strings files.");
      else if (result.orphanStrings.length > 0) setError(`Strings files need their plugin picked with them: ${result.orphanStrings.join(", ")}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  /** Reads the masters this plugin lists (including the Unofficial Patch or any other mod) from the Skyrim folder. */
  async function readMastersFromFolder() {
    if (!skyrimFolder) return;
    setLoading(true);
    setError(null);
    try {
      const scan = await scanSkyrimFolder((path) => listFolder(skyrimFolder, path));
      if (!scan) throw new Error("Skyrim's files were not found in the chosen folder any more. Choose it again from Set up Skyrim files.");
      const have = new Set(masterFiles.map((m) => m.name.toLowerCase()));
      const wanted = fileInfo(file).masters.filter((n) => !have.has(n.toLowerCase()));
      if (wanted.length === 0) {
        setError("Every master this plugin lists has already been added.");
        return;
      }
      const { found, missing } = findPluginsByName(scan, wanted);
      if (found.length > 0) applyImport(await importMasterSources(found.map((e) => ({ name: e.name, read: () => readFolderFile(e) }))));
      if (missing.length > 0) setError(`Not in the Skyrim folder: ${missing.join(", ")}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function removeMaster(name: string) {
    idsRef.current.delete(name.toLowerCase());
    void forgetMaster(name);
    setMasterFiles((prev) => prev.filter((m) => m.name !== name));
    setReport(null);
  }

  async function run() {
    setRunning(true);
    setError(null);
    setReport(null);
    setShown(PAGE);
    try {
      // Load the remembered masters this plugin lists (only those, since Skyrim.esm is big)
      for (const name of fileInfo(file).masters) {
        if (idsRef.current.has(name.toLowerCase())) continue;
        const ids = await recallMasterIds(name);
        if (ids) idsRef.current.set(name.toLowerCase(), ids);
      }
      const result = await checkPlugin(file, { masterIds: idsRef.current }, () => cancelled.current);
      if (result) setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const unverified = report?.masters.filter((m) => !m.verified) ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" /> Check plugin
        </DialogTitle>
        <DialogDescription>
          Looks for FormIDs that point at a master the header does not list, and for references to records that are not there. Only fields
          the editor knows are FormIDs are checked.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2 rounded-md border p-3 text-sm">
        <p className="font-medium">Verify references into masters (optional)</p>
        <p className="text-xs text-muted-foreground">
          This app only has the plugin you opened, so it cannot tell whether a record in a master exists. Add the master files (for example
          Skyrim.esm) to check references into them too. Large files take a while to read, but the app keeps what it needs on this device, so
          you add each file once. Pick several at once from your Skyrim Data folder if you like. The app also keeps the Editor IDs and names of the records each master defines, so when you edit a reference you can search them by name. A localized master such as Skyrim.esm keeps its names in strings files: pick those with it (for example Skyrim_English.STRINGS, .DLSTRINGS and .ILSTRINGS).
        </p>
        {masterFiles.length > 0 && (
          <ul className="divide-y rounded-md border text-xs">
            {masterFiles.map((m) => (
              <li key={m.name} className="flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono">{m.name}</span>
                <span className="text-muted-foreground">
                  {m.count.toLocaleString()} records{m.remembered ? " · kept" : ""}
                  {m.named === undefined ? " · add again to search by name" : m.needsStrings ? " · names need its strings files" : ` · ${m.named.toLocaleString()} searchable by name`}
                </span>
                <button onClick={() => removeMaster(m.name)} aria-label={`Remove ${m.name}`} title="Remove and forget this file">
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".esp,.esm,.esl,.strings,.dlstrings,.ilstrings,application/octet-stream"
          className="hidden"
          onChange={(e) => {
            void addMasters(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={loading || running}>
          {loading ? "Reading…" : "Add master files"}
        </Button>
        {skyrimFolder && (
          <Button variant="secondary" size="sm" onClick={() => void readMastersFromFolder()} disabled={loading || running}>
            Read masters from Skyrim folder
          </Button>
        )}
      </div>

      <Button onClick={run} disabled={running || loading}>
        <ShieldCheck /> {running ? "Checking…" : report ? "Check again" : "Run check"}
      </Button>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {report && (
        <div className="space-y-3" role="status">
          <p className="flex items-start gap-2 text-sm">
            {report.total === 0 ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
            <span>
              {report.total === 0 ? "No problems found" : `${report.total.toLocaleString()} problem${report.total === 1 ? "" : "s"} found`} in{" "}
              {report.records.toLocaleString()} records and {report.refs.toLocaleString()} references.
              {report.total === 0 && unverified.length > 0 && " References into masters you did not add could not be verified."}
            </span>
          </p>

          {report.masters.length > 0 && (
            <ul className="divide-y rounded-md border text-xs">
              {report.masters.map((m) => (
                <li key={m.name} className="flex flex-wrap items-center gap-x-3 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono">{m.name}</span>
                  <span className="text-muted-foreground">
                    {m.uses === 0 ? "not used by any record" : `${m.uses.toLocaleString()} use${m.uses === 1 ? "" : "s"}`} · {m.verified ? "verified" : "not verified"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {report.issues.length > 0 && (
            <>
              <ul className="space-y-2">
                {report.issues.slice(0, shown).map((issue, i) => (
                  <li key={i} className="rounded-md border p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium">{KIND_LABEL[issue.kind]}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {getEditorId(issue.record) ?? "(no Editor ID)"} [{issue.record.type}:{hex8(issue.record.formId)}]
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          onGoTo(issue.record);
                          onOpenChange(false);
                        }}
                      >
                        Go to
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {issue.where}: {issue.message}
                    </p>
                  </li>
                ))}
              </ul>
              {report.issues.length > shown && (
                <Button variant="secondary" size="sm" onClick={() => setShown(shown + PAGE * 2)}>
                  Show more ({report.issues.length - shown} left)
                </Button>
              )}
              {report.total > report.issues.length && (
                <p className="text-xs text-muted-foreground">Showing the first {report.issues.length.toLocaleString()} of {report.total.toLocaleString()}.</p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
