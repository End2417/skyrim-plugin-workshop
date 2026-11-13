import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { importMasterFiles, importMasterSources, type FileSource, type ImportResult } from "@/lib/esp/masterImport";
import { defaultLanguage, scanSkyrimFolder } from "@/lib/esp/skyrimFolder";
import { chooseSkyrimFolder, listFolder, nativeFilesAvailable, readFolderFile, usableSkyrimFolder, type SaveFolder } from "@/lib/native/espFiles";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** First-launch help: pick Skyrim's own plugins and strings files once, so names and references work everywhere. */
export function SetupDialog({ open, onOpenChange }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const native = nativeFilesAvailable();
  const [folder, setFolder] = useState<SaveFolder | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (open && native) void usableSkyrimFolder().then((f) => live && setFolder(f));
    return () => {
      live = false;
    };
  }, [open, native]);

  // Several imports add up: a file imported again replaces its earlier entry
  function addResult(r: ImportResult) {
    setResult((prev) =>
      prev ? { masters: [...prev.masters.filter((m) => !r.masters.some((n) => n.name === m.name)), ...r.masters], ignored: r.ignored, orphanStrings: r.orphanStrings } : r,
    );
  }

  async function pick(list: File[]) {
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      addResult(await importMasterFiles(list, setStatus));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  /** Finds Skyrim's plugins (and loose strings files) in the folder the person gave access to, and imports them. */
  async function importFromFolder(f: SaveFolder) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setStatus("Looking in the folder…");
      const scan = await scanSkyrimFolder((path) => listFolder(f, path));
      if (!scan) {
        setError("That does not look like Skyrim's folder. Pick the Data folder, or the folder that contains it.");
        return;
      }
      const language = defaultLanguage(scan.strings);
      const entries = [...scan.plugins, ...(language ? (scan.strings.get(language) ?? []) : [])];
      const sources: FileSource[] = entries.map((e) => ({ name: e.name, read: () => readFolderFile(e) }));
      addResult(await importMasterSources(sources, setStatus));
      setNote(
        language
          ? `Names are in ${language}.`
          : "No loose strings files were found (Skyrim keeps them inside Skyrim - Interface.bsa unless they have been extracted), so records show Editor IDs without names. You can add extracted strings files with Choose files.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function chooseFolder() {
    setError(null);
    try {
      const picked = await chooseSkyrimFolder();
      if (picked) {
        setFolder(picked);
        await importFromFolder(picked);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up your Skyrim files</DialogTitle>
          <DialogDescription>
            Show the app Skyrim's own files once and it remembers what it needs, so records show their names, you can search masters by name when editing a
            reference, and Check plugin knows what exists.
          </DialogDescription>
        </DialogHeader>

        {native && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p className="font-medium">Easiest: let the app read Skyrim's folder</p>
            <p className="text-xs text-muted-foreground">
              Pick Skyrim's <span className="font-mono">Data</span> folder (or the folder that contains it) in Android's folder picker. The app only asks to read, and finds
              <span className="font-mono"> Skyrim.esm</span>, <span className="font-mono">Update.esm</span>, the DLC masters and any extracted strings files itself.
            </p>
            <div className="flex flex-wrap gap-2">
              {folder && (
                <Button size="sm" onClick={() => void importFromFolder(folder)} disabled={busy}>
                  Read “{folder.name}” again
                </Button>
              )}
              <Button size="sm" variant={folder ? "secondary" : "default"} onClick={() => void chooseFolder()} disabled={busy}>
                <FolderOpen /> {folder ? "Choose another folder" : "Choose Skyrim folder"}
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2 text-sm">
          <p className="font-medium">{native ? "Or pick the files yourself" : "Which files"}</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              From Skyrim's <span className="font-mono">Data</span> folder: <span className="font-mono">Skyrim.esm</span>,{" "}
              <span className="font-mono">Update.esm</span>, and <span className="font-mono">Dawnguard.esm</span>, <span className="font-mono">HearthFires.esm</span>{" "}
              or <span className="font-mono">Dragonborn.esm</span> if you use them.
            </li>
            <li>
              From <span className="font-mono">Data/Strings</span>: the files that start with the same name, such as{" "}
              <span className="font-mono">Skyrim_English.STRINGS</span>, <span className="font-mono">.DLSTRINGS</span> and <span className="font-mono">.ILSTRINGS</span>. They hold
              the names.
            </li>
          </ul>
          <p className="text-xs text-muted-foreground">
            You can select them all in one go. Android only lets the app see files you choose, so it cannot look through your folders on its own. Only IDs, names and
            strings are kept on this device, not the plugins. You can do this later from the info button.
          </p>
        </div>

        <input
          ref={input}
          type="file"
          multiple
          accept=".esp,.esm,.esl,.strings,.dlstrings,.ilstrings,application/octet-stream"
          className="hidden"
          onChange={(e) => {
            void pick(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Button variant={native ? "secondary" : "default"} onClick={() => input.current?.click()} disabled={busy}>
          <FolderOpen /> {busy ? status || "Working…" : result ? "Add more files" : "Choose files"}
        </Button>
        {busy && native && status && <p className="text-xs text-muted-foreground">{status} Large files take a while on a phone.</p>}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {result && (
          <div role="status" className="space-y-1 text-xs text-muted-foreground">
            {result.masters.map((m) => (
              <p key={m.name}>
                <span className="font-mono">{m.name}</span>: {m.count.toLocaleString()} records
                {m.needsStrings ? ", names need its strings files" : m.stringFiles > 0 ? `, ${m.named.toLocaleString()} searchable by name` : `, ${m.named.toLocaleString()} with Editor IDs`}
                {m.remembered ? "" : " (the device would not store it)"}
              </p>
            ))}
            {result.masters.length === 0 && <p>No plugin was picked. Pick the plugin (for example Skyrim.esm) together with its strings files.</p>}
            {result.orphanStrings.length > 0 && <p>These strings files need their plugin picked with them: {result.orphanStrings.join(", ")}.</p>}
            {note && <p>{note}</p>}
            {result.ignored.length > 0 && <p>Ignored (not plugins or strings files): {result.ignored.join(", ")}.</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant={result ? "default" : "secondary"} onClick={() => onOpenChange(false)} disabled={busy}>
            {result ? "Done" : "Skip for now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
