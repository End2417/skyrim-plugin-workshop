// Remembers master files (Skyrim.esm and friends) between sessions, so Check plugin does not need them added every time.
// Only the set of FormIDs each file defines is kept (a few MB for Skyrim.esm), not the file itself.
import { STORE_MASTERS, withStore } from "./db";

export interface RememberedMaster {
  name: string;
  /** Records the file defines. */
  count: number;
  savedAt: number;
}

const META = "meta:";
const IDS = "ids:";

/** FormIDs -> bytes, for storing. */
export function packIds(ids: Set<number>): ArrayBuffer {
  const out = new Uint32Array(ids.size);
  let i = 0;
  for (const id of ids) out[i++] = id >>> 0;
  return out.buffer;
}

export function unpackIds(buffer: ArrayBuffer): Set<number> {
  return new Set(new Uint32Array(buffer));
}

const key = (prefix: string, name: string) => prefix + name.toLowerCase();

/** Keeps a master's IDs on this device. Never throws; false means storage refused (private mode, no space). */
export async function rememberMaster(name: string, ids: Set<number>): Promise<boolean> {
  try {
    await withStore(STORE_MASTERS, "readwrite", (s) => s.put(packIds(ids), key(IDS, name)));
    const meta: RememberedMaster = { name, count: ids.size, savedAt: Date.now() };
    await withStore(STORE_MASTERS, "readwrite", (s) => s.put(meta, key(META, name)));
    return true;
  } catch {
    return false;
  }
}

export async function listRememberedMasters(): Promise<RememberedMaster[]> {
  try {
    const rows = await withStore<RememberedMaster[]>(STORE_MASTERS, "readonly", (s) => s.getAll(IDBKeyRange.bound(META, META + "\uffff")));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function recallMasterIds(name: string): Promise<Set<number> | null> {
  try {
    const buf = await withStore<ArrayBuffer | undefined>(STORE_MASTERS, "readonly", (s) => s.get(key(IDS, name)));
    return buf ? unpackIds(buf) : null;
  } catch {
    return null;
  }
}

export async function forgetMaster(name: string): Promise<void> {
  try {
    await withStore(STORE_MASTERS, "readwrite", (s) => s.delete(key(IDS, name)));
    await withStore(STORE_MASTERS, "readwrite", (s) => s.delete(key(META, name)));
  } catch {
    /* nothing stored */
  }
}
