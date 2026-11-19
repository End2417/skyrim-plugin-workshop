import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CircleX, GitMerge, Info, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { SIGNATURE_NAMES } from "@/lib/esp/defs";
import { KNOWN_PLUGINS, findPluginsByName, scanSkyrimFolder, type FolderItem } from "@/lib/esp/skyrimFolder";
import { listFolder, nativeFilesAvailable, readFolderFile, usableSkyrimFolder } from "@/lib/native/espFiles";
import { downloadPlugin } from "@/lib/esp/download";
import { countRecords, fileInfo, getEditorId, hex8, parseEsp, type EspFile } from "@/lib/esp/format";
import {
  buildMerged,
  mergedFileName,
  planMerge,
  sliceOriginal,
  sortByDependencies,
  type MergeAction,
  type MergeConflict,
  type MergeIssue,
  type MergeOptions,
  type MergePlan,
  type MergeResult,
  type OriginalSource,
  type PlanEntry,
} from "@/lib/esp/mergePlugins";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plugin open in the editor, if any. It starts in the list, as it is now (unsaved edits included), and can be taken out. */
  file?: EspFile | null;
}

export function MergeDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl">
        {/* Mounted only while open, so a closed dialog never keeps working. */}
        <Form {...props} />
      </DialogContent>
    </Dialog>
  );
}

interface Item {
  id: number;
  file: EspFile;
  live: boolean;
  records: number;
  masters: number;
}

/** The plugins in the Skyrim Data folder, and everything else in it. */
interface GameFolder {
  plugins: FolderItem[];
  all: FolderItem[];
}

const PAGE = 30;
const nf = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`;
const typeName = (t: string) => (SIGNATURE_NAMES[t] ? `${SIGNATURE_NAMES[t]} (${t})` : t);

/** What happens to one record, in words. */
function actionText(e: PlanEntry): string {
  switch (e.action) {
    case "new":
      return "new record";
    case "override":
      return e.origin ? `changes a record of ${e.origin}` : "changes a record of another plugin in this merge";
    case "wins":
      return e.origin ? `this version is kept (changes a record of ${e.origin})` : "this version is kept";
    case "lost":
      return "not used: another plugin's version is kept";
    case "merged":
      return e.defines ? "made here, other plugins' changes are combined in" : "its changes are combined with the other plugins' changes";
  }
}

function itemOf(id: number, file: EspFile, live: boolean): Item {
  return { id, file, live, records: Math.max(0, countRecords(file.nodes) - 1), masters: fileInfo(file).masters.length };
}

function Form({ file, onOpenChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const originalsRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const token = useRef(0);
  const nextId = useRef(1);

  const [items, setItems] = useState<Item[]>(() => (file ? [itemOf(0, file, true)] : []));
  const [outName, setOutName] = useState("Merged.esp");
  const [asMaster, setAsMaster] = useState(false);
  const [rewriteUnknown, setRewriteUnknown] = useState(true);
  const [combine, setCombine] = useState(true);
  const [originals, setOriginals] = useState<Item[]>([]);
  const [autoOriginals, setAutoOriginals] = useState(true);
  const [choose, setChoose] = useState<Record<string, number>>({});
  /** The plugins in the Skyrim folder the person gave access to, when there is one. */
  const [game, setGame] = useState<GameFolder | null>(null);
  /**
   * Original plugins already read from the Skyrim folder, kept while this dialog is open so a new preview does not read
   * them again. Only the records that were compared are kept (a parsed Skyrim.esm would take hundreds of MB of a phone's
   * memory), together with which records those are, so a later merge that needs others reads the file again.
   */
  const readOriginals = useRef(new Map<string, { file: EspFile; keys: Set<string> }>());

  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [built, setBuilt] = useState<MergeResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!nativeFilesAvailable()) return;
    void (async () => {
      try {
        const folder = await usableSkyrimFolder();
        if (!folder) return;
        const found = await scanSkyrimFolder((path) => listFolder(folder, path));
        if (!found || !alive.current) return;
        const plugins = found.dataEntries
          .filter((e) => !e.dir && isPluginFile(e.name))
          .sort((a, b) => knownRank(a.name) - knownRank(b.name) || a.name.localeCompare(b.name));
        setGame({ plugins, all: found.dataEntries });
      } catch {
        /* the folder is optional: picking files still works */
      }
    })();
  }, []);

  /** Reads the original plugins a merge needs from the Skyrim folder, without the person having to add them. */
  const originalSource: OriginalSource = async (needed, masters, say, keys) => {
    if (!game) return [];
    const byName = new Map(game.plugins.map((e) => [e.name.toLowerCase(), e]));
    const want = new Set(needed.map((n) => n.toLowerCase()));
    // Update.esm changes many records of Skyrim.esm, so mods made with it loaded are built on its version
    if (want.has("skyrim.esm")) want.add("update.esm");
    for (const m of masters) if (KNOWN_PLUGINS.some((k) => k.toLowerCase() === m.toLowerCase())) want.add(m.toLowerCase());
    const out: EspFile[] = [];
    for (const name of want) {
      const entry = byName.get(name);
      if (!entry) continue;
      const have = readOriginals.current.get(name);
      if (have && [...keys].every((k) => have.keys.has(k))) {
        out.push(have.file);
        continue;
      }
      say(`Reading ${entry.name} from your Skyrim folder. Large files take a while the first time`);
      await new Promise<void>((r) => setTimeout(r, 0));
      // the whole file is parsed once and then dropped: only the records that are compared stay
      const covered = new Set([...keys, ...(have?.keys ?? [])]);
      const slim = sliceOriginal(parseEsp(await readFolderFile(entry), entry.name), covered);
      readOriginals.current.set(name, { file: slim, keys: covered });
      out.push(slim);
    }
    return out;
  };

  const busy = planning || building || loading;

  /** Anything that changes what would be merged throws the preview away (and stops one that is running). */
  const invalidate = (resetChoices = false) => {
    // Choices of whose version to use are stored by plugin position and record, so they only mean something for the same list
    if (resetChoices) setChoose({});
    token.current++;
    setPlan(null);
    setBuilt(null);
    setStatus(null);
    setPlanning(false);
    setProgress(null);
  };

  const taken = () => new Set([...items, ...originals].map((x) => x.file.name.toLowerCase()));

  /** Puts what was read in the list (or the originals), keeping plugins after the ones they need. */
  function finishAdd(added: Item[], problems: string[], asOriginals: boolean) {
    if (!alive.current) return;
    if (asOriginals) setOriginals((cur) => [...cur, ...added]);
    else
      setItems((cur) => {
        const all = [...cur, ...added];
        return sortByDependencies(all.map((x) => x.file)).map((f) => all.find((x) => x.file === f)!);
      });
    if (problems.length) setError(problems.join(" "));
    setLoading(false);
    setProgress(null);
  }

  async function add(list: File[], asOriginals = false) {
    setLoading(true);
    setError(null);
    invalidate(!asOriginals);
    const seen = taken();
    const added: Item[] = [];
    const problems: string[] = [];
    for (const f of list) {
      if (seen.has(f.name.toLowerCase())) continue;
      seen.add(f.name.toLowerCase());
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        added.push(itemOf(nextId.current++, parseEsp(bytes, f.name), false));
      } catch (e) {
        problems.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    finishAdd(added, problems, asOriginals);
  }

  /** Reads plugins from the Skyrim folder the person gave access to. */
  async function addFromFolder(entries: FolderItem[], asOriginals: boolean) {
    setLoading(true);
    setError(null);
    invalidate(!asOriginals);
    const seen = taken();
    const added: Item[] = [];
    const problems: string[] = [];
    const todo = entries.filter((f) => !seen.has(f.name.toLowerCase()));
    for (let i = 0; i < todo.length; i++) {
      const f = todo[i]!;
      if (!alive.current) return;
      setProgress({ fraction: i / todo.length, label: `Reading ${f.name} (${i + 1} of ${todo.length})` });
      await new Promise<void>((r) => setTimeout(r, 0));
      try {
        added.push(itemOf(nextId.current++, parseEsp(await readFolderFile(f), f.name), false));
      } catch (e) {
        problems.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    finishAdd(added, problems, asOriginals);
  }

  const move = (i: number, d: -1 | 1) => {
    invalidate(true);
    setItems((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };

  const options = (picked: Record<string, number>): MergeOptions => ({
    outputName: outName,
    rewriteUnknown,
    combine,
    choose: picked,
    originals: originals.map((x) => x.file),
    ...(game && autoOriginals ? { originalSource } : {}),
    ...(asMaster ? { esm: true } : {}),
  });

  async function runPlan(picked: Record<string, number> = choose) {
    const mine = ++token.current;
    setPlanning(true);
    setError(null);
    setBuilt(null);
    setStatus(null);
    setProgress({ fraction: 0, label: "Reading the plugins" });
    try {
      await new Promise<void>((r) => setTimeout(r, 0));
      const p = await planMerge(
        items.map((x) => x.file),
        options(picked),
        { cancelled: () => !alive.current || token.current !== mine, progress: (fraction, label) => token.current === mine && setProgress({ fraction, label }) },
      );
      if (p && alive.current && token.current === mine) setPlan(p);
    } catch (e) {
      if (alive.current && token.current === mine) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current && token.current === mine) {
        setPlanning(false);
        setProgress(null);
      }
    }
  }

  async function build() {
    if (!plan) return;
    const mine = ++token.current;
    setBuilding(true);
    setError(null);
    setStatus(null);
    setProgress({ fraction: 0.6, label: "Building" });
    try {
      await new Promise<void>((r) => setTimeout(r, 0));
      const r = await buildMerged(
        items.map((x) => x.file),
        plan,
        { cancelled: () => !alive.current || token.current !== mine, progress: (fraction, label) => token.current === mine && setProgress({ fraction, label }) },
        outName,
      );
      if (r && alive.current && token.current === mine) setBuilt(r);
    } catch (e) {
      if (alive.current && token.current === mine) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current && token.current === mine) {
        setBuilding(false);
        setProgress(null);
      }
    }
  }

  async function save() {
    if (!built) return;
    try {
      const savedTo = await downloadPlugin(built.bytes, built.name);
      const renamed = !!savedTo && !savedTo.toLowerCase().endsWith(`/${built.name.toLowerCase()}`);
      setStatus({
        ok: true,
        message:
          `${savedTo ? `Saved to ${savedTo}` : `${built.name} was handed to your device`} (${(built.bytes.length / 1024).toFixed(1)} KB).` +
          `${savedTo ? "" : " This app cannot confirm where it was saved."}` +
          `${renamed ? ` A file named ${built.name} already existed and is never overwritten, so replace the old one with this copy.` : ""}` +
          " Put it in Skyrim's Data folder and disable the plugins it was merged from.",
      });
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const names = items.map((x) => x.file.name);
  const finalName = mergedFileName(outName, plan?.esm ?? asMaster);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <GitMerge className="size-5" /> Merge plugins
        </DialogTitle>
        <DialogDescription>
          Combines several plugins into one new plugin. You do not need to open a plugin first: pick the ones to merge (several at once), and put them in load order, because the
          last one wins where plugins disagree. The preview shows everything that goes in before anything is written, and the plugins you add are not changed.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 text-sm">
        <section className="space-y-2">
          {items.length === 0 && <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No plugins yet. Add the plugins you want to merge, several at once if you like.</p>}
          <ol className={items.length === 0 ? "hidden" : "divide-y rounded-md border"}>
            {items.map((it, i) => (
              <li key={it.id} className="flex items-center gap-1 px-2 py-1.5">
                <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">
                    {it.file.name}
                    {it.live && <span className="ml-1 text-muted-foreground">(open)</span>}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {plural(it.records, "record")} · {plural(it.masters, "master")}
                  </span>
                </span>
                <Button variant="ghost" size="icon" className="size-7" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${it.file.name} earlier`}>
                  <ArrowUp />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" disabled={busy || i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${it.file.name} later`}>
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={busy}
                  onClick={() => {
                    invalidate(true);
                    setItems((cur) => cur.filter((x) => x !== it));
                  }}
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
            <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()} title="Pick one or more plugin files">
              Add plugins…
            </Button>
            {file && !items.some((x) => x.file === file) && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  invalidate(true);
                  setItems((cur) => [...cur, itemOf(nextId.current++, file, true)]);
                }}
                title="Use the plugin that is open in the editor, with your unsaved edits"
              >
                Add {file.name} (open)
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || items.length < 2}
              title="Put every plugin after the plugins it needs"
              onClick={() => {
                invalidate(true);
                setItems((cur) => sortByDependencies(cur.map((c) => c.file)).map((f) => cur.find((c) => c.file === f)!));
              }}
            >
              Sort by what needs what
            </Button>
          </div>
          <GamePicker game={game} taken={taken()} busy={busy} combine={combine} onAdd={(entries, asOriginals) => void addFromFolder(entries, asOriginals)} />
          {items.length < 2 && <p className="text-xs text-muted-foreground">{items.length === 0 ? "Pick at least two plugins to merge." : "Add at least one more plugin to merge with."}</p>}
        </section>

        <section className="space-y-2">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={combine}
              onCheckedChange={(v) => {
                invalidate();
                setCombine(v === true);
              }}
              className="mt-0.5"
            />
            <span>
              Combine changes that different plugins make to the same record
              <span className="block text-xs text-muted-foreground">
                For example one mod gives an NPC a sword and another gives the same NPC armor: the NPC gets both. Without this, only one whole copy of such a record is kept.
              </span>
            </span>
          </label>
          {combine && (
            <div className="space-y-2 rounded-md border p-2">
              <p className="text-xs">
                <span className="font-medium">Original plugins.</span> To tell what each mod changed in a record that comes from the game, the original is needed. They are only read; nothing from them is copied
                into the merged plugin. Records one of the merged plugins makes itself need no original.
              </p>
              {game ? (
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={autoOriginals}
                    onCheckedChange={(v) => {
                      invalidate();
                      setAutoOriginals(v === true);
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    Read the originals from my Skyrim folder when they are needed
                    <span className="block text-muted-foreground">Skyrim.esm and the plugins that patch it (Update.esm) are read by themselves, only if plugins change the same record. Reading Skyrim.esm takes a while on a phone the first time.</span>
                  </span>
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Give the app access to your Skyrim folder (the folder button at the top) and it reads Skyrim.esm and the other game plugins by itself. Until then, add them yourself, Skyrim.esm and
                  Update.esm, Dawnguard.esm and so on if the mods build on them.
                </p>
              )}
              {originals.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {originals.map((it) => (
                    <li key={it.id} className="flex items-center gap-1 px-2 py-1">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{it.file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{plural(it.records, "record")}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={busy}
                        onClick={() => {
                          invalidate();
                          setOriginals((cur) => cur.filter((x) => x !== it));
                        }}
                        aria-label={`Remove ${it.file.name}`}
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                ref={originalsRef}
                type="file"
                multiple
                accept=".esp,.esm,.esl,application/octet-stream"
                className="hidden"
                onChange={(e) => {
                  const list = Array.from((e.target.files ?? []) as ArrayLike<File>);
                  e.target.value = "";
                  if (list.length) void add(list, true);
                }}
              />
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => originalsRef.current?.click()}>
                Add originals yourself…
              </Button>
            </div>
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
          <label htmlFor="merge-name" className="text-xs font-medium">
            Name of the merged plugin
          </label>
          <Input id="merge-name" value={outName} onChange={(e) => setOutName(e.target.value)} className="h-8 font-mono text-xs" spellCheck={false} autoCapitalize="off" disabled={building} />
          <label className="flex items-start gap-2 sm:col-span-2">
            <Checkbox
              checked={asMaster}
              onCheckedChange={(v) => {
                invalidate();
                setAsMaster(v === true);
              }}
              className="mt-0.5"
            />
            <span>
              Flag it as a master (ESM)
              <span className="block text-xs text-muted-foreground">Done automatically when every plugin is a master. Leave off for ordinary mods.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 sm:col-span-2">
            <Checkbox
              checked={rewriteUnknown}
              onCheckedChange={(v) => {
                invalidate();
                setRewriteUnknown(v === true);
              }}
              className="mt-0.5"
            />
            <span>
              Also fix references in fields the editor cannot read
              <span className="block text-xs text-muted-foreground">
                Where a value there clearly points at one of the plugin's own records (some condition parameters, for example), it is renumbered with the record.
              </span>
            </span>
          </label>
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || items.length < 2} onClick={() => void runPlan()}>
            {planning ? "Working…" : plan ? "Preview again" : "Preview the merge"}
          </Button>
          {plan && (
            <Button size="sm" disabled={busy || !plan.ok || !!built} onClick={() => void build()} title={plan.ok ? "Build the merged plugin" : "Fix the problems above first"}>
              {building ? "Merging…" : `Merge into ${finalName}`}
            </Button>
          )}
        </div>

        {progress && (
          <div className="space-y-1" role="status">
            <Progress value={Math.round(progress.fraction * 100)} className="h-2" />
            <p className="text-xs text-muted-foreground">{progress.label}…</p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}

        {plan && (
          <Preview
            plan={plan}
            names={names}
            busy={busy}
            finalName={finalName}
            folder={game ? (autoOriginals ? "auto" : "off") : "none"}
            onChoose={(id, input) => {
              const next = { ...choose, [id]: input };
              setChoose(next);
              void runPlan(next);
            }}
          />
        )}

        {built && (
          <Built
            built={built}
            combined={plan?.counts.combined ?? 0}
            status={status}
            onSave={() => void save()}
            onClose={() => onOpenChange(false)}
          />
        )}
      </div>
    </>
  );
}

// ---------- picking from the Skyrim folder ----------

const isPluginFile = (name: string) => /\.(esp|esm|esl)$/i.test(name);
const knownRank = (name: string) => {
  const i = KNOWN_PLUGINS.findIndex((m) => m.toLowerCase() === name.toLowerCase());
  return i < 0 ? KNOWN_PLUGINS.length : i;
};

/**
 * A checklist of the plugins in the Skyrim Data folder the person gave access to (Save folder button), so a whole set can
 * be ticked and added at once. Nothing shows when that folder is not set up or this is not the Android app.
 */
function GamePicker({
  game,
  taken,
  busy,
  combine,
  onAdd,
}: {
  game: GameFolder | null;
  taken: Set<string>;
  busy: boolean;
  combine: boolean;
  onAdd: (entries: FolderItem[], asOriginals: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  if (!game) return null;

  const q = query.trim().toLowerCase();
  const shown = game.plugins.filter((e) => !q || e.name.toLowerCase().includes(q));
  const chosen = game.plugins.filter((e) => ticked.has(e.uri));
  const toggle = (uri: string) =>
    setTicked((cur) => {
      const next = new Set(cur);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });

  return (
    <div className="space-y-2 rounded-md border p-2">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide Skyrim folder" : "Choose from the Skyrim folder…"}
      </Button>
      {open && (
        <div className="space-y-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter plugins" className="h-8 text-xs" spellCheck={false} autoCapitalize="off" aria-label="Filter the plugins in the Skyrim folder" />
          <ul className="max-h-64 divide-y overflow-auto rounded-md border">
            {shown.slice(0, 300).map((e) => {
              const already = taken.has(e.name.toLowerCase());
              return (
                <li key={e.uri}>
                  <label className={`flex items-center gap-2 px-2 py-1.5 text-xs ${already ? "opacity-50" : ""}`}>
                    <Checkbox checked={already || ticked.has(e.uri)} disabled={already || busy} onCheckedChange={() => toggle(e.uri)} />
                    <span className="min-w-0 flex-1 break-all font-mono">{e.name}</span>
                    <span className="shrink-0 text-muted-foreground">{already ? "added" : `${(e.size / 1048576).toFixed(e.size > 10485760 ? 0 : 1)} MB`}</span>
                  </label>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground">No plugins match.</li>}
          </ul>
          {shown.length > 300 && <p className="text-xs text-muted-foreground">Showing the first 300. Use the filter to find others.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || chosen.length === 0}
              onClick={() => {
                onAdd(chosen, false);
                setTicked(new Set());
              }}
            >
              Add {chosen.length > 0 ? plural(chosen.length, "plugin") : "selected"} to merge
            </Button>
            {combine && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || chosen.length === 0}
                onClick={() => {
                  onAdd(chosen, true);
                  setTicked(new Set());
                }}
                title="Only needed for plugins other than the game's own, which are read by themselves"
              >
                Add as originals
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- preview ----------

function IssueList({ issues, names }: { issues: MergeIssue[]; names: string[] }) {
  if (issues.length === 0) return null;
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...issues].sort((a, b) => rank[a.level] - rank[b.level]);
  return (
    <ul className="space-y-1.5">
      {sorted.map((i, n) => (
        <li key={n} className="flex items-start gap-2 text-xs">
          {i.level === "error" ? (
            <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Problem" />
          ) : i.level === "warning" ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Note" />
          )}
          <span className={i.level === "error" ? "text-destructive" : undefined}>
            {i.input !== undefined && i.input < names.length && !i.message.includes(names[i.input]!) && <span className="font-mono">{names[i.input]}: </span>}
            {i.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Preview({ plan, names, busy, finalName, folder, onChoose }: { plan: MergePlan; names: string[]; busy: boolean; finalName: string; folder: "auto" | "off" | "none"; onChoose: (conflictId: string, input: number) => void }) {
  const c = plan.counts;
  return (
    <div className="space-y-4 border-t pt-4">
      <div className="space-y-1">
        <h3 className="font-medium">What goes into {finalName}</h3>
        <p>
          {plural(c.records, "record")}: {plural(c.added, "new record")} made by the plugins and {plural(c.overrides, "change")} to records of masters.
        </p>
        {c.conflicts > 0 && (
          <p>
            {plural(c.conflicts, "record")} {c.conflicts === 1 ? "is" : "are"} in more than one plugin
            {c.identical > 0 ? ` (${nf(c.identical)} the same in every plugin)` : ""}.
            {c.combined > 0 && ` ${nf(c.combined)} ${c.combined === 1 ? "was" : "were"} combined, so each plugin's changes are kept.`}
            {c.collisions > 0 && ` In ${plural(c.collisions, "place")} two plugins change the same field differently; the later plugin's value is used unless you pick another.`}
            {c.unmerged > 0 && ` ${nf(c.unmerged)} could not be combined, so one whole version of ${c.unmerged === 1 ? "it is" : "each is"} kept (${plural(c.dropped, "copy", "copies")} left out).`}
          </p>
        )}
        {c.renumbered > 0 && (
          <p>
            {plural(c.renumbered, "record")} got a new FormID because another plugin already used the same one. References to {c.renumbered === 1 ? "it are" : "them are"} updated.
          </p>
        )}
      </div>

      <IssueList issues={plan.issues} names={names} />
      {plan.conflicts.some((x) => x.needs) && folder !== "auto" && (
        <p className="text-xs text-muted-foreground">
          {folder === "off"
            ? "Turn on reading the originals from your Skyrim folder above, and run the preview again."
            : "Give the app access to your Skyrim folder (the folder button at the top) and it reads the originals by itself, or add them yourself above."}
        </p>
      )}

      {plan.originals.length > 0 && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">Originals used to tell what each plugin changed ({plan.originals.length})</summary>
          <ul className="divide-y border-t text-xs">
            {plan.originals.map((o) => (
              <li key={o.name} className="flex flex-wrap gap-x-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 break-all font-mono">{o.name}</span>
                <span className="text-muted-foreground">
                  {plural(o.used, "record")} compared{o.auto ? ", read from your Skyrim folder" : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="rounded-md border">
        <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">Masters of the merged plugin ({plan.masters.length})</summary>
        <ol className="divide-y border-t text-xs">
          {plan.masters.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">None.</li>}
          {plan.masters.map((m, i) => (
            <li key={m.name} className="flex flex-wrap gap-x-2 px-2 py-1.5">
              <span className="w-6 shrink-0 text-right font-mono text-muted-foreground">{i}</span>
              <span className="min-w-0 flex-1 break-all font-mono">{m.name}</span>
              <span className="text-muted-foreground">needed by {m.usedBy.map((u) => names[u]).join(", ")}</span>
            </li>
          ))}
        </ol>
        <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
          The plugins being merged are not listed: their records are inside the new plugin.
        </p>
      </details>

      <PluginCards plan={plan} />
      {plan.conflicts.length > 0 && <Conflicts plan={plan} names={names} busy={busy} onChoose={onChoose} />}
      <Records plan={plan} names={names} />
    </div>
  );
}

function PluginCards({ plan }: { plan: MergePlan }) {
  const byInput = useMemo(() => {
    const out = plan.inputs.map(() => new Map<string, { total: number; used: number }>());
    for (const e of plan.entries) {
      const m = out[e.input]!;
      const row = m.get(e.type) ?? { total: 0, used: 0 };
      row.total++;
      if (e.included) row.used++;
      m.set(e.type, row);
    }
    return out.map((m) => [...m].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])));
  }, [plan]);

  return (
    <div className="space-y-2">
      <h3 className="font-medium">By plugin</h3>
      <ul className="space-y-2">
        {plan.inputs.map((inf) => (
          <li key={inf.index} className="rounded-md border">
            <details>
              <summary className="cursor-pointer space-y-0.5 px-2 py-1.5">
                <span className="block break-all font-mono text-xs">
                  {inf.index + 1}. {inf.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  makes {nf(inf.defines)} · changes {nf(inf.overrides)}
                  {inf.renumbered > 0 && ` · ${nf(inf.renumbered)} renumbered`}
                  {inf.navmeshes > 0 && ` · ${nf(inf.navmeshes)} navigation`}
                </span>
              </summary>
              <table className="w-full border-t text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1 font-normal">Record type</th>
                    <th className="px-2 py-1 text-right font-normal">Records</th>
                    <th className="px-2 py-1 text-right font-normal">Used</th>
                  </tr>
                </thead>
                <tbody>
                  {byInput[inf.index]!.map(([type, row]) => (
                    <tr key={type} className="border-t">
                      <td className="px-2 py-1">{typeName(type)}</td>
                      <td className="px-2 py-1 text-right font-mono">{nf(row.total)}</td>
                      <td className="px-2 py-1 text-right font-mono">{nf(row.used)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Conflicts({ plan, names, busy, onChoose }: { plan: MergePlan; names: string[]; busy: boolean; onChoose: (conflictId: string, input: number) => void }) {
  const [onlyDifferent, setOnlyDifferent] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const list = useMemo(() => (onlyDifferent ? plan.conflicts.filter((x) => !x.identical) : plan.conflicts), [plan, onlyDifferent]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3">
        <h3 className="font-medium">Records several plugins change</h3>
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox
            checked={onlyDifferent}
            onCheckedChange={(v) => {
              setOnlyDifferent(v === true);
              setShown(PAGE);
            }}
          />
          only where they differ
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Where plugins change the same field differently, the last plugin in the list wins. Tap another plugin to use its value instead.
      </p>
      {list.length === 0 && <p className="text-xs text-muted-foreground">Every copy of these records is the same, so nothing is lost.</p>}
      <ul className="space-y-2">
        {list.slice(0, shown).map((cf) => (
          <ConflictRow key={cf.id} cf={cf} names={names} busy={busy} onChoose={onChoose} />
        ))}
      </ul>
      {list.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>
          Show more ({nf(list.length - shown)} left)
        </Button>
      )}
    </div>
  );
}

function ConflictRow({ cf, names, busy, onChoose }: { cf: MergeConflict; names: string[]; busy: boolean; onChoose: (conflictId: string, input: number) => void }) {
  const winnerRecord = cf.entries.find((e) => e.input === cf.winner)!.record;
  const combined = cf.status === "combined";
  const askWhich = !combined || cf.collisions > 0;
  const shortList = (fields: string[]) => (fields.length > 6 ? `${fields.slice(0, 6).join(", ")} and ${fields.length - 6} more` : fields.join(", "));
  return (
    <li className="space-y-1 rounded-md border px-2 py-1.5 text-xs">
      <p className="break-words font-mono">
        {cf.type} {hex8(cf.newFormId)} {getEditorId(winnerRecord) ?? ""}
      </p>
      <p className={combined ? "text-modified" : "text-warning"}>
        {cf.identical ? "Every plugin has the same copy." : combined ? (cf.collisions > 0 ? "Combined, with a collision." : "Combined: each plugin's changes are kept.") : "Not combined: one whole version is kept."}
      </p>
      {combined &&
        !cf.identical &&
        cf.changes
          .filter((c) => c.fields.length > 0)
          .map((c) => (
            <p key={c.input} className="break-words text-muted-foreground">
              <span className="font-mono">{names[c.input]}</span> changes {shortList(c.fields)}
            </p>
          ))}
      {cf.collisions > 0 && (
        <p className="break-words text-warning">
          Both change {shortList(cf.collided)}. {names[cf.winner]}'s value is used.
        </p>
      )}
      {!combined && cf.reason && <p className="break-words text-muted-foreground">{cf.reason}</p>}
      {askWhich && !cf.identical && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-muted-foreground">{combined ? "Where they collide, use:" : "Keep the version from:"}</span>
          {cf.entries.map((e) => {
            const keeps = e.input === cf.winner;
            return (
              <Button
                key={e.input}
                variant={keeps ? "default" : "secondary"}
                size="sm"
                className="h-7 max-w-full px-2 text-xs"
                disabled={busy || keeps}
                aria-pressed={keeps}
                onClick={() => onChoose(cf.id, e.input)}
                title={keeps ? "This plugin's value is used" : `Use the value from ${names[e.input]}`}
              >
                <span className="truncate">
                  {keeps ? "✓ " : ""}
                  {names[e.input]}
                </span>
              </Button>
            );
          })}
        </div>
      )}
    </li>
  );
}

type ActionFilter = "all" | MergeAction | "renumbered";

function Records({ plan, names }: { plan: MergePlan; names: string[] }) {
  const [input, setInput] = useState<number | "all">("all");
  const [action, setAction] = useState<ActionFilter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plan.entries.filter((e) => {
      if (input !== "all" && e.input !== input) return false;
      if (action === "renumbered" ? !e.renumbered : action !== "all" && e.action !== action) return false;
      if (!q) return true;
      return e.type.toLowerCase() === q || hex8(e.oldFormId).toLowerCase().includes(q) || hex8(e.newFormId).toLowerCase().includes(q) || (getEditorId(e.record) ?? "").toLowerCase().includes(q);
    });
  }, [plan, input, action, query]);

  const reset = () => setShown(PAGE);
  const select = "h-8 min-w-0 rounded-md border bg-background px-2 text-xs";
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Every record</h3>
      <div className="flex flex-wrap gap-2">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            reset();
          }}
          placeholder="Search Editor ID, FormID or type" className="h-8 min-w-40 flex-1 text-xs" spellCheck={false} autoCapitalize="off" aria-label="Search records" />
        <select
          className={select}
          value={String(input)}
          onChange={(e) => {
            setInput(e.target.value === "all" ? "all" : Number(e.target.value));
            reset();
          }}
          aria-label="Plugin"
        >
          <option value="all">All plugins</option>
          {names.map((n, i) => (
            <option key={i} value={i}>
              {n}
            </option>
          ))}
        </select>
        <select
          className={select}
          value={action}
          onChange={(e) => {
            setAction(e.target.value as ActionFilter);
            reset();
          }}
          aria-label="What happens to the record"
        >
          <option value="all">Everything</option>
          <option value="new">New records</option>
          <option value="override">Changes to masters</option>
          <option value="renumbered">Renumbered</option>
          <option value="merged">Combined from several plugins</option>
          <option value="wins">Version kept (not combined)</option>
          <option value="lost">Not used (not combined)</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">{plural(filtered.length, "record")}</p>
      <ul className="divide-y rounded-md border">
        {filtered.slice(0, shown).map((e, i) => (
          <RecordRow key={i} e={e} name={names[e.input]!} />
        ))}
        {filtered.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground">Nothing matches.</li>}
      </ul>
      {filtered.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE * 2)}>
          Show more ({nf(filtered.length - shown)} left)
        </Button>
      )}
    </div>
  );
}

function RecordRow({ e, name }: { e: PlanEntry; name: string }) {
  const moved = e.oldFormId !== e.newFormId && e.origin === "";
  return (
    <li className={`px-2 py-1.5 text-xs ${e.included ? "" : "text-muted-foreground"}`}>
      <p className="break-words">
        <span className="font-mono">{e.type}</span> {getEditorId(e.record) ?? "(no Editor ID)"}
      </p>
      <p className="break-words font-mono text-muted-foreground">
        {moved ? `${hex8(e.oldFormId)} → ` : ""}
        <span className={e.renumbered ? "text-warning" : undefined}>{hex8(e.newFormId)}</span>
      </p>
      <p className="break-words text-muted-foreground">
        {name} · {actionText(e)}
      </p>
    </li>
  );
}

// ---------- result ----------

function Built({ built, combined, status, onSave, onClose }: { built: MergeResult; combined: number; status: { ok: boolean; message: string } | null; onSave: () => void; onClose: () => void }) {
  const r = built.report;
  const v = r.verification;
  const clean = v.problems === 0 && v.duplicates === 0;
  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="font-medium">{built.name} is ready</h3>
      <p>
        {plural(r.records, "record")} and {plural(r.groups, "group")}, {(built.bytes.length / 1024).toFixed(1)} KB. {plural(r.refsRewritten + r.scriptRefsRewritten + r.unknownRewritten, "reference")} renumbered
        {r.scriptRecords > 0 ? ` (${plural(r.scriptRefsRewritten, "script reference")} in ${plural(r.scriptRecords, "record")} that carry scripts)` : ""}.
        {combined > 0 ? ` ${plural(combined, "record")} combine${combined === 1 ? "s" : ""} changes from several plugins.` : ""}
      </p>
      <p className={clean ? "text-modified" : "text-warning"}>
        {clean
          ? `Checked: all ${nf(v.records)} records read back, every FormID is used once, and no reference points at a missing record or master.`
          : `Checked: ${v.problems > 0 ? `${plural(v.problems, "problem")} found` : ""}${v.problems > 0 && v.duplicates > 0 ? " and " : ""}${v.duplicates > 0 ? `${plural(v.duplicates, "duplicate FormID")}` : ""}.`}
      </p>
      {v.examples.length > 0 && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">Examples</summary>
          <ul className="space-y-1 border-t px-2 py-1.5 text-xs">
            {v.examples.map((x, i) => (
              <li key={i} className="break-words">
                {x}
              </li>
            ))}
          </ul>
          <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">Problems that already existed in the plugins you merged show up here too.</p>
        </details>
      )}
      {r.unreadableScripts.length > 0 && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">Records whose script data could not be read ({r.unreadableScripts.length})</summary>
          <ul className="space-y-1 border-t px-2 py-1.5 text-xs">
            {r.unreadableScripts.slice(0, 30).map((x, i) => (
              <li key={i} className="break-words">
                {x}
              </li>
            ))}
          </ul>
        </details>
      )}
      <IssueList issues={r.issues} names={[]} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onSave}>
          Save {built.name}
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      {status && (
        <p role="status" className={status.ok ? "text-modified" : "text-destructive"}>
          {status.message}
        </p>
      )}
    </div>
  );
}
