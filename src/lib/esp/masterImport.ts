// Reads master files (Skyrim.esm, Update.esm...) and their strings files, and keeps on the device what the app needs from
// them: which records exist (for Check plugin), what they are called (for names and search) and the strings (so the
// master itself opens with names). Used by both Check plugin and the first-launch setup.
import { chooseLanguage, listArchiveStrings, parseBsa, pluginBase, readBsaFile, stringsFileName, type BsaArchive } from "./bsa";
import { localIds } from "./check";
import { fileInfo, parseEsp } from "./format";
import { buildMasterNames } from "./masterNames";
import { rememberMaster } from "./masterStore";
import { mergeStringTables, parseStringsFile, recallStringFiles, rememberStringFiles, type StoredStringsFile, type StringTable } from "./strings";

export const isStringsFileName = (n: string) => /\.(dl|il)?strings$/i.test(n);
export const isPluginFileName = (n: string) => /\.(esp|esm|esl)$/i.test(n);
export const isArchiveFileName = (n: string) => /\.bsa$/i.test(n);

export interface ImportedMaster {
  name: string;
  /** Local IDs of every record in the file. */
  ids: Set<number>;
  /** Records the file defines. */
  count: number;
  /** Records kept with their names for searching. */
  named: number;
  /** A localized master that was added without its strings files, so its names are missing. */
  needsStrings: boolean;
  /** False if the device refused to store it (private mode, no space). */
  remembered: boolean;
  /** Strings files used for the names. */
  stringFiles: number;
}

/** What happened to a BSA archive that was supplied so strings files could be taken out of it. */
export interface ArchiveReport {
  name: string;
  /** Strings files taken from it. */
  strings: number;
  /** Why it could not be used, if it could not. */
  problem?: string;
}

export interface ImportResult {
  masters: ImportedMaster[];
  /** Files that are neither plugins, strings files nor BSA archives. */
  ignored: string[];
  /** BSA archives that were opened, and what came out of them. */
  archives: ArchiveReport[];
  /** Strings files whose plugin was not picked with them, so there was nothing to attach them to. */
  orphanStrings: string[];
}

/** Something that can be read when needed: a picked file, or a file in a folder Android gave the app access to. */
export interface FileSource {
  name: string;
  read: () => Promise<Uint8Array>;
}

export const sourceOfFile = (f: File): FileSource => ({ name: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) });

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Takes any mix of plugin and strings files, as one pick or several. A strings file belongs to the plugin whose name it
 * starts with (Skyrim_English.STRINGS goes with Skyrim.esm).
 */
export function importMasterFiles(files: File[], onStatus: (text: string) => void = () => {}): Promise<ImportResult> {
  return importMasterSources(files.map(sourceOfFile), onStatus);
}

/**
 * Opens BSA archives on demand and takes a plugin's strings files out of them. Each archive is read once and only when a
 * localized plugin has no other strings, because the archives are big.
 */
function archiveStrings(archives: FileSource[], onStatus: (text: string) => void) {
  const opened = new Map<string, BsaArchive | string>();
  const taken = new Map<string, number>(archives.map((a) => [a.name, 0]));
  return {
    async forPlugin(pluginName: string): Promise<StoredStringsFile[]> {
      const base = pluginBase(pluginName);
      const candidates: { archive: string; language: string; make: () => StoredStringsFile }[] = [];
      for (const src of archives) {
        if (!opened.has(src.name)) {
          onStatus(`Reading ${src.name}…`);
          await tick();
          try {
            opened.set(src.name, parseBsa(await src.read()));
          } catch (e) {
            opened.set(src.name, e instanceof Error ? e.message : String(e));
          }
        }
        const a = opened.get(src.name);
        if (typeof a !== "object") continue;
        for (const s of listArchiveStrings(a)) {
          if (s.plugin === base) candidates.push({ archive: src.name, language: s.language, make: () => ({ name: stringsFileName(pluginName, s), bytes: readBsaFile(a, s.entry) }) });
        }
      }
      const language = chooseLanguage(candidates.map((c) => c.language));
      const out: StoredStringsFile[] = [];
      const seen = new Set<string>();
      for (const c of candidates) {
        if (c.language !== language) continue;
        const file = c.make();
        if (seen.has(file.name)) continue; // the first archive that has a file wins
        seen.add(file.name);
        out.push(file);
        taken.set(c.archive, (taken.get(c.archive) ?? 0) + 1);
      }
      return out;
    },
    reports(): ArchiveReport[] {
      return archives
        .filter((a) => opened.has(a.name))
        .map((a) => {
          const o = opened.get(a.name);
          return typeof o === "string" ? { name: a.name, strings: 0, problem: o } : { name: a.name, strings: taken.get(a.name) ?? 0 };
        });
    },
  };
}

/** Same as {@link importMasterFiles}, for files that are read on demand. One plugin is held in memory at a time. */
export async function importMasterSources(files: FileSource[], onStatus: (text: string) => void = () => {}): Promise<ImportResult> {
  const plugins = files.filter((f) => isPluginFileName(f.name));
  const stringFiles = files.filter((f) => isStringsFileName(f.name));
  const archiveFiles = files.filter((f) => isArchiveFileName(f.name));
  const ignored = files.filter((f) => !isPluginFileName(f.name) && !isStringsFileName(f.name) && !isArchiveFileName(f.name)).map((f) => f.name);
  const baseOf = (name: string) => name.replace(/\.[^.]+$/, "").toLowerCase();
  const used = new Set<string>();
  const masters: ImportedMaster[] = [];
  const fromArchives = archiveStrings(archiveFiles, onStatus);

  for (const f of plugins) {
    onStatus(`Reading ${f.name}…`);
    await tick(); // let the status show before the heavy part
    const parsed = parseEsp(await f.read(), f.name);
    const ids = localIds(parsed);

    // Names of a localized master live in strings files: ones picked now, else ones kept from before
    const base = baseOf(f.name);
    const picked = stringFiles.filter((s) => s.name.toLowerCase().startsWith(`${base}_`));
    let stored: StoredStringsFile[] = [];
    for (const s of picked) {
      stored.push({ name: s.name, bytes: await s.read() });
      used.add(s.name);
    }
    let fromPick = stored.length > 0;
    if (!fromPick) stored = (await recallStringFiles(f.name)) ?? [];
    // Nothing picked or remembered: a localized plugin's strings may be inside a BSA that was supplied
    if (stored.length === 0 && archiveFiles.length > 0 && fileInfo(parsed).localized) {
      stored = await fromArchives.forPlugin(f.name);
      fromPick = stored.length > 0;
    }

    let table: StringTable | null = null;
    try {
      if (stored.length > 0) table = mergeStringTables(stored.map((s) => ({ name: s.name, strings: parseStringsFile(s.name, s.bytes) })));
    } catch {
      table = null; // a damaged strings file: keep Editor IDs only
    }
    if (fromPick && table) await rememberStringFiles(f.name, stored); // so the plugin opens with its names

    onStatus(`Indexing ${f.name}…`);
    await tick();
    const names = buildMasterNames(parsed, table);
    const remembered = await rememberMaster(f.name, ids, names);
    masters.push({
      name: f.name,
      ids,
      count: ids.size,
      named: names.ids.length,
      needsStrings: fileInfo(parsed).localized && !table,
      remembered,
      stringFiles: table ? stored.length : 0,
    });
  }

  return { masters, ignored, archives: fromArchives.reports(), orphanStrings: stringFiles.filter((s) => !used.has(s.name)).map((s) => s.name) };
}
