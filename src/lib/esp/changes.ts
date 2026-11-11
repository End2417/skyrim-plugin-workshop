// Lists what was edited in a record: each changed field with its old and new value.
import { decodeSubrecord, flagList, type DecodeContext, type FieldNode } from "./decode";
import { getEditorId, getOriginalSubrecords, getSubrecords, hex8, RECORD_FLAG_NAMES, type EspRecord, type Subrecord } from "./format";

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

const MAX_CHANGES_PER_RECORD = 60;

/** Every value inside a decoded subrecord, keyed by its position ("Name › Sub-name"). */
function flatten(node: FieldNode, path: string, out: Map<string, string>) {
  if (node.children && node.children.length > 0) {
    const seen = new Map<string, number>();
    for (const c of node.children) {
      const n = (seen.get(c.label) ?? 0) + 1;
      seen.set(c.label, n);
      flatten(c, `${path} › ${n > 1 ? `${c.label} (${n})` : c.label}`, out);
    }
  } else {
    out.set(path, node.display || "(empty)");
  }
}

function summarize(map: Map<string, string>): string {
  const text = [...map.values()].join(", ");
  return text.length > 100 ? `${text.slice(0, 100)}…` : text || "(empty)";
}

/** Subrecords grouped as "TYPE#occurrence" so the second CNTO is compared with the second CNTO. */
function keyed(subs: Subrecord[]): Map<string, Subrecord> {
  const count = new Map<string, number>();
  const out = new Map<string, Subrecord>();
  for (const s of subs) {
    const n = (count.get(s.type) ?? 0) + 1;
    count.set(s.type, n);
    out.set(`${s.type}#${n}`, s);
  }
  return out;
}

/** Changed fields of one edited record, comparing it with the bytes it was loaded with. */
export function diffRecord(r: EspRecord, ctx: DecodeContext): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (c: FieldChange) => {
    if (changes.length < MAX_CHANGES_PER_RECORD) changes.push(c);
  };

  const o = r.original;
  if (o) {
    if (o.flags !== r.flags) {
      const f = (v: number) => flagList(v, RECORD_FLAG_NAMES).join(", ") || "(none)";
      push({ label: "Record flags", before: f(o.flags), after: f(r.flags) });
    }
    if (o.formId !== r.formId) push({ label: "FormID", before: hex8(o.formId), after: hex8(r.formId) });
    if (o.version !== r.version) push({ label: "Version", before: String(o.version), after: String(r.version) });
  }

  const edid = getEditorId(r) ?? "";
  const before = keyed(getOriginalSubrecords(r));
  const after = keyed(getSubrecords(r));
  const decode = (s: Subrecord) => {
    const map = new Map<string, string>();
    const node = decodeSubrecord(r.type, s, edid, ctx);
    flatten(node, node.label, map);
    return { node, map };
  };

  for (const [key, sub] of after) {
    const old = before.get(key);
    if (!old) {
      const d = decode(sub);
      push({ label: d.node.label, before: "(not present)", after: summarize(d.map) });
      continue;
    }
    if (old.data.length === sub.data.length && old.data.every((b, i) => b === sub.data[i])) continue;
    const a = decode(old).map;
    const b = decode(sub).map;
    let any = false;
    for (const [path, value] of b) {
      const was = a.get(path);
      if (was !== value) {
        push({ label: path, before: was ?? "(none)", after: value });
        any = true;
      }
    }
    for (const [path, value] of a) {
      if (!b.has(path)) {
        push({ label: path, before: value, after: "(removed)" });
        any = true;
      }
    }
    if (!any) push({ label: decode(sub).node.label, before: "(see raw data)", after: "(changed)" });
  }
  for (const [key, sub] of before) {
    if (!after.has(key)) {
      const d = decode(sub);
      push({ label: d.node.label, before: summarize(d.map), after: "(removed)" });
    }
  }
  return changes;
}
