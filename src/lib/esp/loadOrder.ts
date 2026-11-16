// Conflicts between several plugins in a load order: records that more than one of them changes. The last plugin in the
// order wins. UI-free so it stays testable.
//
// Records are matched the way compare.ts does it: by the master a FormID points at (or "this plugin" for its own records)
// and the ID inside it. So a master does not have to be loaded: two plugins that both override a Skyrim.esm record meet at
// the same key. Only a plugin that defines a record has to be in the list to see the override of it.
import { pluginBase } from "./bsa";
import { aspectsOf, originOf, MAX_LISTED } from "./compare";
import { fileInfo, getEditorId, walkRecords, type EspFile, type EspRecord } from "./format";

export interface ConflictEntry {
  /** File name of the plugin. */
  plugin: string;
  /** Position in the load order (0 is first). */
  order: number;
  record: EspRecord;
  /** The plugin makes this record (true) or changes one that comes from a master (false). */
  defines: boolean;
  /** This version differs from the winner's. */
  differs: boolean;
}

export interface Conflict {
  type: string;
  editorId: string | null;
  /** FormID as the winning plugin stores it. */
  formId: number;
  entries: ConflictEntry[];
  winner: ConflictEntry;
  /** Versions that differ from the winner's (so something is lost). */
  overwritten: number;
}

export interface PluginSummary {
  plugin: string;
  /** Records where this plugin has the last word and at least one earlier version differs. */
  wins: number;
  /** Records where a later plugin changes what this one set. */
  loses: number;
  /** Records this plugin shares with others that are the same in all of them. */
  identical: number;
}

export interface LoadOrderResult {
  plugins: string[];
  conflicts: Conflict[];
  /** Records changed by more than one plugin but exactly the same in all of them. */
  identical: number;
  counts: { conflicts: number };
  truncated: boolean;
  byPlugin: PluginSummary[];
}

const SLICE = 3000;
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The ESM-flagged plugins first, as the game loads them, keeping the given order otherwise. */
export function sortLikeTheGame(files: EspFile[]): EspFile[] {
  const isMaster = (f: EspFile) => {
    const t = f.nodes[0];
    return t && t.kind === "record" && (t.flags & 0x1) !== 0 ? 0 : 1;
  };
  return files.map((f, i) => ({ f, i })).sort((a, b) => isMaster(a.f) - isMaster(b.f) || a.i - b.i).map((x) => x.f);
}

/** Finds the records several plugins touch. `files` are in load order. Returns null if cancelled. */
export async function findConflicts(files: EspFile[], cancelled: () => boolean = () => false): Promise<LoadOrderResult | null> {
  const byKey = new Map<string, ConflictEntry[]>();
  let n = 0;
  for (let order = 0; order < files.length; order++) {
    const file = files[order]!;
    const masters = fileInfo(file).masters;
    const own = pluginBase(file.name);
    for (const r of walkRecords(file.nodes)) {
      if (r.type === "TES4") continue;
      if (++n % SLICE === 0) {
        await yieldToUi();
        if (cancelled()) return null;
      }
      const origin = originOf(masters, r.formId, own);
      const key = `${origin}|${r.formId & 0xffffff}`;
      const entry: ConflictEntry = { plugin: file.name, order, record: r, defines: origin === own, differs: false };
      const list = byKey.get(key);
      if (list) list.push(entry);
      else byKey.set(key, [entry]);
    }
  }

  const summary = new Map<string, PluginSummary>(files.map((f) => [f.name, { plugin: f.name, wins: 0, loses: 0, identical: 0 }]));
  const result: LoadOrderResult = { plugins: files.map((f) => f.name), conflicts: [], identical: 0, counts: { conflicts: 0 }, truncated: false, byPlugin: [] };
  n = 0;
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    if (++n % SLICE === 0) {
      await yieldToUi();
      if (cancelled()) return null;
    }
    // A plugin can hold the same record twice only if it is malformed; the last one counts
    const winner = list[list.length - 1]!;
    let overwritten = 0;
    for (const e of list) {
      e.differs = e !== winner && aspectsOf(e.record, winner.record).length > 0;
      if (e.differs) overwritten++;
    }
    if (overwritten === 0) {
      result.identical++;
      for (const e of list) summary.get(e.plugin)!.identical++;
      continue;
    }
    result.counts.conflicts++;
    summary.get(winner.plugin)!.wins++;
    for (const e of list) if (e.differs) summary.get(e.plugin)!.loses++;
    if (result.conflicts.length < MAX_LISTED) {
      result.conflicts.push({ type: winner.record.type, editorId: getEditorId(winner.record), formId: winner.record.formId, entries: list, winner, overwritten });
    } else result.truncated = true;
  }
  result.conflicts.sort((a, b) => a.type.localeCompare(b.type) || (a.editorId ?? "").localeCompare(b.editorId ?? "") || a.formId - b.formId);
  result.byPlugin = [...summary.values()];
  return result;
}
