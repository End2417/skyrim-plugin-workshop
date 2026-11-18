// Papyrus script report. Records that carry scripts (quests, NPCs, activators, weapons...) store them in a VMAD
// subrecord: script names and the values of their properties. The compiled scripts (.pex) are separate files and are not
// in the plugin, so this lists which scripts the plugin expects, which libraries they look like they come from, and
// property values that point at records that cannot be found. UI-free so it stays testable.
//
// The VMAD layout below follows the community documentation (UESP) for Skyrim LE and SE. It has not been checked against
// a large set of real mods, so every read is bounds-checked and a record that does not parse is reported, never guessed at.
import { decodeText, fileInfo, hex8, peekSubrecord, walkRecords, type EspFile, type EspRecord } from "./format";

/** One script attached to a record, a quest alias, or a fragment (dialogue, package, quest stage). */
export interface ScriptRef {
  name: string;
  kind: "script" | "fragment" | "alias";
  /** Script status flags as stored (0 normal, 1 inherited, 3 removed). */
  status: number;
  properties: ScriptProperty[];
  /** For an alias script: which alias of the quest it belongs to. */
  aliasId?: number;
}

export interface ScriptProperty {
  name: string;
  type: number;
  typeName: string;
  /** Property status flags as stored (1 edited, 3 removed). */
  status: number;
  /** Object properties: the FormID and the alias it is filled with (-1: none). */
  formId?: number;
  alias?: number;
  /** A short display of the value. */
  text: string;
}

export interface VmadInfo {
  version: number;
  objectFormat: number;
  scripts: ScriptRef[];
  /** False when part of the data could not be read (the scripts found so far are still listed). */
  complete: boolean;
  note?: string;
}

const TYPE_NAMES: Record<number, string> = {
  0: "None",
  1: "Object",
  2: "String",
  3: "Int",
  4: "Float",
  5: "Bool",
  11: "Object[]",
  12: "String[]",
  13: "Int[]",
  14: "Float[]",
  15: "Bool[]",
};

class VmadError extends Error {}

class Reader {
  readonly dv: DataView;
  o = 0;
  /** Called with every object FormID read and the offset it sits at, so a caller can rewrite it. */
  visitor: ((formId: number, at: number) => void) | undefined;
  constructor(readonly d: Uint8Array) {
    this.dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
  private need(n: number) {
    if (this.o + n > this.d.length) throw new VmadError("The script data ends too early");
  }
  get left() {
    return this.d.length - this.o;
  }
  u8() {
    this.need(1);
    return this.dv.getUint8(this.o++);
  }
  u16() {
    this.need(2);
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.dv.getInt16(this.o, true);
    this.o += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.dv.getInt32(this.o, true);
    this.o += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.dv.getFloat32(this.o, true);
    this.o += 4;
    return v;
  }
  /** Text with a 16-bit length in front. */
  wstring(): string {
    const n = this.u16();
    this.need(n);
    const s = decodeText(this.d.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

/** Papyrus script and property names: letters, digits, underscores, and "::" in struct names. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_:]*$/;

function readObject(r: Reader, objectFormat: number): { formId: number; alias: number } {
  if (objectFormat === 1) {
    const at = r.o;
    const formId = r.u32();
    const alias = r.i16();
    r.u16();
    r.visitor?.(formId, at);
    return { formId, alias };
  }
  r.u16();
  const alias = r.i16();
  const at = r.o;
  const formId = r.u32();
  r.visitor?.(formId, at);
  return { formId, alias };
}

const MAX_ARRAY = 100_000;

function readProperty(r: Reader, objectFormat: number): ScriptProperty {
  const name = r.wstring();
  const type = r.u8();
  const status = r.u8();
  const typeName = TYPE_NAMES[type] ?? `type ${type}`;
  const prop: ScriptProperty = { name, type, typeName, status, text: "" };
  switch (type) {
    case 0:
      prop.text = "(none)";
      break;
    case 1: {
      const o = readObject(r, objectFormat);
      prop.formId = o.formId;
      prop.alias = o.alias;
      prop.text = o.formId === 0 && o.alias < 0 ? "(none)" : `${hex8(o.formId)}${o.alias >= 0 ? ` alias ${o.alias}` : ""}`;
      break;
    }
    case 2:
      prop.text = JSON.stringify(r.wstring());
      break;
    case 3:
      prop.text = String(r.i32());
      break;
    case 4:
      prop.text = String(+r.f32().toFixed(4));
      break;
    case 5:
      prop.text = r.u8() ? "true" : "false";
      break;
    case 11:
    case 12:
    case 13:
    case 14:
    case 15: {
      const n = r.u32();
      if (n > MAX_ARRAY) throw new VmadError(`An array in property ${name} claims ${n.toLocaleString()} entries`);
      let first = "";
      for (let i = 0; i < n; i++) {
        let shown: string;
        if (type === 11) {
          const o = readObject(r, objectFormat);
          if (i === 0) {
            prop.formId = o.formId;
            prop.alias = o.alias;
          }
          shown = hex8(o.formId);
        } else if (type === 12) shown = JSON.stringify(r.wstring());
        else if (type === 13) shown = String(r.i32());
        else if (type === 14) shown = String(+r.f32().toFixed(4));
        else shown = r.u8() ? "true" : "false";
        if (i === 0) first = shown;
      }
      prop.text = n === 0 ? "[] (empty)" : n === 1 ? `[${first}]` : `[${first}, … ${n} entries]`;
      break;
    }
    default:
      throw new VmadError(`Property ${name} has a type (${type}) this reader does not know`);
  }
  return prop;
}

function readScript(r: Reader, objectFormat: number, version: number, kind: ScriptRef["kind"]): ScriptRef {
  const name = r.wstring();
  if (!IDENT.test(name)) throw new VmadError(`"${name.slice(0, 40)}" does not look like a script name`);
  const status = version >= 4 ? r.u8() : 0;
  const count = r.u16();
  const properties: ScriptProperty[] = [];
  for (let i = 0; i < count; i++) properties.push(readProperty(r, objectFormat));
  return { name, kind, status, properties };
}

/**
 * Reads the script list of a VMAD subrecord (plus fragment and alias scripts for quests, dialogue and packages).
 * `visitor` is called for every object FormID found (script properties, array entries, quest alias owners) with the
 * offset of its 4 bytes in `data`; merging uses it to renumber them.
 */
export function readVmad(data: Uint8Array, recordType: string, visitor?: (formId: number, at: number) => void): VmadInfo {
  const r = new Reader(data);
  r.visitor = visitor;
  const info: VmadInfo = { version: 0, objectFormat: 0, scripts: [], complete: true };
  try {
    info.version = r.i16();
    info.objectFormat = r.i16();
    if (info.version < 3 || info.version > 5) throw new VmadError(`Script data version ${info.version} is not one this reader knows`);
    if (info.objectFormat !== 1 && info.objectFormat !== 2) throw new VmadError(`Script data object format ${info.objectFormat} is not one this reader knows`);
    const count = r.u16();
    for (let i = 0; i < count; i++) info.scripts.push(readScript(r, info.objectFormat, info.version, "script"));
  } catch (e) {
    info.complete = false;
    info.note = e instanceof Error ? e.message : String(e);
    return info;
  }

  // What follows the script list depends on the record type. A failure here keeps the scripts already found.
  try {
    if (r.left === 0) return info;
    if (recordType === "QUST") readQuestExtras(r, info);
    else if (recordType === "INFO" || recordType === "PACK") readFragmentFile(r, info);
    else {
      info.complete = false;
      info.note = `Fragment scripts of ${recordType} records are not listed.`;
    }
  } catch (e) {
    info.complete = false;
    info.note = `${e instanceof Error ? e.message : String(e)} after the main scripts; fragment and alias scripts may be missing.`;
  }
  return info;
}

function addUnique(info: VmadInfo, s: ScriptRef) {
  if (!info.scripts.some((x) => x.name === s.name && x.kind === s.kind && x.aliasId === s.aliasId)) info.scripts.push(s);
}

/** INFO and PACK: a flags byte, then the name of the fragment script. */
function readFragmentFile(r: Reader, info: VmadInfo) {
  r.u8(); // always 2
  r.u8(); // which fragments exist
  const fileName = r.wstring();
  if (fileName && IDENT.test(fileName)) addUnique(info, { name: fileName, kind: "fragment", status: 0, properties: [] });
}

/** QUST: stage fragments (one script file), then the scripts of every alias. */
function readQuestExtras(r: Reader, info: VmadInfo) {
  r.u8(); // always 2
  const fragments = r.u16();
  const fileName = r.wstring();
  if (fragments > 0 && fileName && IDENT.test(fileName)) addUnique(info, { name: fileName, kind: "fragment", status: 0, properties: [] });
  for (let i = 0; i < fragments; i++) {
    r.u16(); // stage
    r.i16();
    r.i32(); // log entry
    r.u8();
    r.wstring(); // script name
    r.wstring(); // fragment name
  }
  const aliases = r.u16();
  for (let i = 0; i < aliases; i++) {
    const o = readObject(r, info.objectFormat);
    const version = r.i16();
    const objectFormat = r.i16();
    const count = r.u16();
    for (let k = 0; k < count; k++) {
      const s = readScript(r, objectFormat, version, "alias");
      s.aliasId = o.alias;
      addUnique(info, s);
    }
  }
}

// ---------- libraries ----------

export interface Library {
  name: string;
  /** What has to be installed for scripts from it to work. */
  needs: string;
}

/**
 * Script names that belong to well-known libraries, so the report can say what a mod needs. This only goes by names: a
 * script that is not listed here may need SKSE as well, because that cannot be seen from the plugin.
 */
const LIBRARIES: { test: RegExp; lib: Library }[] = [
  { test: /^SKI_/i, lib: { name: "SkyUI", needs: "SKSE and SkyUI" } },
  { test: /^MCM(_ConfigBase(Script)?)?$/i, lib: { name: "MCM Helper", needs: "SKSE, SkyUI and MCM Helper" } },
  { test: /^iEquip_/i, lib: { name: "iEquip", needs: "SKSE, SkyUI and iEquip" } },
  { test: /^UI(Extensions|ListMenu|WheelMenu|TextEntryMenu|MenuBase|SelectionMenu)$/i, lib: { name: "UIExtensions", needs: "SKSE and UIExtensions" } },
  { test: /^PO3_/i, lib: { name: "Papyrus Extender", needs: "SKSE and Papyrus Extender (powerofthree)" } },
  { test: /^J(Value|Map|Array|FormMap|IntMap|String|DB|Containers|Lua|Atomic)/, lib: { name: "JContainers", needs: "SKSE and JContainers" } },
  { test: /^(PapyrusUtil|StorageUtil|JsonUtil|MiscUtil|StringUtil|ActorUtil|ObjectUtil|PluginUtil)$/i, lib: { name: "PapyrusUtil", needs: "SKSE and PapyrusUtil" } },
  { test: /^ConsoleUtil$/i, lib: { name: "ConsoleUtil", needs: "SKSE and ConsoleUtil" } },
  { test: /^(RaceMenu|NiOverride|NiOverride_.*)$/i, lib: { name: "RaceMenu / NiOverride", needs: "SKSE and RaceMenu" } },
  { test: /^FNIS/i, lib: { name: "FNIS", needs: "SKSE and FNIS" } },
  { test: /^(SKSE|ModEvent)/i, lib: { name: "SKSE", needs: "SKSE" } },
];

export function libraryOf(scriptName: string): Library | null {
  for (const l of LIBRARIES) if (l.test.test(scriptName)) return l.lib;
  return null;
}

// ---------- scan ----------

export interface RecordScripts {
  record: EspRecord;
  info: VmadInfo;
}

export interface ScriptSummary {
  name: string;
  kind: ScriptRef["kind"];
  /** Records that use it (a quest with the script on three aliases counts once). */
  recordCount: number;
  /** Some of those records, to look at. */
  examples: EspRecord[];
  /** Record type -> how many records of that type. */
  types: Record<string, number>;
  library: Library | null;
  /** Times it is attached with the "removed" status. */
  removed: number;
}

export type PropertyIssueKind = "undeclared-master" | "missing-record";

export interface PropertyIssue {
  kind: PropertyIssueKind;
  record: EspRecord;
  script: string;
  property: string;
  target: number;
  message: string;
}

export interface UnreadableScripts {
  record: EspRecord;
  message: string;
}

export interface ScriptReport {
  /** Records that have a VMAD subrecord. */
  records: RecordScripts[];
  scripts: ScriptSummary[];
  issues: PropertyIssue[];
  /** Records whose script data could not be read completely. */
  unreadable: UnreadableScripts[];
  scanned: number;
  /** Libraries the scripts come from, and the scripts that matched. */
  libraries: { library: Library; scripts: string[] }[];
}

const SLICE = 1500;
const MAX_EXAMPLES = 6;
const MAX_ISSUES = 500;
const ENGINE_RESERVED = 0x800;
const LIGHT_PLUGIN_INDEX = 0xfe;
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Reads the VMAD of one record, or null if it has none. */
export function recordScripts(r: EspRecord): VmadInfo | null {
  const vmad = peekSubrecord(r, "VMAD");
  return vmad ? readVmad(vmad, r.type) : null;
}

/**
 * Scans every record for scripts. Works in short slices so the screen stays usable; returns null if cancelled.
 */
export async function scanScripts(file: EspFile, cancelled: () => boolean = () => false): Promise<ScriptReport | null> {
  const { masters } = fileInfo(file);
  const own = new Set<number>();
  for (const r of walkRecords(file.nodes)) if (r.type !== "TES4") own.add(r.formId >>> 0);

  const report: ScriptReport = { records: [], scripts: [], issues: [], unreadable: [], scanned: 0, libraries: [] };
  const byKey = new Map<string, ScriptSummary>();
  let n = 0;
  for (const r of walkRecords(file.nodes)) {
    if (r.type === "TES4") continue;
    if (++n % SLICE === 0) {
      await yieldToUi();
      if (cancelled()) return null;
    }
    report.scanned++;
    let info: VmadInfo | null;
    try {
      info = recordScripts(r);
    } catch (e) {
      report.unreadable.push({ record: r, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!info) continue;
    report.records.push({ record: r, info });
    if (!info.complete && info.note) report.unreadable.push({ record: r, message: info.note });

    const seenHere = new Set<string>();
    for (const s of info.scripts) {
      const key = `${s.kind}:${s.name.toLowerCase()}`;
      let sum = byKey.get(key);
      if (!sum) {
        sum = { name: s.name, kind: s.kind, recordCount: 0, examples: [], types: {}, library: libraryOf(s.name), removed: 0 };
        byKey.set(key, sum);
      }
      if (!seenHere.has(key)) {
        seenHere.add(key);
        sum.recordCount++;
        sum.types[r.type] = (sum.types[r.type] ?? 0) + 1;
        if (sum.examples.length < MAX_EXAMPLES) sum.examples.push(r);
      }
      if (s.status === 3) sum.removed++;
      if (s.status === 3) continue; // a removed script's properties are not used
      for (const p of s.properties) {
        if (p.formId === undefined || p.formId === 0 || p.status === 3) continue;
        const issue = checkTarget(p.formId, masters.length, own);
        if (issue && report.issues.length < MAX_ISSUES) {
          report.issues.push({ kind: issue.kind, record: r, script: s.name, property: p.name, target: p.formId, message: issue.message });
        }
      }
    }
  }
  report.scripts = [...byKey.values()].sort((a, b) => Number(!!b.library) - Number(!!a.library) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const libs = new Map<string, { library: Library; scripts: string[] }>();
  for (const s of report.scripts) {
    if (!s.library) continue;
    const entry = libs.get(s.library.name) ?? { library: s.library, scripts: [] };
    entry.scripts.push(s.name);
    libs.set(s.library.name, entry);
  }
  report.libraries = [...libs.values()];
  return report;
}

function checkTarget(id: number, masterCount: number, own: Set<number>): { kind: PropertyIssueKind; message: string } | null {
  const hi = id >>> 24;
  const low = id & 0xffffff;
  if (hi === LIGHT_PLUGIN_INDEX || low < ENGINE_RESERVED) return null;
  if (hi > masterCount) {
    return { kind: "undeclared-master", message: `${hex8(id)} points at master slot ${hi}, but the plugin lists only ${masterCount} master${masterCount === 1 ? "" : "s"}.` };
  }
  if (hi === masterCount && !own.has(id >>> 0)) {
    return { kind: "missing-record", message: `${hex8(id)} should be a record in this plugin, but there is none.` };
  }
  return null;
}

/** Plain text for copying: one script name per line, as the .pex file names to look for. */
export function scriptFileList(report: ScriptReport): string {
  return report.scripts.map((s) => `${s.name}.pex`).join("\n");
}
