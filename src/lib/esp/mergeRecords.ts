// Three-way merge of the contents of one record that several plugins change. UI-free so it stays testable.
//
// The question it answers: plugin A changed a record's armor and plugin B changed the same record's weapon. Which record
// should the merged plugin hold? Neither whole copy is right. Comparing each copy with the original record shows what
// each plugin changed, and the changes that do not collide can all be applied.
//
// Three levels, each comparing "what the original had" with "what each side has":
//  1. the subrecords of a record (ACBS, CNTO, KWDA...) are lined up, and each side's edits (changed, added, removed) are
//     found. Edits in different places are all kept. Two sides that add something at the same place both keep theirs.
//  2. when both sides changed the same subrecord, its fields are compared one by one (a struct with fixed fields), or its
//     entries are lined up (an array such as a keyword list), using the field layouts in defs.ts. Flag fields are
//     compared bit by bit.
//  3. only when both sides changed the very same field to different values is there a collision. One side's value is
//     used (the later plugin's unless told otherwise) and the collision is reported.
// The caller has to give every version with its FormIDs already renumbered into the same numbering.
import { fixedSize, resolveSubDef, subrecordLabel, syncCounters } from "./decode";
import type { FieldDef } from "./defs";
import type { Subrecord } from "./format";

export interface Hunk<T> {
  /** The part of the original that was replaced: items [s, e). Empty (s === e) for a pure insertion. */
  s: number;
  e: number;
  /** What it was replaced with. */
  repl: T[];
}

/** The largest comparison (original length times copy length) that is tried; larger ones are not merged. */
const COMPARE_LIMIT = 4_000_000;

const bytesEq = (a: Uint8Array, b: Uint8Array) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** How `other` differs from `base`, as the smallest list of replaced ranges. Null when the lists are too long to compare. */
export function diffHunks<T>(base: T[], other: T[], eq: (a: T, b: T) => boolean): Hunk<T>[] | null {
  const n0 = base.length;
  const m0 = other.length;
  let p = 0;
  while (p < n0 && p < m0 && eq(base[p]!, other[p]!)) p++;
  let tail = 0;
  while (tail < n0 - p && tail < m0 - p && eq(base[n0 - 1 - tail]!, other[m0 - 1 - tail]!)) tail++;
  const n = n0 - p - tail;
  const m = m0 - p - tail;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ s: p, e: p, repl: other.slice(p, p + m) }];
  if (m === 0) return [{ s: p, e: p + n, repl: [] }];
  if ((n + 1) * (m + 1) > COMPARE_LIMIT) return null;

  // dp[i][j]: length of the longest common run of base[p+i..] and other[p+j..]
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = eq(base[p + i]!, other[p + j]!) ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const hunks: Hunk<T>[] = [];
  let i = 0;
  let j = 0;
  let start = -1;
  let repl: T[] = [];
  while (i < n || j < m) {
    if (i < n && j < m && eq(base[p + i]!, other[p + j]!)) {
      if (start >= 0) {
        hunks.push({ s: start, e: p + i, repl });
        start = -1;
        repl = [];
      }
      i++;
      j++;
      continue;
    }
    if (start < 0) start = p + i;
    if (j < m && (i >= n || dp[i * w + j + 1]! >= dp[(i + 1) * w + j]!)) repl.push(other[p + j++]!);
    else i++;
  }
  if (start >= 0) hunks.push({ s: start, e: p + i, repl });
  return hunks;
}

export interface Merge3Options<T> {
  eq: (a: T, b: T) => boolean;
  /** Whose value is used where both changed the same thing differently. */
  prefer: "a" | "b";
  /** Both sides replaced the same single item. Combine them, or return null if they collide. */
  mergeOne?: (base: T, a: T, b: T) => { value: T; collisions: number } | null;
  /** Names an item in the list of collisions. */
  describe?: (t: T) => string;
}

export interface Merge3Result<T> {
  out: T[];
  collisions: number;
  /** What collided, for the report. */
  collided: string[];
}

type Tagged<T> = Hunk<T> & { side: "a" | "b" };

const overlap = <T>(x: Hunk<T>, y: Hunk<T>) => {
  if (x.s === x.e && y.s === y.e) return x.s === y.s;
  if (x.s === x.e) return y.s < x.s && x.s < y.e;
  if (y.s === y.e) return x.s < y.s && y.s < x.e;
  return x.s < y.e && y.s < x.e;
};

/** Applies the changes `a` and `b` made to `base`. Null when the lists are too long to compare. */
export function merge3<T>(base: T[], a: T[], b: T[], o: Merge3Options<T>): Merge3Result<T> | null {
  const ha = diffHunks(base, a, o.eq);
  const hb = diffHunks(base, b, o.eq);
  if (!ha || !hb) return null;
  const all: Tagged<T>[] = [...ha.map((h): Tagged<T> => ({ ...h, side: "a" })), ...hb.map((h): Tagged<T> => ({ ...h, side: "b" }))].sort(
    (x, y) => x.s - y.s || x.e - y.e || (x.side === y.side ? 0 : x.side === "a" ? -1 : 1),
  );

  const out: T[] = [];
  let pos = 0;
  let collisions = 0;
  const collided: string[] = [];
  const emit = (items: Tagged<T>[]) => {
    for (const h of items) {
      if (h.s > pos) out.push(...base.slice(pos, h.s));
      out.push(...h.repl);
      pos = Math.max(pos, h.e);
    }
  };
  const sameItems = (x: Tagged<T>[], y: Tagged<T>[]) => x.length === y.length && x.every((h, i) => h.s === y[i]!.s && h.e === y[i]!.e && h.repl.length === y[i]!.repl.length && h.repl.every((t, k) => o.eq(t, y[i]!.repl[k]!)));
  const name = (cluster: Tagged<T>[]) => {
    if (!o.describe) return;
    const seen = new Set<string>();
    for (const h of cluster) for (const t of [...base.slice(h.s, h.e), ...h.repl]) seen.add(o.describe(t));
    collided.push(...seen);
  };

  const resolve = (cluster: Tagged<T>[]) => {
    const as = cluster.filter((h) => h.side === "a");
    const bs = cluster.filter((h) => h.side === "b");
    if (as.length === 0 || bs.length === 0) return emit(cluster);
    if (sameItems(as, bs)) return emit(as); // both made the same change
    const x = cluster[0]!.s;
    if (cluster.every((h) => h.s === h.e && h.s === x)) {
      // both add something at the same place: keep both (A's first). What they both added at the start or the end of
      // it (for example, changes both mods inherited from a patch the original does not have) is kept once.
      const ra = as.flatMap((h) => h.repl);
      const rb = bs.flatMap((h) => h.repl);
      let head = 0;
      while (head < ra.length && head < rb.length && o.eq(ra[head]!, rb[head]!)) head++;
      let tail = 0;
      while (tail < ra.length - head && tail < rb.length - head && o.eq(ra[ra.length - 1 - tail]!, rb[rb.length - 1 - tail]!)) tail++;
      emit([{ s: x, e: x, repl: [], side: "a" }]);
      out.push(...ra.slice(0, ra.length - tail), ...rb.slice(head, rb.length - tail), ...ra.slice(ra.length - tail));
      return;
    }
    if (o.mergeOne && as.length === 1 && bs.length === 1) {
      const ra = as[0]!;
      const rb = bs[0]!;
      if (ra.s === rb.s && ra.e === rb.e && ra.e - ra.s === 1 && ra.repl.length === 1 && rb.repl.length === 1) {
        const r = o.mergeOne(base[ra.s]!, ra.repl[0]!, rb.repl[0]!);
        if (r) {
          if (r.collisions > 0) {
            collisions += r.collisions;
            name(cluster);
          }
          return emit([{ ...ra, repl: [r.value] }]);
        }
      }
    }
    collisions++;
    name(cluster);
    emit(o.prefer === "a" ? as : bs);
  };

  let cluster: Tagged<T>[] = [];
  for (const h of all) {
    if (cluster.length > 0 && !cluster.some((c) => overlap(c, h))) {
      resolve(cluster);
      cluster = [];
    }
    cluster.push(h);
  }
  if (cluster.length > 0) resolve(cluster);
  out.push(...base.slice(pos));
  return { out, collisions, collided };
}

// ---------- inside one subrecord ----------

interface Span {
  off: number;
  size: number;
  def: FieldDef;
}

/** The fixed fields of a layout, in order. Null when the layout has a variable-size part. */
function leafSpans(def: FieldDef, base = 0, out: Span[] = []): Span[] | null {
  if (def.k === "struct") {
    let o = base;
    for (const m of def.m) {
      const size = fixedSize(m);
      if (size === null) return null;
      if (m.k === "struct") {
        if (!leafSpans(m, o, out)) return null;
      } else out.push({ off: o, size, def: m });
      o += size;
    }
    return out;
  }
  const size = fixedSize(def);
  if (size === null) return null;
  out.push({ off: base, size, def });
  return out;
}

const readUint = (d: Uint8Array, off: number, size: number) => {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + d[off + i]!;
  return v;
};

/** Changes both sides made to a set of bits are all kept; a bit they set differently takes the preferred side's value. */
export function mergeBits(base: number, a: number, b: number, prefer: "a" | "b"): number {
  const ca = (a ^ base) >>> 0;
  const cb = (b ^ base) >>> 0;
  const clash = (ca & cb & (a ^ b)) >>> 0;
  const pick = prefer === "a" ? a : b;
  return (((base & ~(ca | cb)) | (a & ca & ~clash) | (b & cb & ~clash) | (pick & clash)) >>> 0);
}

/** Combines three versions of one subrecord's bytes. */
export function mergeData(def: FieldDef | null, base: Uint8Array, a: Uint8Array, b: Uint8Array, prefer: "a" | "b"): { data: Uint8Array; collisions: number } {
  if (bytesEq(a, b)) return { data: a, collisions: 0 };
  if (bytesEq(a, base)) return { data: b, collisions: 0 };
  if (bytesEq(b, base)) return { data: a, collisions: 0 };
  const pick = prefer === "a" ? a : b;
  if (def?.k === "array") {
    const es = fixedSize(def.of);
    if (es && es > 0 && base.length % es === 0 && a.length % es === 0 && b.length % es === 0) {
      const split = (d: Uint8Array) => Array.from({ length: d.length / es }, (_, i) => d.subarray(i * es, (i + 1) * es));
      const r = merge3(split(base), split(a), split(b), {
        eq: bytesEq,
        prefer,
        mergeOne: (x, y, z) => {
          const q = mergeData(def.of, x, y, z, prefer);
          return { value: q.data, collisions: q.collisions };
        },
      });
      if (r) {
        const data = new Uint8Array(r.out.length * es);
        r.out.forEach((e, i) => data.set(e, i * es));
        return { data, collisions: r.collisions };
      }
    }
    return { data: pick, collisions: 1 };
  }
  if (def) {
    const spans = leafSpans(def);
    const size = spans ? spans.reduce((s, x) => s + x.size, 0) : -1;
    if (spans && base.length === size && a.length === size && b.length === size) {
      const out = base.slice();
      let collisions = 0;
      for (const sp of spans) {
        const x = base.subarray(sp.off, sp.off + sp.size);
        const y = a.subarray(sp.off, sp.off + sp.size);
        const z = b.subarray(sp.off, sp.off + sp.size);
        let v: Uint8Array = y;
        if (bytesEq(y, z)) v = y;
        else if (bytesEq(y, x)) v = z;
        else if (bytesEq(z, x)) v = y;
        else if ("flags" in sp.def && sp.def.flags && sp.size <= 4) {
          const merged = mergeBits(readUint(base, sp.off, sp.size), readUint(a, sp.off, sp.size), readUint(b, sp.off, sp.size), prefer);
          v = new Uint8Array(sp.size);
          for (let i = 0; i < sp.size; i++) v[i] = (merged >>> (8 * i)) & 0xff;
        } else {
          collisions++;
          v = prefer === "a" ? y : z;
        }
        out.set(v, sp.off);
      }
      return { data: out, collisions };
    }
  }
  return { data: pick, collisions: 1 };
}

// ---------- one record ----------

export interface RecordVersion {
  subs: Subrecord[];
  flags: number;
}

export interface SideVersion extends RecordVersion {
  /** Index of the plugin it comes from. */
  input: number;
}

export interface RecordMerge extends RecordVersion {
  collisions: number;
  /** Names of the fields both sides changed differently. */
  collided: string[];
  /** What each side changed from the original, in words. */
  changes: { input: number; fields: string[] }[];
}

const subEq = (x: Subrecord, y: Subrecord) => x.type === y.type && bytesEq(x.data, y.data);
export const sameSubrecords = (x: Subrecord[], y: Subrecord[]) => x.length === y.length && x.every((s, i) => subEq(s, y[i]!));

/**
 * Combines the changes `sides` (in load order) made to `base`. `prefer` says, for a collision between what has been
 * combined so far (the contributors' inputs) and the next side, whose value is used. Null when the record is too large to compare.
 */
export function mergeRecordVersions(recordType: string, edid: string, base: RecordVersion, sides: SideVersion[], prefer: (contributors: number[], next: number) => "a" | "b"): RecordMerge | null {
  let acc = base.subs;
  let flags = base.flags;
  let collisions = 0;
  const collided: string[] = [];
  const contributors: number[] = [];
  const changes: RecordMerge["changes"] = [];
  const label = (s: Subrecord) => subrecordLabel(recordType, s);

  for (const side of sides) {
    const pref = prefer(contributors, side.input);
    const r = merge3(base.subs, acc, side.subs, {
      eq: subEq,
      prefer: pref,
      describe: label,
      mergeOne: (x, y, z) => {
        if (x.type !== y.type || x.type !== z.type) return null;
        let def: FieldDef | null = null;
        try {
          def = resolveSubDef(recordType, x, edid);
        } catch {
          def = null;
        }
        const q = mergeData(def, x.data, y.data, z.data, pref);
        return { value: { type: x.type, data: q.data }, collisions: q.collisions };
      },
    });
    if (!r) return null;
    acc = r.out;
    collisions += r.collisions;
    collided.push(...r.collided);
    const before = flags;
    flags = mergeBits(base.flags, flags, side.flags, pref);
    if (flags !== before && side.flags !== base.flags) {
      const clash = ((before ^ base.flags) & (side.flags ^ base.flags) & (before ^ side.flags)) >>> 0;
      if (clash) {
        collisions++;
        collided.push("Record flags");
      }
    }

    // what this side changed, from the original
    const hunks = diffHunks(base.subs, side.subs, subEq);
    const fields = new Set<string>();
    for (const h of hunks ?? []) for (const s of [...base.subs.slice(h.s, h.e), ...h.repl]) fields.add(label(s));
    if (side.flags !== base.flags) fields.add("Record flags");
    changes.push({ input: side.input, fields: [...fields] });
    if (fields.size > 0 || !hunks) contributors.push(side.input);
  }

  // when changes from several sides ended up in one record, the counts that go with lists may no longer add up
  const combined = sides.length > 1 && sides.every((s) => !sameSubrecords(acc, s.subs)) && !sameSubrecords(acc, base.subs);
  if (combined) {
    acc = acc.map((s) => ({ type: s.type, data: s.data.slice() }));
    syncCounters(acc);
  }
  return { subs: acc, flags, collisions, collided: [...new Set(collided)], changes };
}
