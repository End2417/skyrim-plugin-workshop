import { useRef, useState } from "react";
import { Download, FolderOpen, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  countRecords,
  getEditorId,
  hex8,
  parseEsp,
  searchRecords,
  serializeEsp,
  type EspFile,
  type EspGroup,
  type EspRecord,
} from "@/lib/esp/format";
import { RecordTree } from "./RecordTree";
import { RecordPanel } from "./RecordPanel";

export function EspEditor() {
  const [file, setFile] = useState<EspFile | null>(null);
  const [selected, setSelected] = useState<EspRecord | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [modified, setModified] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EspRecord[] | null>(null);
  const [, setRev] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const changed = () => {
    setModified(true);
    setRev((r) => r + 1);
  };

  async function openFile(f: File) {
    setLoading(true);
    setError(null);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const parsed = parseEsp(buf, f.name);
      setFile(parsed);
      setSelected(parsed.nodes[0] as EspRecord);
      setExpanded(new Set());
      setModified(false);
      setResults(null);
      setQuery("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function save() {
    if (!file) return;
    try {
      const bytes = serializeEsp(file);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setModified(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function select(r: EspRecord, reveal = false) {
    setSelected(r);
    if (reveal) {
      const next = new Set(expanded);
      for (let g: EspGroup | null = r.parent; g; g = g.parent) next.add(g.uid);
      setExpanded(next);
    }
    if (window.innerWidth < 1024) {
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  function toggle(uid: number) {
    const next = new Set(expanded);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setExpanded(next);
  }

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setResults(searchRecords(file, query));
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3">
        <h1 className="font-display text-lg tracking-wide text-primary">Skyrim ESP Editor</h1>
        {file && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {file.name} · {countRecords(file.nodes).toLocaleString()} records
            {modified && <span className="ml-2 text-modified">● unsaved changes</span>}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".esp,.esm,.esl"
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
          <Button size="sm" onClick={save} disabled={!file}>
            <Download /> Save
          </Button>
        </div>
      </header>

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
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(320px,420px)_1fr]">
          <aside className="flex flex-col border-b lg:h-[calc(100vh-57px)] lg:border-r lg:border-b-0">
            <form onSubmit={runSearch} className="flex gap-2 border-b p-3">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Editor ID, Form ID or type"
                className="font-mono text-sm"
              />
              <Button type="submit" size="icon" variant="secondary" aria-label="Search">
                <Search />
              </Button>
            </form>
            {results && (
              <div className="max-h-64 overflow-auto border-b">
                <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
                  <span>
                    {results.length >= 200 ? "First 200 matches" : `${results.length} matches`}
                  </span>
                  <button onClick={() => setResults(null)} className="hover:text-foreground">
                    Clear
                  </button>
                </div>
                {results.map((r) => (
                  <button
                    key={r.uid}
                    onClick={() => select(r, true)}
                    className="flex w-full gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-accent"
                  >
                    <span className="text-primary">{r.type}</span>
                    <span className="text-muted-foreground">{hex8(r.formId)}</span>
                    <span className="truncate">{getEditorId(r)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="max-h-[50vh] flex-1 overflow-auto py-1 lg:max-h-none">
              <RecordTree
                nodes={file.nodes}
                depth={0}
                expanded={expanded}
                selected={selected}
                onToggle={toggle}
                onSelect={(r) => select(r)}
              />
            </div>
          </aside>
          <main ref={panelRef} className="min-w-0 lg:h-[calc(100vh-57px)] lg:overflow-auto">
            {selected ? (
              <RecordPanel
                key={selected.uid}
                file={file}
                record={selected}
                onChange={changed}
                onDeleted={() => {
                  setSelected(null);
                  setResults((res) => res?.filter((r) => r !== selected) ?? null);
                  changed();
                }}
              />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">Select a record to view and edit it.</p>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
