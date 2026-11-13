// Fields that can appear more than once in a record (items in a container, factions on an NPC...), and where a
// new copy goes. UI-free so it stays testable.
import type { Subrecord } from "./format";

/** Signatures that are lists of entries in the records that use them. SNAM is only a list on NPCs. */
const LIST_SIGS = new Set(["CNTO", "SPLO", "PKID", "LVLO", "PRKR", "EFID", "CTDA"]);

/** Whether the menu should offer "Add another" for this field. */
export function canAddAnother(recordType: string, sig: string, countInRecord: number): boolean {
  if (countInRecord >= 2) return true; // already repeated, so repeating is how this record uses it
  if (sig === "SNAM") return recordType === "NPC_";
  return LIST_SIGS.has(sig);
}

/** Subrecords that belong to the one before them and must stay attached to it (a container item's extra data). */
const FOLLOWERS: Record<string, string> = { CNTO: "COED" };

/** Where a new entry goes so it lands directly under entry `i` and below anything attached to it. */
export function insertionIndex(subs: Subrecord[], i: number): number {
  const follower = subs[i] ? FOLLOWERS[subs[i].type] : undefined;
  let j = i + 1;
  while (follower && subs[j]?.type === follower) j++;
  return j;
}
