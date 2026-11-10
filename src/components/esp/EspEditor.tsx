import { useMemo, useRef, useState } from "react";
import { AlertCircle, Download, FolderOpen, PackageOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DecodeContext } from "@/lib/esp/decode";
import { downloadPlugin } from "@/lib/esp/download";
import {
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
import { ExtractDialog } from "./ExtractDialog";
import { RecordRow, RecordTree, TREE_COLS } from "./RecordTree";
import { RecordView } from "./RecordView";

const MAX_RESULTS = 500;

export function EspEditor() {
  const [file, setFile] = useState<EspFile | null>(null);
  const [selected, setSelected] = useState<EspRecord | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ failed: boolean; filename: string; detail?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
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

  async function openFile(f: File) {
    setLoading(true);
    setError(null);
    setSaveFeedback(null);
    try {
      const parsed = parseEsp(new Uint8Array(await f.arrayBuffer()), f.name);
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
      await downloadPlugin(bytes, file.name);
      setSaveFeedback({ failed: false, filename: file.name });
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

  function runFilter(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const id = filterId.trim().replace(/^0x/i, "").toUpperCase();
    const ed = filterEdid.trim().toLowerCase();
    if (!id && !ed) return setResults(null);
    const out: EspRecord[] = [];
    for (const r of walkRecords(file.nodes)) {
      if (id && !hex8(r.formId).includes(id)) continue;
      if (ed && !(getEditorId(r) ?? "").toLowerCase().includes(ed)) continue;
      out.push(r);
      if (out.length >= MAX_RESULTS) break;
    }
    setResults(out);
  }

  const breadcrumb: string[] = [];
  if (file && selected) {
    for (let g: EspGroup | null = selected.parent; g; g = g.parent) breadcrumb.unshift(describeGroup(g));
    breadcrumb.unshift(file.name);
    const e = getEditorId(selected);
    breadcrumb.push(selected.type === "TES4" ? "File Header" : `${hex8(selected.formId)}${e ? ` <${e}>` : ""}`);
  }

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-2">
        <h1 className="font-display text-lg tracking-wide text-primary">Skyrim ESP Editor</h1>
        {file && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {countRecords(file.nodes).toLocaleString()} records
            {info.masters.length > 0 && ` · masters: ${info.masters.join(", ")}`}
            {modified && <span className="ml-2 text-modified">● unsaved changes</span>}
          </span>
        )}
        <div className="ml-auto flex gap-2">
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
            <p className="font-medium">{saveFeedback.failed ? "Download failed" : "Download requested"} — {saveFeedback.filename}</p>
            <p className="mt-1 text-muted-foreground">
              {saveFeedback.failed
                ? `The download could not be started. Your edits are still here. ${saveFeedback.detail ?? ""}`
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
            <form onSubmit={runFilter} className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-2 border-b p-2 text-xs">
              <label htmlFor="flt-id" className="text-muted-foreground">FormID</label>
              <Input id="flt-id" value={filterId} onChange={(e) => setFilterId(e.target.value)} className="h-7 font-mono text-xs" />
              <label htmlFor="flt-ed" className="text-muted-foreground">Editor ID</label>
              <Input id="flt-ed" value={filterEdid} onChange={(e) => setFilterEdid(e.target.value)} className="h-7 font-mono text-xs" />
              <button type="submit" className="sr-only">Filter</button>
            </form>
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
                  {results.map((r) => (
                    <RecordRow
                      key={r.uid}
                      record={r}
                      depth={-1}
                      selected={selected === r}
                      localized={info.localized}
                      onSelect={() => select(r, true)}
                    />
                  ))}
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
      {file && <ExtractDialog open={extractOpen} onOpenChange={setExtractOpen} file={file} selected={selected} />}
    </div>
  );
}
