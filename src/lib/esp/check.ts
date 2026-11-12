// Plugin health check: FormIDs that point at a master the plugin does not list, and
// references to records that do not exist. UI-free so it stays testable.
import { forEachFormIdRef } from "./refs";
import { fileInfo, walkRecords, type EspFile, type EspRecord } from "./format";

export type IssueKind = "undeclared-master" | "missing-record" | "own-id";

export interface CheckIssue {
  kind: IssueKind;
  record: EspRecord;
  /** Where the problem is, e.g. "KWDA › Keyword" or "Record FormID". */
  where: string;
  target: number;
  message: string;
}

export interface MasterUse {
  name: string;
  /** Records overridden from it plus references into it. */
  uses: number;
  /** True when its file was supplied, so references into it were actually looked up. */
  verified: boolean;
}

export interface CheckReport {
  issues: CheckIssue[];
  /** Number of issues found; `issues` holds at most MAX_ISSUES of them. */
  total: number;
  records: number;
  refs: number;
  masters: MasterUse[];
}

export const MAX_ISSUES = 1000;
const LIGHT_PLUGIN_INDEX = 0xfe;
/** FormIDs below this are hard-coded by the engine (player, gold, lockpick...) and need no record in the file. */
const ENGINE_RESERVED = 0x800;
const SLICE = 1500;

/** Master file name (any case) -> FormIDs it defines, without the master-index byte. */
export type MasterIds = Map<string, Set<number>>;

export interface CheckOptions {
  masterIds?: MasterIds;
}

/** The IDs a plugin defines, for use as a master in {@link checkPlugin}. */
export function localIds(file: EspFile): Set<number> {
  const out = new Set<number>();
  for (const r of walkRecords(file.nodes)) if (r.type !== "TES4") out.add(r.formId & 0xffffff);
  return out;
}

const hex = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function checkPlugin(file: EspFile, opts: CheckOptions = {}, cancelled: () => boolean = () => false): Promise<CheckReport | null> {
  const { masters, localized } = fileInfo(file);
  const own = new Set<number>();
  for (const r of walkRecords(file.nodes)) if (r.type !== "TES4") own.add(r.formId >>> 0);

  const provided = new Map<string, Set<number>>();
  for (const [name, ids] of opts.masterIds ?? []) provided.set(name.toLowerCase(), ids);
  const uses = masters.map(() => 0);

  const issues: CheckIssue[] = [];
  let total = 0;
  let records = 0;
  let refs = 0;
  const add = (issue: CheckIssue) => {
    total++;
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };

  let n = 0;
  for (const r of walkRecords(file.nodes)) {
    if (r.type === "TES4") continue;
    records++;
    if (++n % SLICE === 0) {
      await yieldToUi();
      if (cancelled()) return null;
    }

    const ownIndex = r.formId >>> 24;
    if (ownIndex > masters.length && ownIndex !== LIGHT_PLUGIN_INDEX) {
      add({
        kind: "own-id",
        record: r,
        where: "Record FormID",
        target: r.formId >>> 0,
        message: `This record's FormID ${hex(r.formId)} uses master slot ${ownIndex}, but the plugin lists only ${masters.length} master${masters.length === 1 ? "" : "s"}.`,
      });
    } else if (ownIndex < masters.length) {
      uses[ownIndex]!++;
    }

    const seen = new Set<number>();
    forEachFormIdRef(r, localized, ({ id, sub, field }) => {
      refs++;
      const slot = id >>> 24;
      const where = `${sub} › ${field}`;
      if (slot === LIGHT_PLUGIN_INDEX) return; // light plugin slot: cannot be resolved from this file alone
      if (slot > masters.length) {
        if (seen.has(id)) return;
        seen.add(id);
        add({
          kind: "undeclared-master",
          record: r,
          where,
          target: id,
          message: `${hex(id)} points at master slot ${slot}, but the plugin lists only ${masters.length} master${masters.length === 1 ? "" : "s"}. A master is missing from the header.`,
        });
        return;
      }
      if (slot < masters.length) {
        uses[slot]!++;
        const ids = provided.get(masters[slot]!.toLowerCase());
        if (ids && !ids.has(id & 0xffffff) && (id & 0xffffff) >= ENGINE_RESERVED) {
          if (seen.has(id)) return;
          seen.add(id);
          add({
            kind: "missing-record",
            record: r,
            where,
            target: id,
            message: `${hex(id)} is not defined in ${masters[slot]}.`,
          });
        }
        return;
      }
      // slot === masters.length: a record of this plugin itself
      if ((id & 0xffffff) < ENGINE_RESERVED) return;
      if (!own.has(id)) {
        if (seen.has(id)) return;
        seen.add(id);
        add({ kind: "missing-record", record: r, where, target: id, message: `${hex(id)} should be a record in this plugin, but it is not there.` });
      }
    });
  }

  return {
    issues,
    total,
    records,
    refs,
    masters: masters.map((name, i) => ({ name, uses: uses[i]!, verified: provided.has(name.toLowerCase()) })),
  };
}
