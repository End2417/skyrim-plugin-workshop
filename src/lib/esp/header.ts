// Editing the plugin's header record (TES4): author, description, ESM/ESL flags and the master list. UI-free.
//
// The master list is only partly editable on purpose. The master-index byte of every FormID counts the masters, and the
// plugin's own records use the number of masters as their index, so adding, removing or reordering a master renumbers
// every FormID of the plugin's own records and every reference to them. The editor only knows the reference fields of the
// record types it has layouts for, so it cannot renumber safely. What is safe is offered: renaming a master (fixing its
// spelling or extension), and adding one to a plugin that has no records of its own.
import { encodeZString, fileInfo, getSubrecords, markDirty, walkRecords, zstringValue, type EspFile, type EspRecord, type Subrecord } from "./format";

export const HEADER_FLAG_ESM = 0x1;
export const HEADER_FLAG_ESL = 0x200;

export interface HeaderInfo {
  author: string;
  description: string;
  masters: string[];
  flags: number;
  /** Header version (HEDR), such as 0.94 or 1.7. */
  version: number;
  /** Records and groups the header says the file holds. */
  recordCount: number;
  nextObjectId: number;
  /** Records whose FormID is in this plugin's own range (new records, not overrides). */
  ownRecords: number;
  localized: boolean;
}

const tes4 = (file: EspFile): EspRecord | null => {
  const t = file.nodes[0];
  return t && t.kind === "record" && t.type === "TES4" ? t : null;
};

/** Order of the header's subrecords in a plugin; new ones are put where they belong. */
const ORDER = ["HEDR", "OFST", "DELE", "CNAM", "SNAM", "MAST", "DATA", "ONAM", "SCRN", "INTV", "INCC"];

function insertAt(subs: Subrecord[], type: string): number {
  const rank = ORDER.indexOf(type);
  let at = 0;
  subs.forEach((s, i) => {
    const r = ORDER.indexOf(s.type);
    if (r >= 0 && r <= rank) at = i + 1;
  });
  return at;
}

export function readHeader(file: EspFile): HeaderInfo | null {
  const t = tes4(file);
  if (!t) return null;
  const subs = getSubrecords(t);
  const text = (type: string) => {
    const s = subs.find((x) => x.type === type);
    return s ? zstringValue(s.data) : "";
  };
  const hedr = subs.find((s) => s.type === "HEDR");
  const dv = hedr && hedr.data.length >= 12 ? new DataView(hedr.data.buffer, hedr.data.byteOffset, hedr.data.byteLength) : null;
  const { masters, localized } = fileInfo(file);
  let own = 0;
  for (const r of walkRecords(file.nodes)) if (r.type !== "TES4" && r.formId >>> 24 === masters.length) own++;
  return {
    author: text("CNAM"),
    description: text("SNAM"),
    masters,
    flags: t.flags,
    version: dv ? dv.getFloat32(0, true) : 0,
    recordCount: dv ? dv.getInt32(4, true) : 0,
    nextObjectId: dv ? dv.getUint32(8, true) : 0,
    ownRecords: own,
    localized,
  };
}

/** Sets the author (CNAM) or description (SNAM). Empty text removes it. */
export function setHeaderText(file: EspFile, type: "CNAM" | "SNAM", text: string): void {
  const t = tes4(file);
  if (!t) throw new Error("This file has no header record");
  if (text.length > 511) throw new Error("That text is too long (at most 511 characters).");
  markDirty(t);
  const subs = getSubrecords(t);
  const at = subs.findIndex((s) => s.type === type);
  if (!text) {
    if (at >= 0) subs.splice(at, 1);
    return;
  }
  const sub: Subrecord = { type, data: encodeZString(text) };
  if (at >= 0) subs[at] = sub;
  else subs.splice(insertAt(subs, type), 0, sub);
}

/** Turns the ESM or ESL flag on or off. */
export function setHeaderFlag(file: EspFile, flag: number, on: boolean): void {
  const t = tes4(file);
  if (!t) throw new Error("This file has no header record");
  if (flag !== HEADER_FLAG_ESM && flag !== HEADER_FLAG_ESL) throw new Error("Only the ESM and ESL flags can be changed here.");
  markDirty(t);
  t.flags = (on ? t.flags | flag : t.flags & ~flag) >>> 0;
}

export const validMasterName = (name: string) => /^[^\\/:*?"<>|\r\n]+\.(esm|esp|esl)$/i.test(name) && name.length <= 250;

/** Why a master cannot be added to this plugin, or null if it can. */
export function addMasterProblem(file: EspFile, name: string): string | null {
  const info = readHeader(file);
  if (!info) return "This file has no header record.";
  if (!validMasterName(name)) return "Enter a file name ending in .esm, .esp or .esl.";
  if (info.masters.some((m) => m.toLowerCase() === name.toLowerCase())) return `${name} is already a master.`;
  if (info.masters.length >= 253) return "A plugin can have at most 253 masters here.";
  if (info.ownRecords > 0) {
    return `This plugin has ${info.ownRecords.toLocaleString()} record${info.ownRecords === 1 ? "" : "s"} of its own. Adding a master would renumber their FormIDs and every reference to them, which the editor cannot do safely. Use xEdit's "Add Masters" for that.`;
  }
  return null;
}

/** Adds a master at the end of the list. Only for plugins with no records of their own (see addMasterProblem). */
export function addMaster(file: EspFile, name: string): void {
  const problem = addMasterProblem(file, name);
  if (problem) throw new Error(problem);
  const t = tes4(file)!;
  markDirty(t);
  const subs = getSubrecords(t);
  const at = insertAt(subs, "DATA");
  subs.splice(at, 0, { type: "MAST", data: encodeZString(name) }, { type: "DATA", data: new Uint8Array(8) });
}

/** Changes the spelling or extension of a master's file name. The order does not change, so no FormID does. */
export function renameMaster(file: EspFile, index: number, name: string): void {
  const t = tes4(file);
  if (!t) throw new Error("This file has no header record");
  if (!validMasterName(name)) throw new Error("Enter a file name ending in .esm, .esp or .esl.");
  const subs = getSubrecords(t);
  const mast = subs.filter((s) => s.type === "MAST");
  const target = mast[index];
  if (!target) throw new Error("There is no such master.");
  if (mast.some((m, i) => i !== index && zstringValue(m.data).toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already a master.`);
  markDirty(t);
  const at = getSubrecords(t).indexOf(target);
  getSubrecords(t)[at] = { type: "MAST", data: encodeZString(name) };
}
