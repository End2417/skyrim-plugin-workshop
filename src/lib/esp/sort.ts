// Sorting for the record list: click FormID, EditorID or Name to sort, click again to reverse, once more to go back
// to the order in the file. UI-free so it stays testable.
import { getDisplayName, getEditorId, type EspNode, type EspRecord } from "./format";

export type SortColumn = "formId" | "editorId" | "name";
export interface SortState {
  column: SortColumn;
  dir: "asc" | "desc";
}

/** Click on a column header: new column starts ascending, then descending, then off. */
export function nextSort(current: SortState | null, column: SortColumn): SortState | null {
  if (!current || current.column !== column) return { column, dir: "asc" };
  return current.dir === "asc" ? { column, dir: "desc" } : null;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Records in the chosen order. Ones with nothing to sort by (no Editor ID or name) go last either way. */
export function sortRecords(records: EspRecord[], sort: SortState, localized: boolean): EspRecord[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const keyed = records.map((r, index) => ({
    r,
    index,
    key: sort.column === "formId" ? r.formId >>> 0 : ((sort.column === "editorId" ? getEditorId(r) : getDisplayName(r, localized)) ?? "").trim(),
  }));
  keyed.sort((a, b) => {
    const ae = a.key === "";
    const be = b.key === "";
    if (ae !== be) return ae ? 1 : -1;
    const c = typeof a.key === "number" && typeof b.key === "number" ? a.key - b.key : collator.compare(String(a.key), String(b.key));
    return c !== 0 ? c * sign : a.index - b.index; // ties keep file order
  });
  return keyed.map((k) => k.r);
}

/**
 * A group's children in the chosen order. Only groups made purely of records are sorted: where records are followed by
 * their own sub-groups (a cell and the things in it), reordering would separate them, so those keep the file order.
 */
export function sortChildren(nodes: EspNode[], sort: SortState, localized: boolean): EspNode[] {
  if (nodes.length < 2 || !nodes.every((n): n is EspRecord => n.kind !== "group")) return nodes;
  return sortRecords(nodes as EspRecord[], sort, localized);
}
