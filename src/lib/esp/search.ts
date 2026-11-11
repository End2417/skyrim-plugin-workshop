// Plain-language record search: "bow", "iron sword", "weapon", "00012EB7".
// Every word must match something about the record; better matches are listed first.
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
    else if (edidLower.includes(t) || nameLower.includes(t)) best = Math.max(best, 20); // "crossbow" for "bow"
  }
  return best;
}

/**
 * Finds records matching every word in the query, best matches first. Matches whole words in
 * the Editor ID (split at capitals, so IronBow = iron + bow) and in the name, the record type
 * (weapon, armor...), and for weapons what kind they are (bow, sword, dagger...).
 */
export function searchPlugin(file: EspFile, query: string, limit = 500, localized = false): EspRecord[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const hits: { r: EspRecord; score: number; order: number }[] = [];
  let order = 0;
  for (const r of walkRecords(file.nodes)) {
    order++;
    if (r.type === "TES4") continue;
    const edid = getEditorId(r) ?? "";
    const name = getDisplayName(r, localized) ?? "";
    const edidLower = edid.toLowerCase();
    const nameLower = name.toLowerCase();
    // Cheap rejection first: every term must appear somewhere before we do any real scoring.
    const typeLabel = (SIGNATURE_NAMES[r.type] ?? "").toLowerCase();
    const formIdText = hex8(r.formId);
    let possible = true;
    for (const t of terms) {
      const found = t.forms.some((f) => edidLower.includes(f) || nameLower.includes(f) || typeLabel.includes(f) || r.type.toLowerCase() === f) || (t.formId !== null && formIdText.includes(t.formId));
      if (!found && r.type !== "WEAP") {
        possible = false;
        break;
      }
    }
    if (!possible) continue;

    const edidWords = splitWords(edid);
    const nameWords = splitWords(name);
    const typeWords = typeLabel.split(/[^a-z]+/).filter(Boolean);
    const kind = weaponWords(r);
    let total = 0;
    for (const t of terms) {
      const s = scoreTerm(t, r, edidLower, edidWords, nameWords, nameLower, kind, typeWords);
      if (s === 0) {
        total = 0;
        break;
      }
      total += s;
    }
    if (total > 0) hits.push({ r, score: total, order });
  }
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map((h) => h.r);
}
