import { useMemo, useRef, useState } from "react";
import { PackageOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { downloadPlugin } from "@/lib/esp/download";
import { convertToLe, detectEdition } from "@/lib/esp/convert";
import { extractPlugin, fieldKey, findDependencies, findLocalizedFields, listChangedRecords, mergeIntoPlugin, planMasters } from "@/lib/esp/extract";
import { lookupString } from "@/lib/esp/strings";
import { buildFormIdIndex, getEditorId, hex8, parseEsp, type EspFile, type EspRecord } from "@/lib/esp/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: EspFile;
  selected: EspRecord | null;
}

export function ExtractDialog({ open, onOpenChange, file, selected }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        {/* Mounted only while open, so the list is rebuilt from the current edits each time. */}
        <ExtractForm file={file} selected={selected} />
      </DialogContent>
    </Dialog>
  );
}

const label = (r: EspRecord) => `${getEditorId(r) ?? "(no Editor ID)"}  [${r.type}:${hex8(r.formId)}]`;

function ExtractForm({ file, selected }: { file: EspFile; selected: EspRecord | null }) {
  const changed = useMemo(() => listChangedRecords(file), [file]);
  const extra = selected && selected.type !== "TES4" && !selected.dirty ? selected : null;
  const candidates = extra ? [...changed, extra] : changed;
  const index = useMemo(() => buildFormIdIndex(file), [file]);

  const base = file.name.replace(/\.(esp|esm|esl)$/i, "");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(changed.map((r) => r.uid)));
  const [outName, setOutName] = useState(`${base}_Changes.esp`);
  const [sourceName, setSourceName] = useState(file.name);
  const [text, setText] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // records the chosen ones depend on
  const [includeDeps, setIncludeDeps] = useState(false);
  const [depth, setDepth] = useState(1);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());

  // destination: a new plugin, or an existing patch
  const [dest, setDest] = useState<"new" | "patch">("new");
  // Special Edition source: offer the Legendary Edition format, on by default since LE is what this app targets
  const isSe = useMemo(() => detectEdition(file).edition === "SE", [file]);
  const [asLe, setAsLe] = useState(isSe);
  const [patch, setPatch] = useState<{ name: string; bytes: Uint8Array; file: EspFile } | null>(null);
  const patchInput = useRef<HTMLInputElement>(null);

  const chosen = candidates.filter((r) => picked.has(r.uid));
  const deps = useMemo(
    () => (includeDeps ? findDependencies(file, chosen, { depth, index }) : { records: [] as EspRecord[], truncated: false }),
    [file, index, includeDeps, depth, picked], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const chosenDeps = deps.records.filter((r) => !skipped.has(r.uid));
  const all = [...chosen, ...chosenDeps];
  const localized = useMemo(() => findLocalizedFields(file, all), [file, all.length, picked, skipped, includeDeps, depth]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useMemo(() => (dest === "patch" && patch ? planMasters(patch.file, file, sourceName.trim()) : null), [dest, patch, file, sourceName]);

  function toggle(r: EspRecord, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(r.uid);
    else next.delete(r.uid);
    setPicked(next);
    setStatus(null);
  }

  function toggleDep(r: EspRecord, on: boolean) {
    const next = new Set(skipped);
    if (on) next.delete(r.uid);
    else next.add(r.uid);
    setSkipped(next);
    setStatus(null);
  }

  async function choosePatch(f: File) {
    setStatus(null);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      setPatch({ name: f.name, bytes, file: parseEsp(bytes, f.name) });
    } catch (e) {
      setPatch(null);
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function run() {
    setBusy(true);
    setStatus(null);
    try {
      const options = { sourceName, text: new Map(Object.entries(text)) };
      let bytes: Uint8Array;
      let name: string;
      let summary: string;
      if (dest === "patch") {
        if (!patch) throw new Error("Choose the patch plugin first.");
        // parsed afresh, so running again never merges into an already-changed copy
        const result = mergeIntoPlugin(parseEsp(patch.bytes, patch.name), file, all, { ...options, weak: chosenDeps });
        bytes = result.bytes;
        name = patch.name;
        summary =
          `Added ${result.added}, replaced ${result.replaced}` +
          `${result.kept ? `, kept ${result.kept} the patch already had` : ""}` +
          `${result.mastersAdded.length ? `. ${result.mastersAdded.join(", ")} was added to its masters` : ""}`;
      } else {
        const fileName = /\.(esp)$/i.test(outName.trim()) ? outName.trim() : `${outName.trim().replace(/\.(esm|esl)$/i, "")}.esp`;
        bytes = extractPlugin(file, all, options);
        name = fileName;
        summary = `${all.length} record${all.length === 1 ? "" : "s"}`;
        if (isSe && asLe) {
          const le = convertToLe(parseEsp(bytes, name));
          bytes = le.bytes;
          summary += ", Legendary Edition format";
          if (le.report.warnings.length > 0) summary += `. Check: ${le.report.warnings.join(" ")}`;
        }
      }
      const savedTo = await downloadPlugin(bytes, name);
      const renamed = !!savedTo && !savedTo.toLowerCase().endsWith(`/${name.toLowerCase()}`);
      setStatus({
        ok: true,
        message:
          `${savedTo ? `Saved to ${savedTo}` : `${name} was handed to your device`} (${summary}; ${(bytes.length / 1024).toFixed(1)} KB).` +
          `${savedTo ? "" : " This app cannot confirm where it was saved."}` +
          `${dest === "patch" && renamed ? ` A file named ${name} already existed and is never overwritten, so replace the old one with this copy.` : ""}` +
          ` Put it in Skyrim's Data folder and enable it after ${sourceName} in your load order.`,
      });
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const blocked = busy || chosen.length === 0 || (dest === "patch" && (!patch || plan?.ok === false));
  const total = all.length;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <PackageOpen className="size-5" /> Extract changes as a plugin
        </DialogTitle>
        <DialogDescription>
          Saves only the records below into a small .esp that overrides them in {sourceName || "the source plugin"}, like a mod. The
          original plugin is not touched.
        </DialogDescription>
      </DialogHeader>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has been changed yet. Edit a record (for example a weapon's damage), then come back here. You can also select a record
          in the tree to extract it unchanged.
        </p>
      ) : (
        <ul className="max-h-48 divide-y overflow-auto rounded-md border text-sm">
          {candidates.map((r) => (
            <li key={r.uid} className="flex items-center gap-3 px-3 py-2">
              <Checkbox id={`ex-${r.uid}`} checked={picked.has(r.uid)} onCheckedChange={(v) => toggle(r, v === true)} />
              <label htmlFor={`ex-${r.uid}`} className="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs">
                {label(r)}
              </label>
              <span className="text-xs text-muted-foreground">{r.dirty ? "edited" : "unchanged"}</span>
            </li>
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <div className="flex items-start gap-3">
            <Checkbox
              id="ex-deps"
              className="mt-0.5"
              checked={includeDeps}
              onCheckedChange={(v) => {
                setIncludeDeps(v === true);
                setSkipped(new Set());
                setStatus(null);
              }}
            />
            <label htmlFor="ex-deps" className="min-w-0 flex-1 cursor-pointer">
              <span className="font-medium">Also include records these depend on</span>
              <span className="block text-xs text-muted-foreground">
                Copies the records of {sourceName || "the source"} that your chosen records point at (keywords, sounds, effects...), unchanged.
                Copies of untouched records can clash with other mods that change them, so use this only when you need them.
              </span>
            </label>
          </div>
          {includeDeps && (
            <>
              <div className="flex items-center gap-2 text-xs">
                <label htmlFor="ex-depth" className="text-muted-foreground">Follow</label>
                <select
                  id="ex-depth"
                  value={depth}
                  onChange={(e) => {
                    setDepth(Number(e.target.value));
                    setSkipped(new Set());
                  }}
                  className="h-8 rounded-md border bg-background px-2"
                >
                  <option value={1}>direct references only</option>
                  <option value={2}>two levels of references</option>
                  <option value={3}>three levels of references</option>
                </select>
              </div>
              {deps.records.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing found. The chosen records point only at records in other plugins, or at fields the editor cannot read.
                </p>
              ) : (
                <>
                  <ul className="max-h-40 divide-y overflow-auto rounded-md border">
                    {deps.records.map((r) => (
                      <li key={r.uid} className="flex items-center gap-3 px-3 py-1.5">
                        <Checkbox id={`dep-${r.uid}`} checked={!skipped.has(r.uid)} onCheckedChange={(v) => toggleDep(r, v === true)} />
                        <label htmlFor={`dep-${r.uid}`} className="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs">
                          {label(r)}
                        </label>
                        <span className="text-xs text-muted-foreground">{r.dirty ? "edited" : "dependency"}</span>
                      </li>
                    ))}
                  </ul>
                  {deps.truncated && <p className="text-xs text-destructive">Stopped at {deps.records.length} records. Follow fewer levels to see them all.</p>}
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="space-y-2 rounded-md border p-3 text-sm">
        <p className="font-medium">Save into</p>
        <RadioGroup
          value={dest}
          onValueChange={(v) => {
            setDest(v as "new" | "patch");
            setStatus(null);
          }}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="new" id="ex-dest-new" />
            <label htmlFor="ex-dest-new" className="cursor-pointer">A new plugin</label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="patch" id="ex-dest-patch" />
            <label htmlFor="ex-dest-patch" className="cursor-pointer">An existing patch plugin</label>
          </div>
        </RadioGroup>
        {dest === "patch" && (
          <div className="space-y-2">
            <input
              ref={patchInput}
              type="file"
              accept=".esp,application/octet-stream"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void choosePatch(f);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => patchInput.current?.click()}>
                {patch ? "Choose another patch" : "Choose patch plugin"}
              </Button>
              {patch && <span className="min-w-0 truncate font-mono text-xs">{patch.name}</span>}
            </div>
            {plan?.ok === false && (
              <p role="alert" className="text-xs text-destructive">
                {plan.reason}
              </p>
            )}
            {plan?.ok === true && (
              <p className="text-xs text-muted-foreground">
                Records with the same FormID in the patch are replaced
                {plan.add.length ? `, and ${plan.add.join(", ")} is added to its masters` : ""}. The patch you pick is not changed; the result is saved as a copy.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
        {dest === "new" && isSe && (
          <label className="col-span-2 flex items-start gap-2">
            <Checkbox checked={asLe} onCheckedChange={(v) => setAsLe(v === true)} className="mt-0.5" />
            <span>
              Save in Legendary Edition format
              <span className="block text-xs text-muted-foreground">
                {file.name} is a Special Edition plugin. This sets the LE header and form versions (see To LE). Records are not otherwise changed.
              </span>
            </span>
          </label>
        )}
        {dest === "new" && (
          <>
            <label htmlFor="ex-out" className="text-muted-foreground">New file name</label>
            <Input id="ex-out" value={outName} onChange={(e) => setOutName(e.target.value)} className="h-8 font-mono text-xs" />
          </>
        )}
        <label htmlFor="ex-src" className="text-muted-foreground">Source plugin</label>
        <Input id="ex-src" value={sourceName} onChange={(e) => setSourceName(e.target.value)} className="h-8 font-mono text-xs" />
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        The source plugin must be named exactly as it appears in your game's Data folder (for example Skyrim.esm).
      </p>

      {localized.length > 0 && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Text in {sourceName || "the source"} is stored in string tables</p>
          <p className="text-xs text-muted-foreground">
            A new plugin can't use those tables, so the text is stored directly. Text found in the strings files you loaded is filled in
            automatically (shown greyed out). Otherwise a blank name uses its Editor ID, and a blank description is left out.
          </p>
          {localized.map((f) => (
            <div key={fieldKey(f)} className="grid grid-cols-[8rem_1fr] items-center gap-2 text-xs">
              <span className="truncate font-mono text-muted-foreground" title={label(f.record)}>
                {getEditorId(f.record) ?? hex8(f.record.formId)} · {f.sub}
              </span>
              <Input
                aria-label={`${f.sub} text for ${label(f.record)}`}
                placeholder={lookupString(f.stringId) ?? (f.sub === "FULL" ? (getEditorId(f.record) ?? "Name") : "(omit)")}
                value={text[fieldKey(f)] ?? ""}
                onChange={(e) => setText({ ...text, [fieldKey(f)]: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
          ))}
        </div>
      )}

      {status && (
        <p role={status.ok ? "status" : "alert"} className={`text-sm ${status.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {status.message}
        </p>
      )}

      <Button onClick={run} disabled={blocked}>
        <PackageOpen />{" "}
        {busy
          ? "Building…"
          : dest === "patch"
            ? `Add ${total} record${total === 1 ? "" : "s"} to patch`
            : `Extract ${total} record${total === 1 ? "" : "s"} to .esp`}
      </Button>
    </>
  );
}
