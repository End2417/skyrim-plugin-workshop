// Merges several plugins into one new plugin. UI-free so it stays testable.
//
// Two steps that share every decision:
//  - planMerge()   looks at the plugins and decides everything (the combined master list, every record's new FormID, which
//                  version wins where several plugins change the same record, what looks wrong). It changes nothing and is
//                  what the dialog shows before anything is written.
//  - buildMerged() follows the plan: lays out the group tree, renumbers the references inside the records, writes the
//                  header and checks the result.
//
// How FormIDs are handled. A FormID's top byte is an index into the plugin's own master list, so the same record has a
// different number in every plugin. The merged plugin gets one master list (the union of the inputs' masters, without the
// inputs themselves), and each input gets a table that says where its slots end up:
//  - a slot that points at a master (Skyrim.esm) points at that master's new slot;
//  - a slot that points at another input (B lists A as a master) points at the merged plugin's own slot, because A's
//    records now live in the merged plugin;
//  - the input's own records move to the merged plugin's own slot. They keep their local ID when nothing else uses it and
//    get a fresh one otherwise.
// Every FormID the editor can find is renumbered: typed fields (defs.ts), script properties (VMAD), group labels, the
// record header and the file header's overridden-forms list. Fields the editor has no layout for cannot be read, so they
// are only fixed where a value is unmistakably a reference to the plugin's own records; the plan and the report say so.
import { visitFormIds } from "./decode";
import { findSubDef, type FieldDef } from "./defs";
import {
  FLAG_COMPRESSED,
  encodeZString,
  fileInfo,
  getEditorId,
  getOriginalSubrecords,
  getSubrecords,
  hex8,
  nextUid,
  parseEsp,
  serializeEsp,
  walkRecords,
  zstringValue,
  type EspFile,
  type EspGroup,
  type EspNode,
  type EspRecord,
  type Subrecord,
} from "./format";
import { checkPlugin } from "./check";
import { mergeRecordVersions, sameSubrecords } from "./mergeRecords";
import { readVmad } from "./scripts";

const FLAG_ESM = 0x00000001;
const FLAG_LOCALIZED = 0x00000080;
const FLAG_ESL = 0x00000200;
const MAX_MASTERS = 254;
const ENGINE_RESERVED = 0x800;
/** Masters in the order the game loads them; anything else keeps the order it was first seen in. */
const KNOWN_MASTER_ORDER = ["skyrim.esm", "update.esm", "dawnguard.esm", "hearthfires.esm", "dragonborn.esm"];
/** Group types whose label is the FormID of the record they belong to. */
const OWNER_LABEL_GROUPS = new Set([1, 6, 7, 8, 9, 10]);

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Keeps long loops from freezing the screen. Call it every few items: it hands control back to the UI only after about a
 * frame of work (browsers make chained zero-delay timers wait at least 4 ms each, so yielding every few dozen items would
 * add seconds to a big merge), reports progress at most every 100 ms (each report re-renders the dialog), and returns
 * true when the merge was cancelled.
 */
function makePacer(hooks: MergeHooks, cancelled: () => boolean) {
  let lastYield = performance.now();
  let lastReport = 0;
  return async (fraction: number, label: string): Promise<boolean> => {
    if (performance.now() - lastYield < 12) return cancelled();
    await yieldToUi();
    lastYield = performance.now();
    if (lastYield - lastReport > 100) {
      lastReport = lastYield;
      hooks.progress?.(fraction, label);
    }
    return cancelled();
  };
}
const lower = (s: string) => s.toLowerCase();
const u32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// ---------- public types ----------

export interface MergeOptions {
  /** File name of the merged plugin. Default "Merged.esp". */
  outputName?: string;
  author?: string;
  /** Text for the plugin's description. Default: a list of what it was merged from. */
  description?: string;
  /** Flag the result as a master (ESM). Default: only when every input is one. */
  esm?: boolean;
  /**
   * Which plugin's version is kept where several change the same record: conflict id (see {@link MergeConflict.id}) ->
   * index into the list of plugins. Without an entry the last plugin in the list wins, as in the game.
   */
  choose?: Record<string, number>;
  /**
   * Also renumber values in fields the editor has no layout for when they unmistakably point at the plugin's own records.
   * Default true. Turning it off leaves those values as they are (they then point at the wrong record).
   */
  rewriteUnknown?: boolean;
  /**
   * The original plugins the mods change (Skyrim.esm, Update.esm...). They are only read, never written. With them,
   * changes several plugins make to the same record are combined field by field; without them only one whole version of
   * each shared record can be kept, because there is nothing to tell what each plugin changed.
   */
  originals?: EspFile[];
  /** Combine changes to the same record when the originals allow it. Default true; false keeps one whole version. */
  combine?: boolean;
  /**
   * Finds original plugins that were not given, such as Skyrim.esm in the Skyrim folder. It is asked only when records of a
   * master are changed by several plugins and that master was not given as an original.
   */
  originalSource?: OriginalSource;
}

/**
 * `needed` are the plugins whose records several plugins change and that are missing as originals; `masters` is the merged
 * plugin's master list, for plugins that are worth reading as well (a patch such as Update.esm changes records of the
 * master it patches); `say` reports what is being read; `keys` are the records that have to be compared (see
 * {@link sliceOriginal}), so a source can keep just those and let a huge file such as Skyrim.esm go. Returns the plugins it
 * could find, in any order.
 */
export type OriginalSource = (needed: string[], masters: string[], say: (label: string) => void, keys: ReadonlySet<string>) => Promise<EspFile[]>;

/** Identifies a record by the plugin that makes it and its local ID, the same way for every plugin that changes it. */
function identityKey(file: EspFile, masters: string[], r: EspRecord): string {
  const hi = r.formId >>> 24;
  return `${lower(hi >= masters.length ? file.name : masters[hi]!)}:${r.formId & 0xffffff}`;
}

/**
 * A copy of an original plugin that holds only the records in `keys` (as the source callback receives them), with their
 * bytes copied so the rest of a huge file can be freed. A parsed plugin costs about 250 bytes per record and keeps its whole
 * file alive while any record of it is referenced; Skyrim.esm would take roughly 450 MB, the few records a merge compares
 * take next to nothing.
 */
export function sliceOriginal(file: EspFile, keys: ReadonlySet<string>): EspFile {
  const masters = fileInfo(file).masters;
  const head = file.nodes[0] as EspRecord;
  const copy = (r: EspRecord): EspRecord => ({ ...r, uid: nextUid(), raw: r.raw.slice(), subrecords: r.subrecords && r.subrecords.map((x) => ({ type: x.type, data: x.data.slice() })), parent: null, editorIdCache: undefined, nameCache: undefined, original: undefined });
  const nodes: EspNode[] = [copy(head)];
  for (const r of walkRecords(file.nodes)) {
    if (r.type !== "TES4" && keys.has(identityKey(file, masters, r))) nodes.push(copy(r));
  }
  return { name: file.name, nodes };
}

export interface MergeHooks {
  progress?: (fraction: number, label: string) => void;
  cancelled?: () => boolean;
}

export type IssueLevel = "error" | "warning" | "info";

export interface MergeIssue {
  level: IssueLevel;
  message: string;
  /** Index of the plugin it is about. */
  input?: number;
}

export interface MergeInputInfo {
  index: number;
  name: string;
  masters: string[];
  esm: boolean;
  esl: boolean;
  localized: boolean;
  /** HEDR version: 0.94 Legendary Edition, 1.7 Special Edition. */
  hedrVersion: number;
  /** Records in the plugin (without the file header). */
  records: number;
  /** Records the plugin makes itself. */
  defines: number;
  /** Records it changes from somewhere else (a master or another plugin in this merge). */
  overrides: number;
  /** Own records that had to get a different local ID because another plugin uses the same one. */
  renumbered: number;
  /** Navigation meshes (NAVM) and navigation info (NAVI) records. */
  navmeshes: number;
  /** Master slots whose number changes in the merged plugin. */
  slotsMoved: number;
}

/**
 * What happens to a record:
 *  - new:      the plugin makes it; it goes in under its (possibly new) FormID.
 *  - override: the plugin changes a record of a master; the change goes in.
 *  - wins:     several plugins change this record and this plugin's version is the one kept.
 *  - lost:     several plugins change this record and another plugin's version is kept instead.
 *  - merged:   several plugins change this record and their changes are combined into one record.
 */
export type MergeAction = "new" | "override" | "wins" | "lost" | "merged";

/** A record whose copies were combined: the contents the merged plugin gets, with every FormID already renumbered. */
export interface ConflictMerge {
  subs: Subrecord[];
  flags: number;
}

export interface PlanEntry {
  /** Index of the plugin it comes from. */
  input: number;
  record: EspRecord;
  type: string;
  /** FormID in the source plugin. */
  oldFormId: number;
  /** FormID in the merged plugin. */
  newFormId: number;
  action: MergeAction;
  /** True when the record is written (every action except "lost"). */
  included: boolean;
  /** The plugin makes this record (as opposed to changing one that is somewhere else). */
  defines: boolean;
  /** Its local ID changed because another plugin uses the same one. */
  renumbered: boolean;
  /** Where the record belongs: a master's file name, or "" for the merged plugin itself. */
  origin: string;
  /** Set on the entry that carries a combined record. */
  merge?: ConflictMerge;
}

export interface MergeConflict {
  /** Identifies the record for {@link MergeOptions.choose}: type and merged FormID. */
  id: string;
  type: string;
  newFormId: number;
  /** Index of the plugin whose version wins where the plugins collide (or is kept whole when they cannot be combined). */
  winner: number;
  /** Everyone who changes it, in load order. `differs` is true when their copy is not the same as the kept one. */
  entries: { input: number; record: EspRecord; differs: boolean }[];
  /** Every copy is the same as the kept one (nothing is lost by dropping the others). */
  identical: boolean;
  /**
   * combined: the changes of all plugins are in the result (identical copies count as combined).
   * picked:   only the winner's whole version is kept, see `reason`.
   */
  status: "combined" | "picked";
  /** Places where two plugins changed the very same field differently; the winner's value is used there. */
  collisions: number;
  /** Which fields collided. */
  collided: string[];
  /** What each plugin changes in this record, from the original (only when combined). */
  changes: { input: number; fields: string[] }[];
  /** Why the copies could not be combined. */
  reason?: string;
  /** The original plugin that would make combining possible. */
  needs?: string;
}

export interface MergePlan {
  /** False when there is at least one error; the plugins cannot be merged as they are. */
  ok: boolean;
  outputName: string;
  esm: boolean;
  inputs: MergeInputInfo[];
  /** The merged master list, in order, with the plugins that list each one. */
  masters: { name: string; usedBy: number[] }[];
  entries: PlanEntry[];
  conflicts: MergeConflict[];
  counts: {
    /** Records written. */
    records: number;
    /** Records that belong to the merged plugin itself (made by one of the plugins). */
    added: number;
    /** Changes to records of masters such as Skyrim.esm. */
    overrides: number;
    /** Records several plugins change (each is written once). */
    conflicts: number;
    /** Copies dropped because another plugin's version was kept. */
    dropped: number;
    renumbered: number;
    /** Conflicts where every copy is the same. */
    identical: number;
    /** Records whose changes from several plugins were combined (not counting identical copies). */
    combined: number;
    /** Records that could not be combined, so only one whole version is kept. */
    unmerged: number;
    /** Places where two plugins changed the same field differently. */
    collisions: number;
  };
  /** The original plugins that were used, and how many of the shared records each supplied. `auto` ones came from the source. */
  originals: { name: string; used: number; auto: boolean }[];
  issues: MergeIssue[];
  /** Used by buildMerged. */
  internal: PlanInternals;
}

interface InputMapping {
  /** Master slot of the input -> where it goes. */
  slots: ({ kind: "master"; index: number } | { kind: "input"; input: number })[];
  /** The input's own slot (its master count). */
  ownSlot: number;
  /**
   * Set for an original plugin read only to tell what the mods changed: its own records are records of that master, so
   * they keep pointing at it (index in the merged master list, -1 when the merged plugin does not have it).
   */
  selfMaster?: number;
}

export interface PlanInternals {
  names: string[];
  mappings: InputMapping[];
  mergedMasters: string[];
  ownSlot: number;
  /** (input * 0x1000000 + local ID) -> local ID in the merged plugin. */
  alloc: Map<number, number>;
  /** Local IDs each input defines, for the check of unrecognised fields. */
  ownIds: Set<number>[];
  nextObjectId: number;
  /** What rewriting the records of combined conflicts found, added to the report when the plugin is built. */
  conflictCounters: Counters;
  options: Required<Pick<MergeOptions, "rewriteUnknown">> & Pick<MergeOptions, "author" | "description">;
}

export interface MergeReport {
  records: number;
  groups: number;
  /** FormIDs rewritten in fields the editor knows. */
  refsRewritten: number;
  /** FormIDs rewritten inside script data (VMAD). */
  scriptRefsRewritten: number;
  /** Records that carry scripts. */
  scriptRecords: number;
  /** Values rewritten in fields with no layout because they clearly pointed at the plugin's own records. */
  unknownRewritten: number;
  /** Fields with no layout that were looked at. */
  unknownScanned: number;
  /** Records whose script data could not be read completely, so some of their references were not renumbered. */
  unreadableScripts: string[];
  issues: MergeIssue[];
  /** The merged file read back and checked. */
  verification: {
    records: number;
    /** Problems the plugin check found (missing masters, references to records that do not exist). */
    problems: number;
    examples: string[];
    /** FormIDs used by more than one record. */
    duplicates: number;
  };
}

export interface MergeResult {
  bytes: Uint8Array;
  name: string;
  report: MergeReport;
}

// ---------- helpers ----------

/** Puts plugins in an order where every plugin comes after the ones it lists as masters. Otherwise keeps the order. */
export function sortByDependencies(files: EspFile[]): EspFile[] {
  const remaining = files.map((f, i) => ({ f, i, masters: fileInfo(f).masters.map(lower) }));
  const names = new Set(files.map((f) => lower(f.name)));
  const placed = new Set<string>();
  const out: EspFile[] = [];
  while (remaining.length) {
    let at = remaining.findIndex((x) => x.masters.every((m) => !names.has(m) || placed.has(m) || m === lower(x.f.name)));
    if (at < 0) at = 0; // a cycle: keep the order
    const [x] = remaining.splice(at, 1);
    placed.add(lower(x!.f.name));
    out.push(x!.f);
  }
  return out;
}

/** Gives the name a file extension; .esp unless a plugin extension was typed. */
export function mergedFileName(name: string | undefined, esm: boolean): string {
  const t = (name ?? "").trim().replace(/[\\/:*?"<>|]/g, "_");
  if (/\.(esp|esm)$/i.test(t) && t.length > 4) return t;
  const base = t.replace(/\.(esp|esm|esl)$/i, "");
  return `${base || "Merged"}${esm ? ".esm" : ".esp"}`;
}

const subrecordsOf = (r: EspRecord): Subrecord[] => r.subrecords ?? getOriginalSubrecords(r);

function labelKey(groupType: number, label: Uint8Array): string {
  return `${groupType}:${Array.from(label, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function countNodes(nodes: EspNode[]): number {
  let c = 0;
  for (const n of nodes) c += n.kind === "record" ? 1 : 1 + countNodes(n.children);
  return c;
}

function headerOf(file: EspFile) {
  const tes4 = file.nodes[0] as EspRecord;
  const subs = getSubrecords(tes4);
  const hedr = subs.find((s) => s.type === "HEDR")?.data;
  return {
    tes4,
    subs,
    version: hedr && hedr.length >= 4 ? u32(hedr).getFloat32(0, true) : 0,
  };
}

// ---------- plan ----------

/** Works out the whole merge without changing anything. Returns null if cancelled. `files` are in load order. */
export async function planMerge(files: EspFile[], opts: MergeOptions = {}, hooks: MergeHooks = {}): Promise<MergePlan | null> {
  const cancelled = hooks.cancelled ?? (() => false);
  const pace = makePacer(hooks, cancelled);
  const issues: MergeIssue[] = [];
  const error = (message: string, input?: number) => issues.push({ level: "error", message, ...(input === undefined ? {} : { input }) });
  const warn = (message: string, input?: number) => issues.push({ level: "warning", message, ...(input === undefined ? {} : { input }) });
  const info = (message: string, input?: number) => issues.push({ level: "info", message, ...(input === undefined ? {} : { input }) });

  const names = files.map((f) => f.name);
  if (files.length < 2) error("Add at least two plugins to merge.");
  const seenNames = new Set<string>();
  names.forEach((n, i) => {
    if (seenNames.has(lower(n))) error(`${n} is in the list twice.`, i);
    seenNames.add(lower(n));
  });

  // what each plugin says about itself
  const heads = files.map((f) => headerOf(f));
  const infos: MergeInputInfo[] = files.map((f, k) => {
    const fi = fileInfo(f);
    const tes4 = heads[k]!.tes4;
    return {
      index: k,
      name: f.name,
      masters: fi.masters,
      esm: (tes4.flags & FLAG_ESM) !== 0,
      esl: (tes4.flags & FLAG_ESL) !== 0,
      localized: fi.localized,
      hedrVersion: heads[k]!.version,
      records: 0,
      defines: 0,
      overrides: 0,
      renumbered: 0,
      navmeshes: 0,
      slotsMoved: 0,
    };
  });

  for (const i of infos) {
    if (i.localized) error(`${i.name} keeps its text in separate strings files (it is "localized"). Those cannot be combined into one plugin here.`, i.index);
  }
  const versions = infos.filter((i) => i.hedrVersion > 0);
  if (versions.some((v) => Math.abs(v.hedrVersion - versions[0]!.hedrVersion) > 0.01)) {
    error("The plugins are not all the same edition (Legendary Edition 0.94 and Special Edition 1.7 are mixed). Convert them to one edition first.");
  }
  // every plugin must come after the plugins it needs
  const indexByName = new Map(names.map((n, i) => [lower(n), i]));
  infos.forEach((inf, k) => {
    for (const m of inf.masters) {
      const i = indexByName.get(lower(m));
      if (i !== undefined && i > k) error(`${inf.name} needs ${names[i]}, so ${names[i]} has to come before it in the list.`, k);
    }
  });

  // the merged master list: every master of every plugin except the plugins being merged
  const merged: string[] = [];
  const usedBy: number[][] = [];
  const mergedIndex = new Map<string, number>();
  infos.forEach((inf, k) => {
    for (const m of inf.masters) {
      if (indexByName.has(lower(m))) continue;
      let at = mergedIndex.get(lower(m));
      if (at === undefined) {
        at = merged.length;
        merged.push(m);
        usedBy.push([]);
        mergedIndex.set(lower(m), at);
      }
      if (!usedBy[at]!.includes(k)) usedBy[at]!.push(k);
    }
  });
  // vanilla masters in the order the game loads them, everything else as first seen
  const rank = (m: string) => {
    const r = KNOWN_MASTER_ORDER.indexOf(lower(m));
    return r < 0 ? KNOWN_MASTER_ORDER.length : r;
  };
  const order = merged.map((m, i) => ({ m, i, u: usedBy[i]! })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i);
  const mergedMasters = order.map((x) => x.m);
  const mastersOut = order.map((x) => ({ name: x.m, usedBy: x.u }));
  mergedMasters.forEach((m, i) => mergedIndex.set(lower(m), i));
  if (mergedMasters.length > MAX_MASTERS) error(`The merged plugin would need ${mergedMasters.length} masters; a plugin can have at most ${MAX_MASTERS}.`);
  const ownSlot = mergedMasters.length;

  const mappings: InputMapping[] = infos.map((inf, k) => {
    const slots = inf.masters.map((m): InputMapping["slots"][number] => {
      const i = indexByName.get(lower(m));
      return i !== undefined && i !== k ? { kind: "input", input: i } : { kind: "master", index: mergedIndex.get(lower(m)) ?? 0 };
    });
    inf.slotsMoved = slots.filter((s, i) => s.kind === "input" || s.index !== i).length;
    return { slots, ownSlot: inf.masters.length };
  });

  const esm = opts.esm ?? (infos.length > 0 && infos.every((i) => i.esm));
  if (infos.some((i) => i.esm) && !infos.every((i) => i.esm) && opts.esm === undefined) {
    warn("Some of these plugins are masters (ESM) and some are not. The merged plugin is a normal plugin; tick the master option to flag it as a master instead.");
  }
  for (const i of infos) if (i.esl) info(`${i.name} is a light plugin (ESL). The merged plugin is not light, so its records use the normal FormID range.`, i.index);
  const outputName = mergedFileName(opts.outputName ?? "Merged.esp", esm);

  // ---- classify every record ----
  interface Raw {
    input: number;
    record: EspRecord;
    key: string;
    own: boolean;
    defines: boolean;
    low: number;
    ownerInput: number;
    masterIndex: number;
  }
  const raws: Raw[] = [];
  let walked = 0;
  for (let k = 0; k < files.length; k++) {
    const m = mappings[k]!;
    for (const r of walkRecords(files[k]!.nodes)) {
      if (r.type === "TES4") continue;
      if ((++walked & 31) === 0 && (await pace(0.4 * (k / files.length), "Reading the plugins"))) return null;
      infos[k]!.records++;
      if (r.type === "NAVM" || r.type === "NAVI") infos[k]!.navmeshes++;
      if (r.type === "NAVI") continue; // the navigation index cannot be rebuilt here, so it is left out
      const hi = r.formId >>> 24;
      const low = r.formId & 0xffffff;
      if (hi >= m.ownSlot) {
        raws.push({ input: k, record: r, key: `o${k}:${low}`, own: true, defines: true, low, ownerInput: k, masterIndex: -1 });
        infos[k]!.defines++;
      } else {
        const t = m.slots[hi]!;
        if (t.kind === "input") raws.push({ input: k, record: r, key: `o${t.input}:${low}`, own: true, defines: false, low, ownerInput: t.input, masterIndex: -1 });
        else raws.push({ input: k, record: r, key: `m${t.index}:${low}`, own: false, defines: false, low, ownerInput: -1, masterIndex: t.index });
        infos[k]!.overrides++;
      }
    }
  }

  // ---- local IDs for the records that now belong to the merged plugin ----
  const ownKeys = new Map<string, { owner: number; low: number }>();
  const definedKeys = new Set<string>();
  const ownIds = files.map(() => new Set<number>());
  for (const x of raws) {
    if (!x.own) continue;
    if (!ownKeys.has(x.key)) ownKeys.set(x.key, { owner: x.ownerInput, low: x.low });
    if (x.defines) {
      definedKeys.add(x.key);
      ownIds[x.input]!.add(x.low);
    }
  }
  const alloc = new Map<number, number>();
  const used = new Set<number>();
  let highest = ENGINE_RESERVED - 1;
  for (const { low } of ownKeys.values()) if (low > highest) highest = low;
  const pending: { owner: number; low: number }[] = [];
  for (const v of ownKeys.values()) {
    if (!used.has(v.low)) {
      used.add(v.low);
      alloc.set(v.owner * 0x1000000 + v.low, v.low);
    } else pending.push(v);
  }
  let next = highest + 1;
  let maxAllocated = highest;
  for (const v of pending) {
    while (used.has(next)) next++;
    if (next > 0xffffff) {
      error("The merged plugin has run out of FormIDs.");
      break;
    }
    used.add(next);
    alloc.set(v.owner * 0x1000000 + v.low, next);
    if (next > maxAllocated) maxAllocated = next;
    next++;
  }

  // ---- what the renumbering needs, also for the original plugins (read only to tell what the mods changed) ----
  const combine = opts.combine ?? true;
  const supplied = sortByDependencies((opts.originals ?? []).filter((f) => !indexByName.has(lower(f.name))));
  const internal: PlanInternals = {
    names,
    mappings,
    mergedMasters,
    ownSlot,
    alloc,
    ownIds,
    nextObjectId: ((ownSlot << 24) | Math.min(0xffffff, maxAllocated + 1)) >>> 0,
    conflictCounters: newCounters(),
    options: { rewriteUnknown: opts.rewriteUnknown ?? true, ...(opts.author !== undefined ? { author: opts.author } : {}), ...(opts.description !== undefined ? { description: opts.description } : {}) },
  };
  const remap = new Remapper(internal);

  // ---- entries ----
  const entries: PlanEntry[] = raws.map((x) => {
    const newLow = x.own ? (alloc.get(x.ownerInput * 0x1000000 + x.low) ?? x.low) : x.low;
    const newFormId = x.own ? ((ownSlot << 24) | newLow) >>> 0 : ((x.masterIndex << 24) | x.low) >>> 0;
    const renumbered = x.own && newLow !== x.low;
    if (renumbered && x.defines) infos[x.input]!.renumbered++;
    return {
      input: x.input,
      record: x.record,
      type: x.record.type,
      oldFormId: x.record.formId >>> 0,
      newFormId,
      action: x.defines ? "new" : "override",
      included: true,
      defines: x.defines,
      renumbered,
      origin: x.own ? "" : mergedMasters[x.masterIndex]!,
    };
  });

  // ---- the same record from several plugins ----
  const byId = new Map<string, PlanEntry[]>();
  for (const e of entries) {
    const id = `${e.type}:${hex8(e.newFormId)}`;
    const list = byId.get(id);
    if (list) list.push(e);
    else byId.set(id, [e]);
  }
  const shared = [...byId].filter(([, list]) => list.length > 1);

  // the original of every record of a master that several plugins change, from the original plugins that were given
  // every shared record with each copy's references renumbered, so copies from different plugins can be compared;
  // copies that turn out the same need no original
  interface Prepared {
    id: string;
    list: PlanEntry[];
    picked: number | undefined;
    winnerEntry: PlanEntry;
    edid: string;
    versions: Map<PlanEntry, { subs: Subrecord[]; flags: number }>;
    winnerCounters: Counters;
    identical: boolean;
    sides: MergeConflict["entries"];
  }
  const prepared: Prepared[] = [];
  let prepWork = 0;
  for (const [id, list] of shared) {
    if ((++prepWork & 7) === 0 && (await pace(0.4 + 0.05 * Math.min(1, prepWork / Math.max(1, shared.length)), "Comparing the records they share"))) return null;
    const picked = opts.choose?.[id];
    const winnerEntry = (picked !== undefined ? list.find((e) => e.input === picked) : undefined) ?? list[list.length - 1]!;
    const scratchCounters = newCounters();
    const winnerCounters = newCounters();
    const versions = new Map<PlanEntry, { subs: Subrecord[]; flags: number }>();
    for (const e of list) {
      let subs: Subrecord[];
      try {
        subs = rewriteRecord(e.record, e.input, remap, internal, e === winnerEntry ? winnerCounters : scratchCounters) ?? subrecordsOf(e.record);
      } catch {
        subs = [];
      }
      versions.set(e, { subs, flags: e.record.flags });
    }
    const win = versions.get(winnerEntry)!;
    const same = (e: PlanEntry) => {
      const v = versions.get(e)!;
      return v.flags === win.flags && sameSubrecords(v.subs, win.subs);
    };
    prepared.push({
      id,
      list,
      picked,
      winnerEntry,
      edid: getEditorId(winnerEntry.record) ?? "",
      versions,
      winnerCounters,
      identical: list.every(same),
      sides: list.map((e) => ({ input: e.input, record: e.record, differs: e !== winnerEntry && !same(e) })),
    });
  }

  // the original of every record of a master that differs between plugins
  const wanted = new Map<string, string>();
  for (const pc of prepared) {
    const e = pc.list[0]!;
    if (e.origin !== "" && !pc.identical) wanted.set(`${lower(e.origin)}:${e.newFormId & 0xffffff}`, e.type);
  }
  // plugins that were not given but are needed: ask the source (the Skyrim folder, in the app)
  const autoNames = new Set<string>();
  const extra: EspFile[] = [];
  if (combine && opts.originalSource && wanted.size > 0) {
    const have = new Set(supplied.map((f) => lower(f.name)));
    const shown = new Map<string, string>();
    for (const pc of prepared) {
      const e = pc.list[0]!;
      if (e.origin !== "" && wanted.has(`${lower(e.origin)}:${e.newFormId & 0xffffff}`)) shown.set(lower(e.origin), e.origin);
    }
    const needed = [...shown].filter(([l]) => !have.has(l)).map(([, name]) => name);
    if (needed.length > 0) {
      try {
        hooks.progress?.(0.42, "Looking for the original plugins");
        const got = await opts.originalSource(needed, mergedMasters, (label) => hooks.progress?.(0.45, label), new Set(wanted.keys()));
        if (cancelled()) return null;
        for (const f of got) {
          if (indexByName.has(lower(f.name)) || have.has(lower(f.name)) || extra.some((x) => lower(x.name) === lower(f.name))) continue;
          autoNames.add(lower(f.name));
          extra.push(f);
        }
      } catch (e) {
        warn(`The original plugins could not be read automatically (${e instanceof Error ? e.message : String(e)}).`);
      }
    }
  }
  const originals = sortByDependencies([...supplied, ...extra]);
  originals.forEach((f) => {
    const fi = fileInfo(f);
    mappings.push({
      slots: fi.masters.map((m) => ({ kind: "master" as const, index: mergedIndex.get(lower(m)) ?? -1 })),
      ownSlot: fi.masters.length,
      selfMaster: mergedIndex.get(lower(f.name)) ?? -1,
    });
    ownIds.push(new Set());
  });
  const baseOf = new Map<string, { record: EspRecord; k: number }>();
  if (wanted.size > 0 && originals.length > 0) {
    let seenRecords = 0;
    for (let j = 0; j < originals.length; j++) {
      const f = originals[j]!;
      const fm = fileInfo(f).masters;
      for (const r of walkRecords(f.nodes)) {
        if (r.type === "TES4") continue;
        if ((++seenRecords & 255) === 0 && (await pace(0.4 + 0.1 * (j / originals.length), "Reading the original plugins"))) return null;
        const key = identityKey(f, fm, r);
        if (wanted.get(key) === r.type) baseOf.set(key, { record: r, k: files.length + j }); // a later original overrides an earlier one
      }
    }
  }
  const usedOriginal = originals.map(() => 0);

  const conflicts: MergeConflict[] = [];
  const needs = new Set<string>();
  let work = 0;
  for (const pc of prepared) {
    if ((++work & 7) === 0 && (await pace(0.5 + 0.1 * Math.min(1, work / Math.max(1, prepared.length)), "Combining the records they share"))) return null;
    const { id, list, picked, winnerEntry, edid, versions, winnerCounters, identical, sides } = pc;
    const scratch = newCounters();

    const conflict: MergeConflict = {
      id,
      type: winnerEntry.type,
      newFormId: winnerEntry.newFormId,
      winner: winnerEntry.input,
      entries: sides,
      identical,
      status: "picked",
      collisions: 0,
      collided: [],
      changes: [],
    };

    let combined = identical;
    if (!identical) {
      if (!combine) conflict.reason = "Combining is switched off.";
      else {
        // the original the plugins changed: the plugin that makes the record, or the master it belongs to
        let base: { subs: Subrecord[]; flags: number } | null = null;
        let sideEntries = list;
        if (winnerEntry.origin === "") {
          const maker = list.find((e) => e.defines);
          if (maker) {
            base = versions.get(maker)!;
            sideEntries = list.filter((e) => e !== maker);
          } else conflict.reason = "The plugin that makes this record is not part of the merge.";
        } else {
          const b = baseOf.get(`${lower(winnerEntry.origin)}:${winnerEntry.newFormId & 0xffffff}`);
          if (b) {
            usedOriginal[b.k - files.length]!++;
            let subs: Subrecord[];
            try {
              subs = rewriteRecord(b.record, b.k, remap, internal, scratch) ?? subrecordsOf(b.record);
            } catch {
              subs = [];
            }
            base = { subs, flags: b.record.flags };
          } else {
            conflict.reason = `${winnerEntry.origin} was not added as an original, so there is nothing to tell what each plugin changed.`;
            conflict.needs = winnerEntry.origin;
            needs.add(winnerEntry.origin);
          }
        }
        if (base) {
          const r = mergeRecordVersions(
            winnerEntry.type,
            edid,
            base,
            sideEntries.map((e) => ({ input: e.input, ...versions.get(e)! })),
            // where two plugins collide: the chosen plugin's value if one was chosen, else the later plugin's
            (contributors, next) => (picked === undefined || next === picked ? "b" : contributors.includes(picked) ? "a" : "b"),
          );
          if (r) {
            combined = true;
            winnerEntry.merge = { subs: r.subs, flags: r.flags };
            addCounters(internal.conflictCounters, winnerCounters);
            conflict.collisions = r.collisions;
            conflict.collided = r.collided;
            conflict.changes = r.changes;
          } else conflict.reason = "The record is too large to compare.";
        }
      }
    }
    conflict.status = combined ? "combined" : "picked";
    for (const e of list) {
      e.included = e === winnerEntry;
      e.action = combined ? "merged" : e.included ? "wins" : "lost";
    }
    conflicts.push(conflict);
  }

  // ---- things worth telling the person ----
  const orphans = new Map<number, number>();
  for (const x of raws) {
    if (x.own && !x.defines && !definedKeys.has(x.key)) orphans.set(x.input, (orphans.get(x.input) ?? 0) + 1);
  }
  for (const [k, n] of orphans) {
    warn(`${names[k]} changes ${n.toLocaleString()} record${n === 1 ? "" : "s"} of a plugin in this merge that does not contain ${n === 1 ? "it" : "them"}. They are kept, but they have no original.`, k);
  }
  for (const inf of infos) {
    if (inf.navmeshes > 0) {
      warn(
        `${inf.name} has ${inf.navmeshes.toLocaleString()} navigation record${inf.navmeshes === 1 ? "" : "s"}. The navigation index (NAVI) cannot be rebuilt here, so it is left out, and the references inside navigation meshes (NAVM) are not renumbered. Regenerate navigation for the merged plugin in the Creation Kit or xEdit before relying on it.`,
        inf.index,
      );
    }
    if (inf.slotsMoved > 0) {
      info(`${inf.name}: ${inf.slotsMoved} of its master slots change number in the merged plugin. References to masters inside fields the editor has no layout for cannot be checked.`, inf.index);
    }
  }
  const unmerged = conflicts.filter((c) => c.status === "picked");
  if (needs.size > 0) {
    const list = [...needs].join(", ");
    const n = unmerged.filter((c) => c.needs).length;
    warn(
      `${n.toLocaleString()} record${n === 1 ? " is" : "s are"} changed differently by more than one plugin, but ${list} ${needs.size === 1 ? "was" : "were"} not added as ${needs.size === 1 ? "an original" : "originals"}, so only one whole version of ${n === 1 ? "it" : "each"} is kept (the last plugin's unless you pick another). Add ${list} below to combine their changes instead.`,
    );
  }
  const other = unmerged.filter((c) => !c.needs);
  if (other.length > 0) {
    info(`${other.length.toLocaleString()} record${other.length === 1 ? " is" : "s are"} changed differently by more than one plugin and could not be combined, so one whole version is kept.`);
  }
  const combinedList = conflicts.filter((c) => c.status === "combined" && !c.identical);
  const collisionTotal = conflicts.reduce((a, c) => a + c.collisions, 0);
  if (combinedList.length > 0) {
    info(
      `${combinedList.length.toLocaleString()} record${combinedList.length === 1 ? "" : "s"} changed by more than one plugin ${combinedList.length === 1 ? "was" : "were"} combined, keeping what each plugin changed.` +
        (collisionTotal > 0 ? ` In ${collisionTotal.toLocaleString()} place${collisionTotal === 1 ? "" : "s"} two plugins changed the same field differently; the later plugin's value is used there.` : ""),
    );
  }
  info("Scripts (.pex), SKSE plugins, meshes and other files are not part of the plugin and are not merged. Plugins that need the originals as masters have to be patched or merged too.");

  const counts = {
    records: entries.filter((e) => e.included).length,
    // by what the record is in the result: one of the merged plugin's own, or a change to a master's record
    added: entries.filter((e) => e.included && e.origin === "").length,
    overrides: entries.filter((e) => e.included && e.origin !== "").length,
    conflicts: conflicts.length,
    dropped: entries.filter((e) => e.action === "lost").length,
    renumbered: entries.filter((e) => e.renumbered && e.defines).length,
    identical: conflicts.filter((c) => c.identical).length,
    combined: combinedList.length,
    unmerged: unmerged.length,
    collisions: collisionTotal,
  };

  hooks.progress?.(0.6, "Plan ready");
  return {
    ok: !issues.some((i) => i.level === "error"),
    outputName,
    esm,
    inputs: infos,
    masters: mastersOut,
    entries,
    conflicts,
    counts,
    originals: originals.map((f, j) => ({ name: f.name, used: usedOriginal[j]!, auto: autoNames.has(lower(f.name)) })),
    issues,
    internal,
  };
}

// ---------- renumbering ----------

class Remapper {
  constructor(private readonly p: PlanInternals) {}

  /** The FormID as the merged plugin writes it. `k` is the plugin the value was read from. */
  map(k: number, id: number): number {
    id = id >>> 0;
    if (id === 0) return 0;
    const hi = id >>> 24;
    if (hi === 0xff) return id; // created while playing, never in a plugin
    const low = id & 0xffffff;
    const m = this.p.mappings[k]!;
    if (hi >= m.ownSlot) {
      if (m.selfMaster !== undefined) return m.selfMaster < 0 ? id : ((m.selfMaster << 24) | low) >>> 0;
      return (((this.p.ownSlot << 24) | (this.p.alloc.get(k * 0x1000000 + low) ?? low)) >>> 0);
    }
    const t = m.slots[hi]!;
    if (t.kind === "master") return t.index < 0 ? id : ((t.index << 24) | low) >>> 0;
    return (((this.p.ownSlot << 24) | (this.p.alloc.get(t.input * 0x1000000 + low) ?? low)) >>> 0);
  }
}

export interface Counters {
  refs: number;
  scriptRefs: number;
  scriptRecords: number;
  unknownRewritten: number;
  unknownScanned: number;
  unreadable: string[];
}

function addCounters(into: Counters, from: Counters) {
  into.refs += from.refs;
  into.scriptRefs += from.scriptRefs;
  into.scriptRecords += from.scriptRecords;
  into.unknownRewritten += from.unknownRewritten;
  into.unknownScanned += from.unknownScanned;
  into.unreadable.push(...from.unreadable);
}

const newCounters = (): Counters => ({ refs: 0, scriptRefs: 0, scriptRecords: 0, unknownRewritten: 0, unknownScanned: 0, unreadable: [] });

/** Condition layout: operator and value (8), function (4), parameter 1 at 12, parameter 2 at 16, run on (20), reference (24, a known FormID field), parameter 3 at 28. */
const CTDA_PARAMS = [12, 16, 28];

/**
 * Renumbers the references inside records. One instance is reused for every record of a plan or build (nothing is
 * allocated per record or per subrecord except what actually changes), which matters for plugins with hundreds of
 * thousands of records. It holds state while a record is being rewritten, so it is not reentrant.
 */
class Rewriter {
  private k = 0;
  private c!: Counters;
  private m!: InputMapping;
  private own!: Set<number>;
  private sub!: Subrecord;
  private patched: Uint8Array | null = null;

  constructor(
    private readonly remap: Remapper,
    private readonly p: PlanInternals,
  ) {}

  /** Writes a renumbered FormID into a copy of the current subrecord's data (made on the first change). */
  private set(at: number, value: number) {
    this.patched ??= this.sub.data.slice();
    u32(this.patched).setUint32(at, value >>> 0, true);
  }

  private readonly onFormId = (id: number, _field: unknown, at: number) => {
    const to = this.remap.map(this.k, id);
    if (to !== id >>> 0) {
      this.set(at, to);
      this.c.refs++;
    }
  };

  private readonly onScriptId = (id: number, at: number) => {
    const to = this.remap.map(this.k, id);
    if (to !== id >>> 0) {
      this.set(at, to);
      this.c.scriptRefs++;
    }
  };

  /** A value that is unmistakably a reference to a record this plugin makes, or one that another plugin of the merge makes. */
  private isOwnRef(v: number): boolean {
    const low = v & 0xffffff;
    if (this.m.ownSlot < 1 || low < ENGINE_RESERVED) return false;
    const hi = v >>> 24;
    if (hi === this.m.ownSlot) return this.own.has(low);
    const t = hi < this.m.ownSlot ? this.m.slots[hi] : undefined;
    return !!t && t.kind === "input" && this.p.ownIds[t.input]!.has(low);
  }

  private scan(view: DataView, at: number) {
    if (at + 4 > view.byteLength) return;
    const v = view.getUint32(at, true);
    if (!this.isOwnRef(v)) return;
    const to = this.remap.map(this.k, v);
    if (to !== v) {
      this.set(at, to);
      this.c.unknownRewritten++;
    }
  }

  /** The record's subrecords with every reference renumbered, or null when nothing changed. */
  rewrite(r: EspRecord, k: number, c: Counters): Subrecord[] | null {
    const subs = subrecordsOf(r);
    this.k = k;
    this.c = c;
    this.m = this.p.mappings[k]!;
    this.own = this.p.ownIds[k]!;
    const unknown = this.p.options.rewriteUnknown;
    let out: Subrecord[] | null = null;
    let counted = false;
    let edid: string | null = null; // only a few layouts depend on the Editor ID, so it is read when one does

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i]!;
      this.sub = sub;
      this.patched = null;
      if (sub.type === "VMAD") {
        if (!counted) {
          c.scriptRecords++;
          counted = true;
        }
        const info = readVmad(sub.data, r.type, this.onScriptId);
        if (!info.complete && info.note && !/^Fragment scripts of/.test(info.note)) {
          c.unreadable.push(`${getEditorId(r) ?? "(no Editor ID)"} [${r.type}:${hex8(r.formId)}]: ${info.note}`);
        }
      } else {
        let def: FieldDef | null = null;
        const d = findSubDef(r.type, sub.type);
        if (d) {
          try {
            if (typeof d.def === "function") {
              if (edid === null) {
                const e = subs.find((x) => x.type === "EDID");
                edid = e ? zstringValue(e.data) : "";
              }
              def = d.def({ edid, data: sub.data });
            } else def = d.def;
          } catch {
            def = null;
          }
        }
        if (def) visitFormIds(def, sub.data, 0, false, this.onFormId);
        if (unknown) {
          if (sub.type === "CTDA") {
            // condition parameters: which ones are FormIDs depends on the function, so only unmistakable ones are changed
            const view = u32(sub.data);
            for (const at of CTDA_PARAMS) this.scan(view, at);
          } else if (!def || def.k === "bytes") {
            c.unknownScanned++;
            const view = u32(sub.data);
            for (let at = 0; at + 4 <= sub.data.length; at += 4) this.scan(view, at);
          }
        }
      }
      if (this.patched) {
        out ??= subs.slice();
        out[i] = { type: sub.type, data: this.patched };
      }
    }
    this.patched = null;
    return out;
  }
}

const rewriters = new WeakMap<Remapper, Rewriter>();

/** The record's subrecords with every reference renumbered, or null when nothing changed. */
function rewriteRecord(r: EspRecord, k: number, remap: Remapper, p: PlanInternals, c: Counters): Subrecord[] | null {
  let w = rewriters.get(remap);
  if (!w) rewriters.set(remap, (w = new Rewriter(remap, p)));
  return w.rewrite(r, k, c);
}

// ---------- build ----------

interface Placed {
  dest: EspNode[];
  node: EspRecord;
}

class DestIndex {
  private recs = new Map<string, number>();
  private groups = new Map<string, EspGroup>();
  constructor(nodes: EspNode[], keyOf: (r: EspRecord) => string | null) {
    nodes.forEach((n, i) => {
      if (n.kind === "record") {
        const k = keyOf(n);
        if (k) this.recs.set(k, i);
      } else this.groups.set(labelKey(n.groupType, n.label), n);
    });
  }
  record(key: string) {
    return this.recs.get(key);
  }
  setRecord(key: string, at: number) {
    this.recs.set(key, at);
  }
  group(key: string) {
    return this.groups.get(key);
  }
  setGroup(key: string, g: EspGroup) {
    this.groups.set(key, g);
  }
}

/**
 * Builds the merged plugin the plan describes. Returns null if cancelled. `files` must be the ones the plan was made from.
 * `outputName` replaces the name the plan was made with, so the file can be renamed after the preview.
 */
export async function buildMerged(files: EspFile[], plan: MergePlan, hooks: MergeHooks = {}, outputName?: string): Promise<MergeResult | null> {
  const cancelled = hooks.cancelled ?? (() => false);
  const pace = makePacer(hooks, cancelled);
  if (!plan.ok) throw new Error(plan.issues.find((i) => i.level === "error")?.message ?? "These plugins cannot be merged.");
  if (files.length !== plan.inputs.length || files.some((f, i) => f.name !== plan.inputs[i]!.name)) {
    throw new Error("The plugins changed since the preview. Preview the merge again.");
  }
  const p = plan.internal;
  const remap = new Remapper(p);
  const counters = newCounters();
  addCounters(counters, p.conflictCounters); // records that were combined were renumbered while planning

  const entryOf = new Map<EspRecord, PlanEntry>();
  for (const e of plan.entries) entryOf.set(e.record, e);

  // ---- 1. lay out the tree, using the original records as stand-ins ----
  const top: EspNode[] = [];
  const indexes = new WeakMap<EspNode[], DestIndex>();
  const keyOf = (r: EspRecord) => {
    const e = entryOf.get(r);
    return e ? `${e.type}:${e.newFormId}` : null;
  };
  const indexOf = (dest: EspNode[]) => {
    let ix = indexes.get(dest);
    if (!ix) (ix = new DestIndex(dest, keyOf)), indexes.set(dest, ix);
    return ix;
  };
  const placed = new Map<string, Placed>();

  const remapLabel = (k: number, g: EspGroup): Uint8Array => {
    if (!OWNER_LABEL_GROUPS.has(g.groupType) || g.label.length < 4) return g.label.slice();
    const out = new Uint8Array(g.label.length);
    out.set(g.label);
    u32(out).setUint32(0, remap.map(k, u32(g.label).getUint32(0, true)), true);
    return out;
  };

  let seen = 0;
  const lay = async (dest: EspNode[], parent: EspGroup | null, incoming: EspNode[], k: number): Promise<boolean> => {
    for (const n of incoming) {
      if ((++seen & 31) === 0 && (await pace(0.6 + 0.15 * Math.min(1, seen / Math.max(1, plan.entries.length)), "Laying out the records"))) return false;
      if (n.kind === "group") {
        if (n.groupType === 0 && String.fromCharCode(...n.label.subarray(0, 4)) === "NAVI") continue; // cannot be rebuilt here
        const label = remapLabel(k, n);
        const key = labelKey(n.groupType, label);
        const ix = indexOf(dest);
        let g = ix.group(key);
        if (!g) {
          g = { kind: "group", uid: nextUid(), label, groupType: n.groupType, stamp: n.stamp, unknown: n.unknown, children: [], parent };
          dest.push(g);
          ix.setGroup(key, g);
        }
        if (!(await lay(g.children, g, n.children, k))) return false;
        continue;
      }
      const e = entryOf.get(n);
      if (!e || n.type === "NAVI") continue;
      const key = `${e.type}:${e.newFormId}`;
      const prev = placed.get(key);
      const ix = indexOf(dest);
      if (!prev) {
        dest.push(n);
        ix.setRecord(key, dest.length - 1);
        placed.set(key, { dest, node: n });
      } else if (!e.included) {
        // another plugin's version is kept
      } else if (prev.dest === dest) {
        const at = ix.record(key);
        if (at !== undefined) dest[at] = n;
        prev.node = n;
      } else {
        // the kept version sits in a different group than the copy placed first (moved between persistent and temporary)
        const at = prev.dest.indexOf(prev.node);
        if (at >= 0) prev.dest.splice(at, 1);
        indexes.delete(prev.dest);
        dest.push(n);
        ix.setRecord(key, dest.length - 1);
        placed.set(key, { dest, node: n });
      }
    }
    return true;
  };
  for (let k = 0; k < files.length; k++) {
    if (!(await lay(top, null, files[k]!.nodes.slice(1), k))) return null;
  }

  // ---- 2. drop empty groups, then write each surviving record once, renumbered ----
  const prune = (nodes: EspNode[]) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (n.kind !== "group") continue;
      prune(n.children);
      if (n.children.length === 0) nodes.splice(i, 1);
    }
  };
  prune(top);

  let written = 0;
  const finish = async (nodes: EspNode[], parent: EspGroup | null): Promise<boolean> => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.kind === "group") {
        n.parent = parent;
        if (!(await finish(n.children, n))) return false;
        continue;
      }
      if ((++written & 31) === 0 && (await pace(0.75 + 0.15 * Math.min(1, written / Math.max(1, plan.counts.records)), "Renumbering references"))) return false;
      const e = entryOf.get(n)!;
      if (e.merge) {
        // several plugins' changes combined; already renumbered. The compression flag stays what the kept copy has.
        nodes[i] = {
          ...n,
          uid: nextUid(),
          formId: e.newFormId,
          parent,
          flags: ((e.merge.flags & ~FLAG_COMPRESSED) | (n.flags & FLAG_COMPRESSED)) >>> 0,
          subrecords: e.merge.subs,
          dirty: true,
          original: undefined,
          editorIdCache: undefined,
          nameCache: undefined,
        };
        continue;
      }
      let subs: Subrecord[] | null;
      try {
        subs = rewriteRecord(n, e.input, remap, p, counters);
      } catch (err) {
        throw new Error(`${getEditorId(n) ?? n.type} [${n.type}:${hex8(n.formId)}] from ${p.names[e.input]} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      nodes[i] = {
        ...n,
        uid: nextUid(),
        formId: e.newFormId,
        parent,
        ...(subs ? { subrecords: subs, dirty: true } : {}),
        original: undefined,
        editorIdCache: undefined,
        nameCache: undefined,
      };
    }
    return true;
  };
  if (!(await finish(top, null))) return null;

  // ---- 3. the file header ----
  const header = buildHeader(files, plan, remap, countNodes(top));
  const name = outputName === undefined ? plan.outputName : mergedFileName(outputName, plan.esm);
  const bytes = serializeEsp({ name, nodes: [header, ...top] });

  // ---- 4. read the result back and check it ----
  hooks.progress?.(0.92, "Checking the result");
  const parsed = parseEsp(bytes, name);
  const check = await checkPlugin(parsed, {}, cancelled);
  if (!check) return null;
  const seenIds = new Set<number>();
  let duplicates = 0;
  for (const r of walkRecords(parsed.nodes)) {
    if (r.type === "TES4") continue;
    if (seenIds.has(r.formId >>> 0)) duplicates++;
    seenIds.add(r.formId >>> 0);
  }

  const issues: MergeIssue[] = [];
  if (counters.unreadable.length > 0) {
    issues.push({
      level: "warning",
      message: `The script data of ${counters.unreadable.length} record${counters.unreadable.length === 1 ? "" : "s"} could not be read completely, so some script references in ${counters.unreadable.length === 1 ? "it" : "them"} may still point at the old FormIDs.`,
    });
  }
  if (p.options.rewriteUnknown && counters.unknownRewritten > 0) {
    issues.push({
      level: "info",
      message: `${counters.unknownRewritten.toLocaleString()} value${counters.unknownRewritten === 1 ? "" : "s"} in fields the editor has no layout for clearly pointed at a plugin's own records and ${counters.unknownRewritten === 1 ? "was" : "were"} renumbered.`,
    });
  }
  if (!p.options.rewriteUnknown) {
    issues.push({ level: "info", message: "Fields the editor has no layout for were left as they are, so they may point at the wrong records." });
  }
  if (duplicates > 0) issues.push({ level: "error", message: `${duplicates} FormID${duplicates === 1 ? " is" : "s are"} used by more than one record in the result.` });
  if (check.total > 0) {
    issues.push({ level: "warning", message: `The check of the merged plugin found ${check.total.toLocaleString()} problem${check.total === 1 ? "" : "s"}, for example references to records that are not in it.` });
  }

  return {
    bytes,
    name,
    report: {
      records: plan.counts.records,
      groups: countNodes(top) - plan.counts.records,
      refsRewritten: counters.refs,
      scriptRefsRewritten: counters.scriptRefs,
      scriptRecords: counters.scriptRecords,
      unknownRewritten: counters.unknownRewritten,
      unknownScanned: counters.unknownScanned,
      unreadableScripts: counters.unreadable,
      issues,
      verification: {
        records: check.records,
        problems: check.total,
        examples: check.issues.slice(0, 8).map((x) => `${getEditorId(x.record) ?? x.record.type}: ${x.message}`),
        duplicates,
      },
    },
  };
}

function buildHeader(files: EspFile[], plan: MergePlan, remap: Remapper, recordCount: number): EspRecord {
  const p = plan.internal;
  const first = files[0]!.nodes[0] as EspRecord;
  const firstSubs = getSubrecords(first);
  const hedrSrc = firstSubs.find((s) => s.type === "HEDR")?.data;
  const hedr = new Uint8Array(12);
  const dv = u32(hedr);
  if (hedrSrc && hedrSrc.length >= 4) hedr.set(hedrSrc.subarray(0, 4));
  else dv.setFloat32(0, 1.7, true);
  dv.setInt32(4, recordCount, true);
  dv.setUint32(8, p.nextObjectId, true);

  const description = (p.options.description ?? `Merged from ${p.names.join(", ")}`).slice(0, 500);
  const subs: Subrecord[] = [
    { type: "HEDR", data: hedr },
    { type: "CNAM", data: encodeZString(p.options.author ?? "Skyrim ESP Editor") },
    { type: "SNAM", data: encodeZString(description) },
  ];
  for (const m of p.mergedMasters) {
    subs.push({ type: "MAST", data: encodeZString(m) }, { type: "DATA", data: new Uint8Array(8) });
  }
  if (plan.esm) {
    // overridden forms (persistent references a master's cells), renumbered and without repeats
    const seen = new Set<number>();
    const list: number[] = [];
    files.forEach((f, k) => {
      const onam = getSubrecords(f.nodes[0] as EspRecord).find((s) => s.type === "ONAM")?.data;
      if (!onam) return;
      const v = u32(onam);
      for (let o = 0; o + 4 <= onam.length; o += 4) {
        const id = remap.map(k, v.getUint32(o, true));
        if (!seen.has(id)) (seen.add(id), list.push(id));
      }
    });
    if (list.length > 0) {
      const data = new Uint8Array(list.length * 4);
      list.forEach((id, i) => u32(data).setUint32(i * 4, id, true));
      subs.push({ type: "ONAM", data });
    }
  }

  return {
    kind: "record",
    uid: nextUid(),
    type: "TES4",
    // not localized, not light; a master only when asked for
    flags: ((first.flags & ~(FLAG_ESM | FLAG_ESL | FLAG_LOCALIZED)) | (plan.esm ? FLAG_ESM : 0)) >>> 0,
    formId: 0,
    stamp: first.stamp,
    version: first.version,
    unknown: first.unknown,
    raw: new Uint8Array(0),
    subrecords: subs,
    dirty: true,
    parent: null,
  };
}

/** Plans and builds in one go. Returns null if cancelled. */
export async function mergePlugins(files: EspFile[], opts: MergeOptions = {}, hooks: MergeHooks = {}): Promise<{ plan: MergePlan; result: MergeResult } | null> {
  const plan = await planMerge(files, opts, hooks);
  if (!plan) return null;
  const result = await buildMerged(files, plan, hooks);
  return result ? { plan, result } : null;
}
