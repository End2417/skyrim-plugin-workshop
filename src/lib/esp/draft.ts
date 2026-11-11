// Autosaved drafts: Android may close the app in the background, which would lose unsaved edits.
// A draft stores only what changed, keyed by the file it came from, and is applied on reopening it.
import { deleteRecord, getSubrecords, markDirty, recordKey, walkRecords, type EspFile, type EspRecord, type Subrecord } from "./format";

export interface DraftRecord {
  key: string;
  header: { flags: number; formId: number; stamp: number; version: number; unknown: number };
  subs: { type: string; data: string }[];
}

export interface Draft {
  v: 1;
  sig: string;
  name: string;
  savedAt: number;
  records: DraftRecord[];
  deleted: string[];
}

const PREFIX = "esp-editor-draft:";
const INDEX_KEY = "esp-editor-draft-index";
const KEEP = 5;

/** Identifies the file a draft belongs to. */
export const fileSignature = (name: string, byteLength: number) => `${name}|${byteLength}`;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Everything edited so far, or null when there are no edits. */
export function makeDraft(file: EspFile, sig: string): Draft | null {
  const records: DraftRecord[] = [];
  for (const r of walkRecords(file.nodes)) {
    if (!r.dirty) continue;
    records.push({
      key: recordKey(r),
      header: { flags: r.flags, formId: r.formId, stamp: r.stamp, version: r.version, unknown: r.unknown },
      subs: getSubrecords(r).map((s) => ({ type: s.type, data: toBase64(s.data) })),
    });
  }
  const deleted = file.deleted ?? [];
  if (records.length === 0 && deleted.length === 0) return null;
  return { v: 1, sig, name: file.name, savedAt: Date.now(), records, deleted: [...deleted] };
}

/** Repeats the draft's deletions and edits on a freshly opened copy of the same file. */
export function applyDraft(file: EspFile, draft: Draft): { applied: number; missing: number } {
  const byKey = new Map<string, EspRecord>();
  for (const r of walkRecords(file.nodes)) byKey.set(recordKey(r), r);
  let applied = 0;
  let missing = 0;

  for (const key of draft.deleted) {
    const r = byKey.get(key);
    if (r) {
      deleteRecord(file, r);
      applied++;
    } else missing++;
  }
  for (const d of draft.records) {
    const r = byKey.get(d.key);
    if (!r) {
      missing++;
      continue;
    }
    markDirty(r);
    r.flags = d.header.flags;
    r.formId = d.header.formId;
    r.stamp = d.header.stamp;
    r.version = d.header.version;
    r.unknown = d.header.unknown;
    r.subrecords = d.subs.map((s): Subrecord => ({ type: s.type, data: fromBase64(s.data) }));
    applied++;
  }
  return { applied, missing };
}

// ---------- storage ----------
function readIndex(): string[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/** Returns false when the draft could not be stored (storage full or unavailable). */
export function saveDraft(draft: Draft): boolean {
  try {
    localStorage.setItem(PREFIX + draft.sig, JSON.stringify(draft));
    const index = [draft.sig, ...readIndex().filter((s) => s !== draft.sig)];
    for (const old of index.slice(KEEP)) localStorage.removeItem(PREFIX + old);
    localStorage.setItem(INDEX_KEY, JSON.stringify(index.slice(0, KEEP)));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(sig: string): Draft | null {
  try {
    const raw = localStorage.getItem(PREFIX + sig);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return d.v === 1 && d.sig === sig ? d : null;
  } catch {
    return null;
  }
}

export function clearDraft(sig: string) {
  try {
    localStorage.removeItem(PREFIX + sig);
    localStorage.setItem(INDEX_KEY, JSON.stringify(readIndex().filter((s) => s !== sig)));
  } catch {
    /* nothing to clear */
  }
}
