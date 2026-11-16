// Can this plugin be a light plugin (ESL)? A light plugin has no load-order slot of its own, so the game only accepts it
// when every record it adds has a FormID inside a small window. UI-free.
import { fileInfo, walkRecords, type EspFile, type EspRecord } from "./format";
import { readHeader } from "./header";

/** Window for plugins with the original header version: object IDs 0x800 to 0xFFF. */
export const LIGHT_MIN = 0x800;
export const LIGHT_MAX = 0xfff;
/** Header version from which the lower IDs 0x001 to 0x7FF are allowed too (Creation Kit 1.6.1130 onwards). */
const EXTENDED_FROM = 1.709;

export interface EslReport {
  /** True when the plugin fits the light-plugin window. */
  eligible: boolean;
  /** Already flagged as light. */
  flagged: boolean;
  headerVersion: number;
  /** The lowest object ID allowed for this header version. */
  windowMin: number;
  windowMax: number;
  /** Records the plugin adds (not overrides). */
  newRecords: number;
  /** Of those, how many have an ID outside the window. */
  outside: EspRecord[];
  /** Lowest and highest object IDs among the new records, or null if there are none. */
  lowest: number | null;
  highest: number | null;
  /** The header's next object ID is above the window, which also stops the game treating it as light in some tools. */
  nextIdTooHigh: boolean;
  reasons: string[];
}

export function checkEsl(file: EspFile): EslReport | null {
  const info = readHeader(file);
  if (!info) return null;
  const own = fileInfo(file).masters.length;
  const windowMin = info.version >= EXTENDED_FROM ? 0x001 : LIGHT_MIN;
  const outside: EspRecord[] = [];
  let newRecords = 0;
  let lowest: number | null = null;
  let highest: number | null = null;
  for (const r of walkRecords(file.nodes)) {
    if (r.type === "TES4" || r.formId >>> 24 !== own) continue;
    newRecords++;
    const id = r.formId & 0xffffff;
    lowest = lowest === null ? id : Math.min(lowest, id);
    highest = highest === null ? id : Math.max(highest, id);
    if (id < windowMin || id > LIGHT_MAX) outside.push(r);
  }
  const reasons: string[] = [];
  if (outside.length > 0) {
    reasons.push(`${outside.length.toLocaleString()} of ${newRecords.toLocaleString()} new records have an ID outside ${windowMin.toString(16).toUpperCase().padStart(3, "0")}–${LIGHT_MAX.toString(16).toUpperCase()}.`);
  }
  const nextIdTooHigh = (info.nextObjectId & 0xffffff) > LIGHT_MAX + 1;
  if (nextIdTooHigh && outside.length === 0) reasons.push(`The header's next object ID (${(info.nextObjectId & 0xffffff).toString(16).toUpperCase()}) is above FFF. Some tools check it, so it is worth lowering.`);
  return {
    eligible: outside.length === 0,
    flagged: (info.flags & 0x200) !== 0,
    headerVersion: info.version,
    windowMin,
    windowMax: LIGHT_MAX,
    newRecords,
    outside,
    lowest,
    highest,
    nextIdTooHigh,
    reasons,
  };
}
