import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Layers, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { aspectsOf, describeDifference } from "@/lib/esp/compare";
import { fileInfo, hex8, parseEsp, type EspFile, type EspRecord } from "@/lib/esp/format";
import { findConflicts, sortLikeTheGame, type Conflict, type LoadOrderResult } from "@/lib/esp/loadOrder";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plugin open in the editor. It is always part of the list and is used as it is now, unsaved edits included. */
  file: EspFile;
  onGoTo: (r: EspRecord) => void;
}

export function LoadOrderDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        <Form {...props} />
      </DialogContent>
    </Dialog>
  );
}

interface Item {
  id: number;
  file: EspFile;
  live: boolean;
}

const PAGE = 20;

function Form({ file, onGoTo, onOpenChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const nextId = useRef(1);
  const [items, setItems] = useState<Item[]>([{ id: 0, file, live: true }]);
  const [result, setResult] = useState<LoadOrderResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  async function add(list: File[]) {
    setBusy(true);
    setError(null);
    setResult(null);
    const added: Item[] = [];
    const problems: string[] = [];
    for (const f of list) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        added.push({ id: nextId.current++, file: parseEsp(bytes, f.name), live: false });
      } catch (e) {
        problems.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setItems((cur) => [...cur, ...added]);
    if (problems.length) setError(problems.join(" "));
    setBusy(false);
  }

  const move = (i: number, d: -1 | 1) =>
    setItems((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    setShown(PAGE);
    setOpen(new Set());
    try {
      await new Promise<void>((r) => setTimeout(r, 0));
      const r = await findConflicts(items.map((x) => x.file), () => cancelled.current);
      if (r && !cancelled.current) setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const go = (r: EspRecord) => {
    onGoTo(r);
    onOpenChange(false);
  };
  const localized = fileInfo(file).localized;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Layers className="size-5" /> Load order conflicts
        </DialogTitle>
        <DialogDescription>
          Add the plugins you load together, in load order (the last one wins). The editor shows the records that more than one of them changes. Masters such as
          Skyrim.esm do not need to be added. Nothing is changed.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        <ol className="divide-y rounded-md border">
          {items.map((it, i) => (
            <li key={it.id} className="flex items-center gap-1 px-2 py-1.5">
              <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {it.file.name}
                {it.live && <span className="ml-1 text-muted-foreground">(open)</span>}
              </span>
              <Button variant="ghost" size="icon" className="size-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${it.file.name} earlier`}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${it.file.name} later`}>
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={it.live}
                onClick={() => setItems((cur) => cur.filter((x) => x !== it))}
                aria-label={`Remove ${it.file.name}`}
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".esp,.esm,.esl,application/octet-stream"
          className="hidden"
          onChange={(e) => {
            const list = Array.from((e.target.files ?? []) as ArrayLike<File>);
            e.target.value = "";
            if (list.length) void add(list);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
            Add plugins…
          </Button>
          <Button variant="secondary" size="sm" disabled={busy || items.length < 2} onClick={() => setItems((cur) => sortLikeTheGame(cur.map((c) => c.file)).map((f) => cur.find((c) => c.file === f)!))}>
            Masters first
          </Button>
          <Button size="sm" disabled={busy || items.length < 2} onClick={() => void run()}>
            {busy ? "Working…" : "Find conflicts"}
          </Button>
        </div>
        {items.length < 2 && <p className="text-xs text-muted-foreground">Add at least one more plugin to compare with {file.name}.</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}

        {result && (
          <div className="space-y-3">
            <p className="font-medium">
              {result.counts.conflicts.toLocaleString()} conflicting record{result.counts.conflicts === 1 ? "" : "s"}
              <span className="font-normal text-muted-foreground"> · {result.identical.toLocaleString()} changed the same way by several plugins</span>
            </p>
            <ul className="divide-y rounded-md border text-xs">
              {result.byPlugin.map((p) => (
                <li key={p.plugin} className="flex flex-wrap items-center gap-x-3 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono">{p.plugin}</span>
                  <span>wins {p.wins.toLocaleString()}</span>
                  <span>loses {p.loses.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <ul className="space-y-2">
              {result.conflicts.slice(0, shown).map((c, i) => (
                <ConflictRow key={i} c={c} open={open.has(i)} onToggle={() => setOpen((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set(s).add(i)))} localized={localized} openName={file.name} onGoTo={go} />
              ))}
            </ul>
            {result.conflicts.length > shown && (
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </Button>
            )}
            {result.truncated && <p className="text-xs text-muted-foreground">Only the first {result.conflicts.length.toLocaleString()} are listed; the counts above are complete.</p>}
          </div>
        )}
      </div>
    </>
  );
}

function ConflictRow({ c, open, onToggle, localized, openName, onGoTo }: { c: Conflict; open: boolean; onToggle: () => void; localized: boolean; openName: string; onGoTo: (r: EspRecord) => void }) {
  return (
    <li className="rounded-md border">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-2 px-2 py-1.5 text-left">
        <span className="min-w-0 flex-1 break-words font-mono text-xs">
          {c.type} {hex8(c.formId)} {c.editorId ?? ""}
        </span>
        <span className="text-xs text-muted-foreground">
          {c.winner.plugin} wins · {c.overwritten} overwritten
        </span>
      </button>
      {open && (
        <ul className="space-y-2 border-t px-2 py-2 text-xs">
          {c.entries.map((e) => {
            const detail = e.differs ? describeDifference({ kind: "changed", type: c.type, formId: e.record.formId, editorId: c.editorId, mine: c.winner.record, theirs: e.record, what: aspectsOf(e.record, c.winner.record) }, localized) : [];
            return (
              <li key={e.order}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {e.order + 1}. {e.plugin} {e.defines ? "(defines)" : "(changes)"}
                    {e === c.winner ? " · winner" : e.differs ? " · overwritten" : " · same as the winner"}
                  </span>
                  {e.plugin === openName && (
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onGoTo(e.record)}>
                      Go to
                    </Button>
                  )}
                </div>
                {detail.length > 0 && (
                  <ul className="mt-1 space-y-0.5 pl-4 text-muted-foreground">
                    {detail.map((d, k) => (
                      <li key={k} className="break-words">
                        {d.label}: {d.before} → <span className="text-foreground">{d.after}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
