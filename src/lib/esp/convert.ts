// Skyrim Special Edition -> Legendary Edition plugin backport. UI-free so it stays testable.
//
// The two editions share the same plugin container (24-byte headers, GRUP nesting, zlib-compressed
// records), so most of a conversion is stamping the LE identifiers on the file and telling the person
// what a plugin alone cannot fix. Nothing here rewrites record contents unless the person asks for it.
import { fixedSize } from "./decode";
import { RECORD_DEFS, findSubDef } from "./defs";
import {
  encodeZString,
  getEditorId,
  getSubrecords,
  markDirty,
  parseEsp,
  serializeEsp,
  walkRecords,
  zstringValue,
  type EspFile,
  type EspRecord,
} from "./format";

/** HEDR version Skyrim LE plugins carry (SE writes 1.7). */
export const LE_HEDR_VERSION = 0.94;
/** Newest record form version LE writes (SE writes 44). */
export const LE_FORM_VERSION = 43;

const FLAG_LOCALIZED = 0x00000080;
const FLAG_ESL = 0x00000200;
const MAX_LAYOUT_FINDINGS = 200;

export type Edition = "SE" | "LE" | "unknown";

export interface EditionInfo {
  edition: Edition;
  /** Version float from the HEDR subrecord (LE 0.94, SE 1.7), if present. */
  hedrVersion: number | null;
  /** Light plugin (ESL) flag: a Special Edition feature. */
  light: boolean;
  /** Highest record form version in the file (LE tops out at 43). */
  newestFormVersion: number;
  /** Why the file was judged Special Edition. Empty unless edition is "SE". */
  reasons: string[];
}

const fmtVersion = (v: number) => String(+v.toFixed(2));

/** Tells a Special Edition plugin from a Legendary Edition one by its header, without decompressing anything. */
export function detectEdition(file: EspFile): EditionInfo {
  const tes4 = file.nodes[0] as EspRecord;
  const hedr = getSubrecords(tes4).find((s) => s.type === "HEDR")?.data;
  const hedrVersion = hedr && hedr.length >= 4 ? new DataView(hedr.buffer, hedr.byteOffset, hedr.byteLength).getFloat32(0, true) : null;
  const light = (tes4.flags & FLAG_ESL) !== 0;
  let newestFormVersion = 0;
  for (const r of walkRecords(file.nodes)) if (r.version > newestFormVersion) newestFormVersion = r.version;

  const reasons: string[] = [];
  if (hedrVersion !== null && hedrVersion >= 1) reasons.push(`Header version is ${fmtVersion(hedrVersion)} (Legendary Edition uses 0.94)`);
  if (light) reasons.push("Flagged as a light plugin (ESL), which only Special Edition supports");
  if (newestFormVersion > LE_FORM_VERSION) reasons.push(`Records use form version ${newestFormVersion} (Legendary Edition tops out at ${LE_FORM_VERSION})`);
  if (/\.esl$/i.test(file.name)) reasons.push("The file has an .esl extension, which Legendary Edition does not load");

  const edition: Edition = reasons.length > 0 ? "SE" : hedrVersion !== null && hedrVersion < 1 ? "LE" : "unknown";
  return { edition, hedrVersion, light, newestFormVersion, reasons };
}

/** Plugin names that only exist in Special Edition: Creation Club content and its resource pack. */
export function isLikelySeOnlyMaster(name: string): boolean {
  return /^cc[a-z0-9_-]+\.(esm|esl|esp)$/i.test(name) || /^_ResourcePack\.esl$/i.test(name);
}

/** "Mod.esl" -> "Mod.esp". Legendary Edition only loads .esp and .esm. */
export const leFileName = (name: string) => name.replace(/\.esl$/i, ".esp");

export interface ConvertOptions {
  /** Rename masters ending in .esl to .esp, matching what converting those plugins produces. Default true. */
  renameEslMasters?: boolean;
  /**
   * Cut subrecords that are longer than the layout the editor knows for LE. Off by default: the editor's
   * layouts are hand-written and cover only part of the game, so a longer subrecord is a hint, not proof.
   */
  trimToLeLayout?: boolean;
}

/** A kind of subrecord whose size does not match the Legendary Edition layout the editor describes. */
export interface LayoutFinding {
  recordType: string;
  sub: string;
  /** Size of the LE layout. */
  expected: number;
  /** Size found in the plugin. */
  actual: number;
  count: number;
  /** One record that has it, to look at. */
  exampleFormId: number;
  exampleEditorId: string | null;
  trimmed: boolean;
}

export interface ConvertReport {
  /** What was changed in the file. */
  changes: string[];
  /** What the file still needs that a plugin conversion cannot supply. */
  warnings: string[];
  layout: LayoutFinding[];
  /** Records checked against the editor's layouts (record types it has no layouts for are skipped). */
  scanned: number;
}

export interface ConvertResult {
  bytes: Uint8Array;
  /** File name to save under (.esl becomes .esp). */
  name: string;
  report: ConvertReport;
}

/**
 * Things a plugin conversion does not touch. They live in other files, so the person has to deal with them
 * separately (and the editor cannot check for them).
 */
export const NOT_CONVERTED: readonly string[] = [
  "Meshes (.nif): Special Edition and Legendary Edition use different NIF versions. Convert them with a tool such as NifSkope or Cathedral Assets Optimizer.",
  "Textures: Special Edition can use BC7 compression, which Legendary Edition cannot read. Re-save those textures as BC1, BC3 or uncompressed.",
  "Archives (.bsa): Special Edition archives use a newer format (LZ4) that Legendary Edition cannot open. Unpack them and use the loose files, or repack them for Legendary Edition.",
  "Animations and behaviors (.hkx): the two editions use different Havok formats (32-bit and 64-bit), so animations need converting too.",
  "Strings files: a localized plugin keeps its text in separate .STRINGS files. Special Edition can write those as UTF-8, where Legendary Edition expects Windows-1252, so non-English text needs re-encoding.",
  "Scripts and SKSE: Papyrus scripts are separate files, and mods that need SKSE64 will not work with Legendary Edition's SKSE.",
];

/**
 * Builds a Legendary Edition copy of a Special Edition plugin. The open file is left alone (unsaved edits are included
 * in the copy), and records the conversion does not need to touch keep their original bytes.
 */
export function convertToLe(file: EspFile, opts: ConvertOptions = {}): ConvertResult {
  const renameEslMasters = opts.renameEslMasters ?? true;
  const copy = parseEsp(serializeEsp(file), file.name);
  const tes4 = copy.nodes[0] as EspRecord;
  const changes: string[] = [];
  const warnings: string[] = [];

  // ----- header -----
  markDirty(tes4);
  const headerSubs = getSubrecords(tes4);
  const hedr = headerSubs.find((s) => s.type === "HEDR");
  if (hedr && hedr.data.length >= 4) {
    const dv = new DataView(hedr.data.buffer, hedr.data.byteOffset, hedr.data.byteLength);
    const before = dv.getFloat32(0, true);
    if (Math.abs(before - LE_HEDR_VERSION) > 0.001) {
      dv.setFloat32(0, LE_HEDR_VERSION, true);
      changes.push(`Header version ${fmtVersion(before)} → ${LE_HEDR_VERSION}`);
    }
  } else {
    warnings.push("The file has no usable HEDR subrecord, so its header version could not be set.");
  }

  if (tes4.flags & FLAG_ESL) {
    tes4.flags = (tes4.flags & ~FLAG_ESL) >>> 0;
    changes.push("Cleared the light plugin (ESL) flag. Legendary Edition has no light plugins, so this takes a normal load order slot.");
  }

  // ----- record form versions -----
  let downgraded = 0;
  for (const r of walkRecords(copy.nodes)) {
    if (r.version > LE_FORM_VERSION) {
      r.version = LE_FORM_VERSION;
      downgraded++;
    }
  }
  if (downgraded > 0) changes.push(`Set the form version to ${LE_FORM_VERSION} on ${downgraded.toLocaleString()} record${downgraded === 1 ? "" : "s"} (was higher)`);

  // ----- masters -----
  for (const s of headerSubs) {
    if (s.type !== "MAST") continue;
    const name = zstringValue(s.data);
    if (/\.esl$/i.test(name)) {
      if (renameEslMasters) {
        const renamed = leFileName(name);
        s.data = encodeZString(renamed);
        changes.push(`Master ${name} renamed to ${renamed}`);
        warnings.push(`${renamed} has to be a Legendary Edition copy of ${name}. Convert that plugin as well and keep the new name.`);
      } else {
        warnings.push(`Master ${name} is a light plugin, which Legendary Edition cannot load.`);
      }
    } else if (isLikelySeOnlyMaster(name)) {
      warnings.push(`Master ${name} looks like Creation Club content, which Legendary Edition does not have. Records that use it will not work.`);
    }
  }
  if (headerSubs.some((s) => s.type === "MAST")) {
    warnings.push("Run Check plugin on the result with Legendary Edition's Skyrim.esm (and the other masters) added. Special Edition's Skyrim.esm has records that Legendary Edition's lacks.");
  }

  // ----- subrecord sizes against the Legendary Edition layouts the editor knows -----
  const localized = (tes4.flags & FLAG_LOCALIZED) !== 0;
  const groups = new Map<string, LayoutFinding>();
  let scanned = 0;
  for (const r of walkRecords(copy.nodes)) {
    if (r.type === "TES4" || !RECORD_DEFS[r.type]) continue;
    scanned++;
    let subs;
    try {
      subs = getSubrecords(r);
    } catch {
      continue; // unreadable record: left exactly as it was
    }
    subs.forEach((s, i) => {
      const found = findSubDef(r.type, s.type);
      if (!found || typeof found.def === "function") return;
      const expected = fixedSize(found.def, localized);
      if (expected === null || s.data.length <= expected) return; // only longer data hints at an SE addition
      const key = `${r.type}:${s.type}:${expected}:${s.data.length}`;
      const trim = opts.trimToLeLayout === true;
      const existing = groups.get(key);
      if (existing) existing.count++;
      else
        groups.set(key, {
          recordType: r.type,
          sub: s.type,
          expected,
          actual: s.data.length,
          count: 1,
          exampleFormId: r.formId,
          exampleEditorId: getEditorId(r),
          trimmed: trim,
        });
      if (trim) {
        markDirty(r);
        subs[i] = { type: s.type, data: s.data.slice(0, expected) };
      }
    });
  }
  const layout = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, MAX_LAYOUT_FINDINGS);
  if (opts.trimToLeLayout) {
    const total = [...groups.values()].reduce((n, g) => n + g.count, 0);
    if (total > 0) changes.push(`Trimmed ${total.toLocaleString()} subrecord${total === 1 ? "" : "s"} down to the Legendary Edition layout`);
  }

  return {
    bytes: serializeEsp(copy),
    name: leFileName(file.name),
    report: { changes, warnings, layout, scanned },
  };
}
