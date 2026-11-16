// Duplicates and orphans inside one plugin: records sharing an Editor ID or a FormID, groups whose parent record is
// missing, and records the rest of the plugin never points at. UI-free.
//
// The "never pointed at" list is only a lead. Only fields the editor has layouts for are read (see refs.ts), and many
// records are used from outside the plugin (scripts, other mods), so it is limited to supporting types that are almost
// always used by something in the same plugin, and the report says how many records could not be read.
import { RECORD_DEFS } from "./defs";
import { fileInfo, getEditorId, walkRecords, type EspFile, type EspGroup, type EspNode, type EspRecord } from "./format";
import { forEachFormIdRef } from "./refs";

export interface DuplicateSet {
  key: string;
  records: EspRecord[];
}

export interface OrphanGroup {
  group: EspGroup;
  /** FormID of the parent record the group names. */
  parentId: number;
  kind: string;
}

export interface HealthReport {
  duplicateEditorIds: DuplicateSet[];
  duplicateFormIds: DuplicateSet[];
  orphanGroups: OrphanGroup[];
  /** New records of supporting types that nothing else in this plugin points at. */
  unreferenced: EspRecord[];
  /** Records of types the editor has no layout for: their references were not seen. */
  unreadable: number;
  scanned: number;
}

/** Types that exist to be used by other records and are rarely used only from outside the plugin. */
export const SUPPORTING_TYPES = new Set(["ARMA", "ARTO", "ASPC", "ENCH", "EXPL", "EFSH", "FLST", "HAZD", "IMAD", "IPCT", "IPDS", "LGTM", "MATO", "MATT", "OTFT", "PROJ", "SNDR", "TXST", "SHOU", "WOOP"]);

const GROUP_PARENT_KIND: Record<number, string> = {
  1: "world children",
  6: "cell children",
  7: "topic children",
  8: "persistent cell children",
  9: "temporary cell children",
  10: "visible distant children",
};

const SLICE = 2000;
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const labelId = (g: EspGroup) => new DataView(g.label.buffer, g.label.byteOffset, g.label.byteLength).getUint32(0, true);

function* walkGroups(nodes: EspNode[]): Generator<EspGroup> {
  for (const n of nodes) {
    if (n.kind === "group") {
      yield n;
      yield* walkGroups(n.children);
    }
  }
}

/** Scans the whole plugin in short slices. Returns null if cancelled. */
export async function scanHealth(file: EspFile, cancelled: () => boolean = () => false): Promise<HealthReport | null> {
  const { masters, localized } = fileInfo(file);
  const own = masters.length;
  const byEdid = new Map<string, EspRecord[]>();
  const byId = new Map<number, EspRecord[]>();
  const referenced = new Set<number>();
  const records: EspRecord[] = [];
  let unreadable = 0;
  let n = 0;
  for (const r of walkRecords(file.nodes)) {
    if (r.type === "TES4") continue;
    if (++n % SLICE === 0) {
      await yieldToUi();
      if (cancelled()) return null;
    }
    records.push(r);
    const id = r.formId >>> 0;
    const sameId = byId.get(id);
    if (sameId) sameId.push(r);
    else byId.set(id, [r]);
    let edid: string | null = null;
    try {
      edid = getEditorId(r);
    } catch {
      /* unreadable record: skipped for duplicates */
    }
    if (edid) {
      const k = edid.toLowerCase();
      const list = byEdid.get(k);
      if (list) list.push(r);
      else byEdid.set(k, [r]);
    }
    if (!RECORD_DEFS[r.type]) unreadable++;
    else forEachFormIdRef(r, localized, (ref) => referenced.add(ref.id >>> 0));
  }

  const dupes = (m: Map<string | number, EspRecord[]>, fmt: (k: string | number) => string): DuplicateSet[] =>
    [...m.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: fmt(k), records: v })).sort((a, b) => b.records.length - a.records.length || a.key.localeCompare(b.key));

  const orphanGroups: OrphanGroup[] = [];
  for (const g of walkGroups(file.nodes)) {
    const kind = GROUP_PARENT_KIND[g.groupType];
    if (!kind || g.label.length < 4) continue;
    const parentId = labelId(g) >>> 0;
    if (!byId.has(parentId)) orphanGroups.push({ group: g, parentId, kind });
  }

  const unreferenced = records.filter((r) => SUPPORTING_TYPES.has(r.type) && r.formId >>> 24 === own && !referenced.has(r.formId >>> 0));

  return {
    duplicateEditorIds: dupes(byEdid as Map<string | number, EspRecord[]>, String),
    duplicateFormIds: dupes(byId as Map<string | number, EspRecord[]>, (k) => (Number(k) >>> 0).toString(16).toUpperCase().padStart(8, "0")),
    orphanGroups,
    unreferenced,
    unreadable,
    scanned: records.length,
  };
}
