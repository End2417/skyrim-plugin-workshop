// Finds the FormIDs a record points at, using the typed field layouts in defs.ts.
// Only fields the editor knows as FormIDs are seen: raw or hex-typed data (script properties,
// condition parameters) is not inspected, so results are a lower bound, never a guarantee.
import { visitFormIds, resolveSubDef } from "./decode";
import { getOriginalSubrecords, zstringValue, type EspRecord, type Subrecord } from "./format";

export interface FormIdRef {
  /** The raw FormID as stored (top byte = master index in this plugin's master list). */
  id: number;
  /** Subrecord signature the reference was found in, e.g. "KWDA". */
  sub: string;
  /** Field name from the layout, e.g. "Keyword". */
  field: string;
}

/** Subrecords without keeping a parsed copy on the record (whole-plugin scans would otherwise hold every record in memory). */
function subrecordsOf(r: EspRecord): Subrecord[] {
  return r.subrecords ?? getOriginalSubrecords(r);
}

/** Calls `cb` for each non-null FormID reference in the record's known fields. */
export function forEachFormIdRef(record: EspRecord, localized: boolean, cb: (ref: FormIdRef) => void): void {
  let subs: Subrecord[];
  try {
    subs = subrecordsOf(record);
  } catch {
    return; // unreadable record: nothing to report here
  }
  const edidSub = subs.find((s) => s.type === "EDID");
  const edid = edidSub ? zstringValue(edidSub.data) : "";
  for (const sub of subs) {
    const def = resolveSubDef(record.type, sub, edid);
    if (!def) continue;
    visitFormIds(def, sub.data, 0, localized, (id, field) => {
      if (id !== 0) cb({ id: id >>> 0, sub: sub.type, field });
    });
  }
}

export function collectFormIdRefs(record: EspRecord, localized: boolean): FormIdRef[] {
  const out: FormIdRef[] = [];
  forEachFormIdRef(record, localized, (r) => out.push(r));
  return out;
}
