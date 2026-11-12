import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeftRight, Download, FolderCog, FolderOpen, Info, ListChecks, PackageOpen, Search, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DecodeContext } from "@/lib/esp/decode";
import { downloadPlugin } from "@/lib/esp/download";
import { onFileOpened, readOpenedFile, takePendingFile, type OpenedFile } from "@/lib/native/espFiles";
import { buildSearchIndex, searchIndex, type SearchIndex } from "@/lib/esp/search";
import { applyDraft, clearDraft, fileSignature, loadDraft, makeDraft, saveDraft, type Draft } from "@/lib/esp/draft";
import {
  forgetStringFiles,
  mergeStringTables,
  parseStringsFile,
  recallStringFiles,
  rememberStringFiles,
  setActiveStrings,
  type StringTable,
} from "@/lib/esp/strings";
import {
  revertRecord,
  buildFormIdIndex,
  countRecords,
  describeGroup,
  fileInfo,
  getDisplayName,
  getEditorId,
  hex8,
  parseEsp,
  serializeEsp,
  walkRecords,
  type EspFile,
  type EspGroup,
  type EspRecord,
} from "@/lib/esp/format";
import { AboutDialog, useFirstLaunchAbout } from "./AboutDialog";
import { ChangesDialog } from "./ChangesDialog";
import { CheckDialog } from "./CheckDialog";
import { ConvertDialog } from "./ConvertDialog";
import { detectEdition } from "@/lib/esp/convert";
import { ExtractDialog } from "./ExtractDialog";
import { RecordRow, RecordTree, TREE_COLS } from "./RecordTree";
import { RecordView } from "./RecordView";
import { SaveFolderDialog, saveFolderSupported } from "./SaveFolderDialog";

const MAX_RESULTS = 500;
/** Rows drawn at once; the rest are one tap away, so a broad search stays quick to show. */
const PAGE_SIZE = 100;

export function EspEditor() {
  const [file, setFile] = useState<EspFile | null>(null);
  const [selected, setSelected] = useState<EspRecord | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ failed: boolean; filename: string; detail?: string; savedTo?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [native, setNative] = useState(false); // known only on the device, so set after the first render
  const searchIndexRef = useRef<SearchIndex | null>(null);
  const [indexedFile, setIndexedFile] = useState<EspFile | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [aboutOpen, setAboutOpen] = useFirstLaunchAbout();
  const [changesOpen, setChangesOpen] = useState(false);
  const [strings, setStrings] = useState<StringTable | null>(null);
  const [stringsMsg, setStringsMsg] = useState<string | null>(null);
  const stringPartsRef = useRef<Map<string, { name: string; strings: Map<number, string>; bytes: Uint8Array }>>(new Map());
  const stringsInputRef = useRef<HTMLInputElement>(null);
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null);
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const sigRef = useRef<string | null>(null);
  const fileRef = useRef<EspFile | null>(null);
  const [modified, setModified] = useState(false);
  const [filterId, setFilterId] = useState("");
  const [filterEdid, setFilterEdid] = useState("");
  const [results, setResults] = useState<EspRecord[] | null>(null);
  const [rev, setRev] = useState(0);
  const [indexRev, setIndexRev] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const index = useMemo(() => (file ? buildFormIdIndex(file) : new Map<number, EspRecord>()), [file, indexRev]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const info = useMemo(() => (file ? fileInfo(file) : { localized: false, masters: [] }), [file, rev]);

  // Read once per opened file: it only looks at record headers, so it is cheap, but it need not rerun on every edit.
  const edition = useMemo(() => (file ? detectEdition(file).edition : null), [file]);

  const ctx: DecodeContext = {
    localized: info.localized,
    resolveFormId: (id) => {
      if (id === 0) return "NULL - Null Reference [00000000]";
      const r = index.get(id >>> 0);
      if (r) {
        const e = getEditorId(r);
        const n = getDisplayName(r, info.localized);
        return `${e ?? ""}${n ? ` "${n}"` : ""} [${r.type}:${hex8(id)}]`.trim();
      }
      const hi = id >>> 24;
      if (hi < info.masters.length) return `[${hex8(id)}] from ${info.masters[hi]}`;
      return `[${hex8(id)}] (not found in this file)`;
    },
  };

  const changed = (opts?: { reindex?: boolean }) => {
    setSaveFeedback(null);
    setModified(true);
    setRev((r) => r + 1);
    if (opts?.reindex) setIndexRev((r) => r + 1);
  };

  // ----- strings files (names and descriptions of localized plugins such as Skyrim.esm) -----
  function applyStrings(table: StringTable | null, target: EspFile | null = file) {
    setActiveStrings(table);
    setStrings(table);
    if (target) for (const r of walkRecords(target.nodes)) r.nameCache = undefined; // names are looked up again
    setIndexRev((n) => n + 1);
    setRev((n) => n + 1);
  }

  function rebuildStrings(target: EspFile | null = file) {
    const parts = [...stringPartsRef.current.values()];
    applyStrings(parts.length ? mergeStringTables(parts) : null, target);
  }

  async function recallStrings(target: EspFile) {
    const saved = await recallStringFiles(target.name);
    if (!saved || fileRef.current !== target) return;
    try {
      for (const f of saved) stringPartsRef.current.set(f.name, { name: f.name, strings: parseStringsFile(f.name, f.bytes), bytes: f.bytes });
      rebuildStrings(target);
      setStringsMsg("Names restored from the strings files you loaded before.");
    } catch {
      /* stored files unreadable: the person can load them again */
    }
  }

  async function loadStringFiles(list: File[]) {
    if (!file || list.length === 0) return;
    setStringsMsg(null);
    try {
      for (const f of list) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        stringPartsRef.current.set(f.name, { name: f.name, strings: parseStringsFile(f.name, bytes), bytes });
      }
      rebuildStrings();
      const parts = [...stringPartsRef.current.values()];
      const kept = await rememberStringFiles(file.name, parts.map((p) => ({ name: p.name, bytes: p.bytes })));
      setStringsMsg(`Loaded ${parts.length} strings file${parts.length === 1 ? "" : "s"}.${kept ? " They will be remembered on this device." : ""}`);
    } catch (e) {
      setStringsMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function forgetStrings() {
    stringPartsRef.current = new Map();
    rebuildStrings();
    if (file) void forgetStringFiles(file.name);
    setStringsMsg("Strings files forgotten.");
  }

  // ----- undo, drafts -----
  function revert(r: EspRecord) {
    if (revertRecord(r)) changed({ reindex: true });
  }

  function restoreDraft() {
    if (!file || !pendingDraft) return;
    const { applied, missing } = applyDraft(file, pendingDraft);
    setPendingDraft(null);
    changed({ reindex: true });
    setDraftNote(`Restored ${applied} change${applied === 1 ? "" : "s"}${missing ? ` (${missing} no longer matched this file)` : ""}.`);
  }

  function discardDraft() {
    if (sigRef.current) clearDraft(sigRef.current);
    setPendingDraft(null);
  }

  async function openFile(f: File) {
    await openBytes(async () => new Uint8Array(await f.arrayBuffer()), f.name);
  }

  async function openBytes(load: () => Promise<Uint8Array>, name: string) {
    setLoading(true);
    setError(null);
    setSaveFeedback(null);
    try {
      const bytes = await load();
      const parsed = parseEsp(bytes, name);
      sigRef.current = fileSignature(name, bytes.length);
      setPendingDraft(loadDraft(sigRef.current));
      setDraftNote(null);
      stringPartsRef.current = new Map();
      setActiveStrings(null);
      setStrings(null);
      setStringsMsg(null);
      if (fileInfo(parsed).localized) void recallStrings(parsed);
      setFile(parsed);
      setSelected(parsed.nodes[0] as EspRecord);
      setExpanded(new Set());
      setModified(false);
      setResults(null);
      setFilterId("");
      setFilterEdid("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!file) return;
    setSaveFeedback(null);
    try {
      const bytes = serializeEsp(file);
      const savedTo = await downloadPlugin(bytes, file.name);
      setSaveFeedback({ failed: false, filename: file.name, ...(savedTo ? { savedTo } : {}) });
      // A dispatched click is not proof that the file was saved. Keep edits
      // marked unsaved until a confirmed save mechanism is available.
    } catch (e) {
      setSaveFeedback({ failed: true, filename: file.name, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  function select(r: EspRecord, reveal = false) {
    setSelected(r);
    if (reveal) {
      const next = new Set(expanded);
      for (let g: EspGroup | null = r.parent; g; g = g.parent) next.add(g.uid);
      setExpanded(next);
    }
    if (window.innerWidth < 1024) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth" }));
  }

  function toggle(uid: number) {
    const next = new Set(expanded);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setExpanded(next);
  }

  // Prepare the search in the background as soon as a file is open (and again after records
  // are added or removed), so typing never waits on it.
  useEffect(() => {
    if (!file) {
      searchIndexRef.current = null;
      setIndexedFile(null);
      return;
    }
    if (searchIndexRef.current?.file !== file) {
      searchIndexRef.current = null;
      setIndexedFile(null);
    }
    let cancelled = false;
    void buildSearchIndex(file, info.localized, () => cancelled).then((ix) => {
      if (cancelled || !ix) return;
      searchIndexRef.current = ix;
      setIndexedFile(file);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, indexRev]);

  // Search as you type, a moment after you stop. Runs in slices, and a newer search replaces an older one.
  useEffect(() => {
    if (!file) return;
    if (!filterEdid.trim()) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      const ix = searchIndexRef.current;
      if (!ix || ix.file !== file) return; // runs again when the index is ready
      void searchIndex(ix, filterEdid, MAX_RESULTS, () => cancelled).then((res) => {
        if (cancelled || !res) return;
        setResults(res);
        setShown(PAGE_SIZE);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [filterEdid, file, indexedFile]);

  fileRef.current = file;

  // Autosave a draft of the edits shortly after each change, and right away when the app goes to the background
  // (Android may close it there). A draft waiting to be restored is never overwritten.
  const saveNow = () => {
    const f = fileRef.current;
    const sig = sigRef.current;
    if (!f || !sig) return;
    const draft = makeDraft(f, sig);
    if (!draft) {
      clearDraft(sig);
      setDraftNote(null);
    } else {
      const ok = saveDraft(draft);
      setDraftNote(ok ? `Draft saved ${new Date(draft.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Draft too large to autosave");
    }
  };
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  useEffect(() => {
    if (!file || pendingDraft || rev === 0) return;
    const t = setTimeout(() => saveNowRef.current(), 1200);
    return () => clearTimeout(t);
  }, [rev, file, pendingDraft]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden" && !pendingDraftRef.current) saveNowRef.current();
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, []);
  const pendingDraftRef = useRef(pendingDraft);
  pendingDraftRef.current = pendingDraft;

  // "Open with": a plugin tapped in the Files app arrives here, both at launch and while the app is running.
  const openBytesRef = useRef(openBytes);
  openBytesRef.current = openBytes;
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;
  useEffect(() => {
    setNative(saveFolderSupported());
    let dead = false;
    let stop: (() => void) | undefined;
    const open = async (f: OpenedFile) => {
      if (modifiedRef.current) saveNowRef.current(); // keep a draft of the file being replaced
      await openBytesRef.current(() => readOpenedFile(f), f.name);
    };
    void (async () => {
      const first = await takePendingFile();
      if (first && !dead) await open(first);
      const off = await onFileOpened((f) => void open(f));
      if (dead) off();
      else stop = off;
    })();
    return () => {
      dead = true;
      stop?.();
    };
  }, []);

  const preparingSearch = !!file && filterEdid.trim() !== "" && indexedFile !== file;

  const breadcrumb: string[] = [];
  if (file && selected) {
    for (let g: EspGroup | null = selected.parent; g; g = g.parent) breadcrumb.unshift(describeGroup(g));
    breadcrumb.unshift(file.name);
    const e = getEditorId(selected);
    breadcrumb.push(selected.type === "TES4" ? "File Header" : `${hex8(selected.formId)}${e ? ` <${e}>` : ""}`);
  }

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex flex-wrap items-center gap-3 border-b bg-card px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <h1 className="font-display text-lg tracking-wide text-primary">Skyrim ESP Editor for Android</h1>
        {file && (
          <span className="max-w-full truncate font-mono text-xs text-muted-foreground">
            {countRecords(file.nodes).toLocaleString()} records
            {edition === "SE" && " · Special Edition plugin"}
            {info.masters.length > 0 && ` · masters: ${info.masters.join(", ")}`}
            {modified && <span className="ml-2 text-modified">● unsaved changes</span>}
            {draftNote && <span className="ml-2">· {draftNote}</span>}
          </span>
        )}
        <div className="ml-auto flex max-w-full flex-wrap justify-end gap-2">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setAboutOpen(true)} aria-label="About and credits">
            <Info />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setChangesOpen(true)} disabled={!file} aria-label="Review your changes" title="Review your changes">
            <ListChecks />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setCheckOpen(true)} disabled={!file} aria-label="Check plugin" title="Check for missing masters and records">
            <ShieldCheck />
          </Button>
          {native && (
            <Button variant="ghost" size="icon" className="size-8" onClick={() => setFolderOpen(true)} aria-label="Save folder" title="Choose where files are saved">
              <FolderCog />
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".esp,.esm,.esl,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void openFile(f);
              e.target.value = "";
            }}
          />
          <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={loading}>
            <FolderOpen /> {loading ? "Opening…" : "Open"}
          </Button>
          <Button variant={edition === "SE" ? "default" : "secondary"} size="sm" onClick={() => setConvertOpen(true)} disabled={!file} title="Make a Legendary Edition copy of a Special Edition plugin">
            <ArrowLeftRight /> To LE
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setExtractOpen(true)} disabled={!file} title="Save only the records you changed as a new plugin">
            <PackageOpen /> Extract
          </Button>
          <Button size="sm" onClick={save} disabled={!file}>
            <Download /> Save
          </Button>
        </div>
      </header>

      {saveFeedback && (
        <div
          role={saveFeedback.failed ? "alert" : "status"}
          className={`flex items-start gap-2 border-b px-4 py-3 text-sm ${saveFeedback.failed ? "border-destructive bg-destructive/15" : "bg-muted"}`}
        >
          {saveFeedback.failed ? <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /> : <Download className="mt-0.5 size-4 shrink-0 text-primary" />}
          <div className="min-w-0 flex-1 break-words">
            <p className="font-medium">{saveFeedback.failed ? "Download failed" : saveFeedback.savedTo ? "Saved" : "Download requested"} — {saveFeedback.filename}</p>
            <p className="mt-1 text-muted-foreground">
              {saveFeedback.failed
                ? `The download could not be started. Your edits are still here. ${saveFeedback.detail ?? ""}`
                : saveFeedback.savedTo
                  ? `Saved to ${saveFeedback.savedTo} on your device. Your edits are still here.`
                  : "Check your browser’s Downloads or Android download notification to confirm it completed. This browser cannot confirm that the file reached your device; your edits are still here."}
            </p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={save}>
              <Download /> Try download again
            </Button>
          </div>
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setSaveFeedback(null)} aria-label="Dismiss download status">
            <X className="size-4" />
          </Button>
        </div>
      )}

      {pendingDraft && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">
            Unsaved changes from {new Date(pendingDraft.savedAt).toLocaleString()} were found for this file ({pendingDraft.records.length} edited
            {pendingDraft.deleted.length ? `, ${pendingDraft.deleted.length} deleted` : ""}).
          </span>
          <Button size="sm" onClick={restoreDraft}>Restore</Button>
          <Button size="sm" variant="secondary" onClick={discardDraft}>Discard</Button>
        </div>
      )}

      {file && (
        <div className="truncate border-b bg-muted px-4 py-1 font-mono text-xs text-muted-foreground" title={breadcrumb.join(" \\ ")}>
          {breadcrumb.length ? breadcrumb.join(" \\ ") : file.name}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 border-b border-destructive bg-destructive/15 px-4 py-2 text-sm">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      )}

      {!file ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div
            className="w-full max-w-md rounded-lg border border-dashed p-10 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void openFile(f);
            }}
          >
            <p className="font-display text-xl text-primary">Open a plugin</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Drop a .esp or .esm file here, or pick one. It never leaves your device.
            </p>
            <Button className="mt-6" onClick={() => inputRef.current?.click()} disabled={loading}>
              <FolderOpen /> {loading ? "Opening…" : "Choose file"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(360px,460px)_1fr]">
          <aside className="flex min-h-0 flex-col border-b lg:border-r lg:border-b-0">
            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                (document.activeElement as HTMLElement | null)?.blur(); // hide the keyboard to see the results
              }}
              className="flex items-center gap-2 border-b p-2"
            >
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Input
                id="flt-q"
                type="search"
                enterKeyHint="search"
                aria-label="Search records"
                placeholder="Search: bow, iron sword, 00012EB7"
                value={filterEdid}
                onChange={(e) => setFilterEdid(e.target.value)}
                className="h-8 text-sm"
              />
              <button type="submit" className="sr-only">Search</button>
            </form>
            {info.localized && (
              <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{strings ? `Names loaded (${strings.size.toLocaleString()} strings)` : "Names are stored in separate strings files."}</span>
                  <button className="font-medium text-primary underline underline-offset-2" onClick={() => stringsInputRef.current?.click()}>
                    {strings ? "Add files" : "Load strings files"}
                  </button>
                  {strings && (
                    <button className="underline underline-offset-2" onClick={forgetStrings}>
                      Forget
                    </button>
                  )}
                </div>
                {stringsMsg && <p className="mt-1 break-words">{stringsMsg}</p>}
                <input
                  ref={stringsInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void loadStringFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
              </div>
            )}
            {preparingSearch && <p className="border-b px-3 py-1 text-xs text-muted-foreground">Preparing search… large plugins take a moment the first time.</p>}
            <div className={`${TREE_COLS} border-b bg-muted px-2 py-1 text-xs font-medium text-muted-foreground`}>
              <span className="pl-5">FormID</span>
              <span>EditorID</span>
              <span>Name</span>
            </div>
            <div className="max-h-[45vh] flex-1 overflow-auto py-1 lg:max-h-none">
              {results ? (
                <>
                  <div className="flex items-center justify-between px-3 py-1 text-xs text-muted-foreground">
                    <span>{results.length >= MAX_RESULTS ? `First ${MAX_RESULTS} matches` : `${results.length} matches`}</span>
                    <button
                      onClick={() => {
                        setResults(null);
                        setFilterId("");
                        setFilterEdid("");
                      }}
                      className="text-primary hover:underline"
                    >
                      Clear filter
                    </button>
                  </div>
                  {results.slice(0, shown).map((r) => (
                    <RecordRow
                      key={r.uid}
                      record={r}
                      depth={-1}
                      selected={selected === r}
                      localized={info.localized}
                      showType
                      onSelect={() => select(r, true)}
                    />
                  ))}
                  {results.length > shown && (
                    <div className="px-3 py-2">
                      <Button variant="secondary" size="sm" onClick={() => setShown(shown + PAGE_SIZE * 2)}>
                        Show more ({results.length - shown} left)
                      </Button>
                    </div>
                  )}
                  {results.length === 0 && (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      Nothing matches “{filterEdid.trim()}”. Try fewer or shorter words, such as “bow” instead of “hunting bow”.
                    </p>
                  )}
                </>
              ) : (
                <RecordTree
                  nodes={file.nodes}
                  depth={0}
                  expanded={expanded}
                  selected={selected}
                  localized={info.localized}
                  onToggle={toggle}
                  onSelect={(r) => select(r)}
                />
              )}
            </div>
          </aside>
          <main ref={panelRef} className="min-w-0 overflow-auto">
            {selected ? (
              <RecordView
                key={selected.uid}
                file={file}
                record={selected}
                ctx={ctx}
                onChange={changed}
                onDeleted={() => {
                  setSelected(null);
                  setResults((res) => res?.filter((r) => r !== selected) ?? null);
                  changed({ reindex: true });
                }}
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">Select a record to view and edit it.</p>
            )}
          </main>
        </div>
      )}
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      {file && (
        <ChangesDialog open={changesOpen} onOpenChange={setChangesOpen} file={file} ctx={ctx} rev={rev} onRevert={revert} onGoTo={(r) => select(r, true)} />
      )}
      {file && <ExtractDialog open={extractOpen} onOpenChange={setExtractOpen} file={file} selected={selected} />}
      {file && <ConvertDialog open={convertOpen} onOpenChange={setConvertOpen} file={file} />}
      {file && <CheckDialog open={checkOpen} onOpenChange={setCheckOpen} file={file} onGoTo={(r) => select(r, true)} />}
      <SaveFolderDialog open={folderOpen} onOpenChange={setFolderOpen} />
    </div>
  );
}
