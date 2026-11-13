// One IndexedDB database for everything the app keeps on the device. Each feature owns an object store;
// all stores are created here so opening the database at the newest version never drops another feature's data.
export const DB_NAME = "esp-editor";
export const STORE_STRINGS = "strings";
export const STORE_MASTERS = "masters";
const DB_VERSION = 2;

export function openEspDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of [STORE_STRINGS, STORE_MASTERS]) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openEspDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
