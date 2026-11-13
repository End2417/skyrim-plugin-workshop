// What a master file defines, by name: its records' Editor IDs, display names and types, kept so a plugin that
// depends on it can show and search those records without the master being open. UI-free so it stays testable.
import { getEditorId, peekSubrecord, walkRecords, zstringValue, fileInfo, type EspFile, type EspRecord } from "./format";
import { parseQuery, scoreTerm, splitWords, typeInfo } from "./search";
import type { StringTable } from "./strings";

/** Records a master file owns, as parallel arrays sorted by local ID (the FormID without the master-index byte). */
export interface MasterNames {
  ids: Uint32Array;
  /** Index into `types` for each record. */
  typeIdx: Uint8Array;
  types: string[];
  edids: string[];
  /** "" when the record has no name (or it is in a strings file that was not available). */
  names: string[];
}

function nameOf(r: EspRecord, localized: boolean, table: StringTable | null): string {
  try {
    const d = peekSubrecord(r, "FULL");
    if (!d) return "";
    if (!localized) return zstringValue(d);
    if (d.length !== 4) return "";
    return table?.get(new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Indexes the records a master file defines itself. Records it only overrides are left out: from another plugin the
 * original record is the one to point at, and the override's ID would name a different slot.
 */
export function buildMasterNames(file: EspFile, table: StringTable | null): MasterNames {
  const { masters, localized } = fileInfo(file);
  const rows: { id: number; type: string; edid: string; name: string }[] = [];
  for (const r of walkRecords(file.nodes)) {
    if (r.type === "TES4" || r.formId >>> 24 !== masters.length) continue;
    const edid = getEditorId(r) ?? "";
    const name = nameOf(r, localized, table);
    if (!edid && !name) continue; // placed references and the like have nothing to search by
    rows.push({ id: r.formId & 0xffffff, type: r.type, edid, name });
  }
  rows.sort((a, b) => a.id - b.id);
  const types: string[] = [];
  const typeOf = new Map<string, number>();
  const typeIdx = new Uint8Array(rows.length);
  rows.forEach((row, i) => {
    let t = typeOf.get(row.type);
    if (t === undefined) {
      t = types.length;
      types.push(row.type);
      typeOf.set(row.type, t);
    }
    typeIdx[i] = Math.min(t, 255);
  });
  return { ids: Uint32Array.from(rows.map((r) => r.id)), typeIdx, types, edids: rows.map((r) => r.edid), names: rows.map((r) => r.name) };
}

/** Position of a record in the index, or -1. */
export function findMasterEntry(m: MasterNames, localId: number): number {
  let lo = 0;
  let hi = m.ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = m.ids[mid]!;
    if (v === localId) return mid;
    if (v < localId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const hex = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** The same wording the editor uses for a reference: `SteelSword "Steel Sword" [WEAP:00013989]`. */
export function describeMasterEntry(m: MasterNames, i: number, formId: number): string {
  const edid = m.edids[i] ?? "";
  const name = m.names[i] ?? "";
  return `${edid}${name ? ` "${name}"` : ""} [${m.types[m.typeIdx[i]!]}:${hex(formId)}]`.trim();
}

const hayCache = new WeakMap<MasterNames, string[]>();
function hayOf(m: MasterNames): string[] {
  let h = hayCache.get(m);
  if (!h) {
    h = m.edids.map((e, i) => `${e}\n${m.names[i]}`.toLowerCase());
    hayCache.set(m, h);
  }
  return h;
}

/** Positions of the records matching every word of the query, best matches first. */
export function searchMasterNames(m: MasterNames, query: string, limit: number): number[] {
  const terms = parseQuery(query);
  if (terms.length === 0 || terms.every((t) => t.formId === null && t.forms[0]!.length < 2)) return [];
  const hay = hayOf(m);
  const scored: { i: number; score: number }[] = [];
  for (let i = 0; i < hay.length; i++) {
    const h = hay[i]!;
    const type = m.types[m.typeIdx[i]!]!;
    const ti = typeInfo(type);
    // Cheap test first: each word must appear in the text, name the record type, or be part of its ID
    let ok = true;
    for (const t of terms) {
      const inText = t.forms.some((f) => h.includes(f));
      const inType = t.forms.some((f) => ti.sig === f || ti.words.includes(f));
      const inId = t.formId !== null && hex(m.ids[i]!).includes(t.formId);
      if (!inText && !inType && !inId) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const edid = m.edids[i]!;
    const name = m.names[i]!;
    const edidWords = splitWords(edid);
    const nameWords = splitWords(name);
    let total = 0;
    for (const t of terms) {
      const s = scoreTerm(t, { type, formId: m.ids[i]! }, edid.toLowerCase(), edidWords, nameWords, name.toLowerCase(), [], ti.words);
      if (s === 0) {
        total = 0;
        break;
      }
      total += s;
    }
    if (total > 0) scored.push({ i, score: total });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.i);
}
