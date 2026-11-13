// Finds Skyrim's own plugins and strings files in a folder the person picked. UI-free: it asks a `list` function for
// folder contents, so it works the same on Android's folder listing as on a fake one in the tests.

/** The plugins that ship with Skyrim and that other plugins depend on. */
export const KNOWN_MASTERS = ["Skyrim.esm", "Update.esm", "Dawnguard.esm", "HearthFires.esm", "Dragonborn.esm"] as const;

/**
 * The Unofficial Skyrim Legendary Edition Patch, which many mods need as a master. Its current file name comes first; the
 * older name (from before the patch and its DLC patches were merged) is still named as a master by older mods.
 */
export const KNOWN_PATCHES = ["Unofficial Skyrim Legendary Edition Patch.esp", "Unofficial Skyrim Patch.esp"] as const;

/** Everything the setup looks for, in load order. */
export const KNOWN_PLUGINS = [...KNOWN_MASTERS, ...KNOWN_PATCHES] as const;

export interface FolderItem {
  name: string;
  uri: string;
  dir: boolean;
  size: number;
}
export type ListFolder = (path: string[]) => Promise<{ found: boolean; entries: FolderItem[] }>;

export interface SkyrimScan {
  /** Where the Data folder is, below the picked one: [] if it was picked directly, ["Data"] if Skyrim's folder was. */
  dataPath: string[];
  /** Everything in the Data folder, so any plugin can be looked up by name. */
  dataEntries: FolderItem[];
  /** The known plugins (Skyrim's own and the Unofficial Patch) that are there, in load order. */
  plugins: FolderItem[];
  /** Loose strings files, by language (lower case). */
  strings: Map<string, FolderItem[]>;
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STRINGS_NAME = new RegExp(`^(${KNOWN_PLUGINS.map((m) => escapeRe(m.replace(/\.es[mp]$/i, ""))).join("|")})_([a-z]+)\\.(dl|il)?strings$`, "i");
const isKnownPlugin = (name: string) => KNOWN_PLUGINS.some((m) => m.toLowerCase() === name.toLowerCase());

/** The language in a strings file name ("Skyrim_English.STRINGS" -> "english"), or null if it is not one of Skyrim's. */
export function stringsLanguage(name: string): string | null {
  const m = STRINGS_NAME.exec(name);
  return m ? m[2]!.toLowerCase() : null;
}

/**
 * Looks for Skyrim's plugins in the picked folder, or in its Data folder if Skyrim's main folder was picked. Returns null
 * if none of them are there. Skyrim keeps its strings inside Skyrim - Interface.bsa unless they have been extracted, so
 * `strings` is often empty.
 */
export async function scanSkyrimFolder(list: ListFolder): Promise<SkyrimScan | null> {
  let dataPath: string[] = [];
  let root = await list(dataPath);
  if (!root.found) return null;
  if (!root.entries.some((e) => !e.dir && isKnownPlugin(e.name))) {
    if (!root.entries.some((e) => e.dir && e.name.toLowerCase() === "data")) return null;
    dataPath = ["Data"];
    root = await list(dataPath);
    if (!root.found) return null;
  }
  const plugins = KNOWN_PLUGINS.map((m) => root.entries.find((e) => !e.dir && e.name.toLowerCase() === m.toLowerCase())).filter((e): e is FolderItem => !!e);
  if (plugins.length === 0) return null;

  const strings = new Map<string, FolderItem[]>();
  if (root.entries.some((e) => e.dir && e.name.toLowerCase() === "strings")) {
    const sub = await list([...dataPath, "Strings"]);
    for (const e of sub.entries) {
      const lang = e.dir ? null : stringsLanguage(e.name);
      if (!lang) continue;
      strings.set(lang, [...(strings.get(lang) ?? []), e]);
    }
  }
  return { dataPath, dataEntries: root.entries, plugins, strings };
}

/** The files in the Data folder with these plugin names (ignoring case), and the names that are not there. */
export function findPluginsByName(scan: SkyrimScan, names: string[]): { found: FolderItem[]; missing: string[] } {
  const found: FolderItem[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const hit = scan.dataEntries.find((e) => !e.dir && e.name.toLowerCase() === name.toLowerCase());
    if (hit) found.push(hit);
    else missing.push(name);
  }
  return { found, missing };
}

/** The language to use: English if there is any, otherwise the first one found. */
export function defaultLanguage(strings: Map<string, FolderItem[]>): string | null {
  if (strings.has("english")) return "english";
  return [...strings.keys()][0] ?? null;
}
