// Plain-language record search: "bow", "iron sword", "weapon", "00012EB7".
// Every word must match something about the record; better matches are listed first.
//
// Speed: the text of every record is lower-cased once into an index (built in the background),
// so a search is one cheap string check per record. Both building and searching work in short
// slices and hand control back to the browser between them, so typing and scrolling never freeze.
import { SIGNATURE_NAMES } from "./defs";
import { getDisplayName, getEditorId, hex8, peekSubrecord, walkRecords, type EspFile, type EspRecord } from "./format";

/** Words describing what a weapon is, from its animation type (Skyrim.esm stores no useful name for these). */
const WEAPON_KINDS: Record<number, string[]> = {
  0: ["unarmed", "fist", "handtohand"],
  1: ["sword", "onehanded", "melee"],
  2: ["dagger", "onehanded", "melee"],
  3: ["axe", "onehanded", "melee"],
  4: ["mace", "onehanded", "melee"],
  5: ["greatsword", "sword", "twohanded", "melee"],
  6: ["battleaxe", "waraxe", "axe", "twohanded", "melee"],
  7: ["bow", "ranged"],
  8: ["staff"],
  9: ["crossbow", "ranged"],
};

/** "IronBow02" -> ["iron", "bow", "02"]; "DLC1_Bolt" -> ["dlc", "1", "bolt"]. */
export function splitWords(text: string): string[] {
  return (text.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase());
}

/** "bows" -> "bow", "arrows" -> "arrow", "boxes" -> "box". Short words are left alone. */
function singular(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|xes|sses)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

// A term that looks like part of a FormID is matched against FormIDs, not words.
const FORMID_TERM = /^(0x[0-9a-f]{1,8}|(?=[0-9a-f]*\d)[0-9a-f]{5,8})$/i;

interface Term {
  forms: string[]; // the typed word and its singular, lower-cased
  formId: string | null; // upper-case hex when the term looks like a FormID
}

export function parseQuery(query: string): Term[] {
  return query
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((raw) => {
      const lower = raw.toLowerCase();
      const forms = [...new Set([lower, singular(lower)])];
      return { forms, formId: FORMID_TERM.test(raw) ? raw.replace(/^0x/i, "").toUpperCase() : null };
    });
}

// ---------- per-record-type facts, computed once ----------
interface TypeInfo {
  sig: string; // "weap"
  label: string; // "weapon"
  words: string[]; // ["weapon"]
}
const typeInfos = new Map<string, TypeInfo>();
function typeInfo(type: string): TypeInfo {
  let t = typeInfos.get(type);
  if (!t) {
    const label = (SIGNATURE_NAMES[type] ?? "").toLowerCase();
    t = { sig: type.toLowerCase(), label, words: label.split(/[^a-z]+/).filter(Boolean) };
    typeInfos.set(type, t);
  }
  return t;
}

function weaponWords(r: EspRecord): string[] {
  if (r.type !== "WEAP") return [];
  const dnam = peekSubrecord(r, "DNAM");
  return (dnam && WEAPON_KINDS[dnam[0]!]) || [];
}

/** How well one term matches a record: 0 = no match, higher is better. */
function scoreTerm(term: Term, r: EspRecord, edidLower: string, edidWords: string[], nameWords: string[], nameLower: string, kind: string[], typeWords: string[]): number {
  let best = 0;
  if (term.formId && hex8(r.formId).includes(term.formId)) best = 100;
  for (const t of term.forms) {
    if (edidWords.includes(t) || nameWords.includes(t)) best = Math.max(best, 100); // a whole word, e.g. "bow" in IronBow
    else if (kind.includes(t)) best = Math.max(best, 90); // what it is, e.g. a bow-type weapon
    else if (r.type.toLowerCase() === t) best = Math.max(best, 80); // the record type, e.g. "weap"
    else if (kind.some((k) => k.includes(t))) best = Math.max(best, 70); // a crossbow for "bow"
    else if (typeWords.includes(t)) best = Math.max(best, 60); // "weapon", "armor", "spell"...
    else if (edidWords.some((w) => w.startsWith(t)) || nameWords.some((w) => w.startsWith(t))) best = Math.max(best, 40); // "bowl" for "bow"
    else if (edidLower.includes(t) || nameLower.includes(t)) best = Math.max(best, 20); // "elbow" for "bow"
  }
  return best;
}

// ---------- the index ----------
export interface SearchIndex {
  file: EspFile;
  localized: boolean;
  records: EspRecord[];
  /** Lower-cased "editorid\nname" for each record; "" when it has neither (shared, costs nothing). */
  hay: string[];
}

function hayOf(r: EspRecord, localized: boolean): string {
  if (r.type === "TES4") return "";
  const edid = getEditorId(r) ?? "";
  const name = getDisplayName(r, localized) ?? "";
  return edid || name ? `${edid}\n${name}`.toLowerCase() : "";
}

const SLICE_MS = 12;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Builds the index without freezing the app. Resolves to null if cancelled. */
export async function buildSearchIndex(file: EspFile, localized: boolean, cancelled: () => boolean = () => false): Promise<SearchIndex | null> {
  const records: EspRecord[] = [];
  const hay: string[] = [];
  const it = walkRecords(file.nodes);
  for (;;) {
    const start = now();
    let finished = false;
    while (now() - start < SLICE_MS) {
      const n = it.next();
      if (n.done) {
        finished = true;
        break;
      }
      records.push(n.value);
      hay.push(hayOf(n.value, localized));
    }
    if (finished) break;
    if (cancelled()) return null;
    await tick();
  }
  return { file, localized, records, hay };
}

/** Same index, built in one go (tests and small files). */
export function buildSearchIndexSync(file: EspFile, localized: boolean): SearchIndex {
  const records: EspRecord[] = [];
  const hay: string[] = [];
  for (const r of walkRecords(file.nodes)) {
    records.push(r);
    hay.push(hayOf(r, localized));
  }
  return { file, localized, records, hay };
}

// ---------- searching ----------
/** Scores per bucket; only the first `limit` of each score can ever be shown, so keep no more. */
type Buckets = Map<number, EspRecord[]>;

function scanOne(index: SearchIndex, i: number, terms: Term[], buckets: Buckets, limit: number) {
  const r = index.records[i]!;
  if (r.type === "TES4") return;
  const h = r.dirty ? hayOf(r, index.localized) : index.hay[i]!; // edited records may have a new name
  const ti = typeInfo(r.type);
  // Cheap rejection first: every term must appear somewhere before any real scoring.
  for (const t of terms) {
    let ok = false;
    for (const f of t.forms) {
      if ((h && h.includes(f)) || ti.label.includes(f) || ti.sig === f) {
        ok = true;
        break;
      }
    }
    if (!ok && t.formId !== null && hex8(r.formId).includes(t.formId)) ok = true;
    if (!ok && r.type !== "WEAP") return; // weapons can still match by kind ("bow") without naming it
  }

  const edid = getEditorId(r) ?? "";
  const name = getDisplayName(r, index.localized) ?? "";
  const edidLower = edid.toLowerCase();
  const nameLower = name.toLowerCase();
  const edidWords = splitWords(edid);
  const nameWords = splitWords(name);
  const kind = weaponWords(r);
  let total = 0;
  for (const t of terms) {
    const s = scoreTerm(t, r, edidLower, edidWords, nameWords, nameLower, kind, ti.words);
    if (s === 0) return;
    total += s;
  }
  let bucket = buckets.get(total);
  if (!bucket) buckets.set(total, (bucket = []));
  if (bucket.length < limit) bucket.push(r);
}

function collect(buckets: Buckets, limit: number): EspRecord[] {
  const out: EspRecord[] = [];
  for (const score of [...buckets.keys()].sort((a, b) => b - a)) {
    for (const r of buckets.get(score)!) {
      out.push(r);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** One-letter searches would match nearly everything and are never useful. */
function tooShort(terms: Term[]): boolean {
  return terms.length === 0 || terms.every((t) => t.formId === null && t.forms[0]!.length < 2);
}

/** Searches the index in short slices so typing stays smooth. Resolves to null if cancelled. */
export async function searchIndex(index: SearchIndex, query: string, limit = 500, cancelled: () => boolean = () => false): Promise<EspRecord[] | null> {
  const terms = parseQuery(query);
  if (tooShort(terms)) return [];
  const buckets: Buckets = new Map();
  const n = index.records.length;
  let i = 0;
  while (i < n) {
    const start = now();
    while (i < n && now() - start < SLICE_MS) {
      for (const stop = Math.min(n, i + 256); i < stop; i++) scanOne(index, i, terms, buckets, limit);
    }
    if (i < n) {
      if (cancelled()) return null;
      await tick();
    }
  }
  return cancelled() ? null : collect(buckets, limit);
}

/**
 * Finds records matching every word in the query, best matches first. Matches whole words in
 * the Editor ID (split at capitals, so IronBow = iron + bow) and in the name, the record type
 * (weapon, armor...), and for weapons what kind they are (bow, sword, dagger...).
 * Synchronous version for tests and small files; the app uses buildSearchIndex + searchIndex.
 */
export function searchPlugin(file: EspFile, query: string, limit = 500, localized = false): EspRecord[] {
  const terms = parseQuery(query);
  if (tooShort(terms)) return [];
  const index = buildSearchIndexSync(file, localized);
  const buckets: Buckets = new Map();
  for (let i = 0; i < index.records.length; i++) scanOne(index, i, terms, buckets, limit);
  return collect(buckets, limit);
}
