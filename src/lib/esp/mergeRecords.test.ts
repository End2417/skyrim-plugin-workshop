import { describe, expect, it } from "vitest";
import { diffHunks, merge3, mergeBits, mergeData, mergeRecordVersions, sameSubrecords } from "./mergeRecords";
import { encodeZString, type Subrecord } from "./format";
import type { FieldDef } from "./defs";

const eq = (a: string, b: string) => a === b;
const m3 = (base: string, a: string, b: string, prefer: "a" | "b" = "b") => {
  const r = merge3([...base], [...a], [...b], { eq, prefer });
  return r && { out: r.out.join(""), collisions: r.collisions };
};

describe("diffHunks", () => {
  it("finds the replaced ranges", () => {
    expect(diffHunks([..."abc"], [..."abc"], eq)).toEqual([]);
    expect(diffHunks([..."abc"], [..."abxc"], eq)).toEqual([{ s: 2, e: 2, repl: ["x"] }]);
    expect(diffHunks([..."abc"], [..."ac"], eq)).toEqual([{ s: 1, e: 2, repl: [] }]);
    expect(diffHunks([..."abc"], [..."aXc"], eq)).toEqual([{ s: 1, e: 2, repl: ["X"] }]);
    expect(diffHunks([], [..."ab"], eq)).toEqual([{ s: 0, e: 0, repl: ["a", "b"] }]);
    expect(diffHunks([..."ab"], [], eq)).toEqual([{ s: 0, e: 2, repl: [] }]);
  });

  it("gives up on lists that are too long to compare", () => {
    const big = Array.from({ length: 3000 }, (_, i) => String(i));
    const other = Array.from({ length: 3000 }, (_, i) => (i % 2 ? String(i) : `x${i}`));
    expect(diffHunks(big, other, eq)).toBeNull();
  });
});

describe("merge3", () => {
  it("keeps changes in different places from both sides", () => {
    expect(m3("abcdef", "aXcdef", "abcdeY")).toEqual({ out: "aXcdeY", collisions: 0 });
    expect(m3("abcdef", "abdef", "abcdeY")).toEqual({ out: "abdeY", collisions: 0 }); // one removes, one changes
  });

  it("keeps changes in neighbouring items from both sides", () => {
    expect(m3("abcd", "aXcd", "abYd")).toEqual({ out: "aXYd", collisions: 0 });
  });

  it("keeps what both sides add at the same place, once if it is the same", () => {
    expect(m3("ab", "abX", "abY")).toEqual({ out: "abXY", collisions: 0 });
    expect(m3("ab", "abX", "abX")).toEqual({ out: "abX", collisions: 0 });
    expect(m3("ab", "aXb", "aYb")).toEqual({ out: "aXYb", collisions: 0 });
  });

  it("keeps what both added at the start or the end of their additions once", () => {
    // both inherited P and Q from a patch the original does not have, then each added one thing
    expect(m3("ab", "abPXQ", "abPYQ")).toEqual({ out: "abPXYQ", collisions: 0 });
    expect(m3("ab", "abPX", "abPY")).toEqual({ out: "abPXY", collisions: 0 });
    expect(m3("ab", "abXQ", "abYQ")).toEqual({ out: "abXYQ", collisions: 0 });
  });

  it("takes a change one side made to something the other added next to", () => {
    expect(m3("abc", "aXbc", "abZc")).toEqual({ out: "aXbZc", collisions: 0 });
  });

  it("takes a change both sides made once", () => {
    expect(m3("abc", "aXc", "aXc")).toEqual({ out: "aXc", collisions: 0 });
  });

  it("reports a collision and uses the preferred side", () => {
    expect(m3("abc", "aXc", "aYc", "b")).toEqual({ out: "aYc", collisions: 1 });
    expect(m3("abc", "aXc", "aYc", "a")).toEqual({ out: "aXc", collisions: 1 });
    // a change inside something the other side removed
    expect(m3("abcd", "ad", "abXd", "b")).toEqual({ out: "abXd", collisions: 1 });
    expect(m3("abcd", "ad", "abXd", "a")).toEqual({ out: "ad", collisions: 1 });
  });

  it("returns the other side when one side changed nothing", () => {
    expect(m3("abc", "abc", "aXc")).toEqual({ out: "aXc", collisions: 0 });
    expect(m3("abc", "aXc", "abc")).toEqual({ out: "aXc", collisions: 0 });
  });

  it("matches a simple reference on random edits that do not touch", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let round = 0; round < 300; round++) {
      // regions of the original: even ones are A's to edit, odd ones B's, and a fixed separator sits between them
      const regions = Array.from({ length: 6 }, (_, r) => Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => `r${r}_${i}`));
      const sep = (i: number) => `|${i}`;
      const original: string[] = [];
      regions.forEach((reg, i) => original.push(...reg, sep(i)));
      const edit = (reg: string[], tag: string) => {
        const k = Math.floor(rand() * 4);
        if (k === 0) return reg;
        if (k === 1) return [...reg, `${tag}+`]; // add at the end (right before a separator)
        if (k === 2) return reg.length > 1 ? reg.slice(1) : reg; // remove the first
        return [`${tag}!`, ...reg.slice(1)]; // change the first
      };
      const aRegs = regions.map((reg, i) => (i % 2 === 0 ? edit(reg, "A") : reg));
      const bRegs = regions.map((reg, i) => (i % 2 === 1 ? edit(reg, "B") : reg));
      const build = (rs: string[][]) => rs.flatMap((reg, i) => [...reg, sep(i)]);
      const expected = regions.flatMap((_, i) => [...(i % 2 === 0 ? aRegs[i]! : bRegs[i]!), sep(i)]);
      const r = merge3(original, build(aRegs), build(bRegs), { eq, prefer: "b" });
      expect(r!.collisions).toBe(0);
      expect(r!.out).toEqual(expected);
      // and the order of the two sides does not matter when nothing collides
      expect(merge3(original, build(bRegs), build(aRegs), { eq, prefer: "b" })!.out).toEqual(expected);
    }
  });
});

describe("mergeBits", () => {
  it("keeps bits either side changed and lets the preferred side decide a clash", () => {
    expect(mergeBits(0b0000, 0b0001, 0b0100, "b")).toBe(0b0101);
    expect(mergeBits(0b0110, 0b0100, 0b0010, "b")).toBe(0b0000); // each cleared a different bit
    expect(mergeBits(0b0000, 0b0001, 0b0001, "b")).toBe(0b0001);
    expect(mergeBits(0b0001, 0b0000, 0b0001, "a")).toBe(0b0000);
    expect(mergeBits(0, 0x80000000, 0x00000001, "b")).toBe(0x80000001);
  });
});

describe("mergeData", () => {
  const u32 = (...n: number[]) => {
    const d = new Uint8Array(n.length * 4);
    n.forEach((v, i) => new DataView(d.buffer).setUint32(i * 4, v >>> 0, true));
    return d;
  };
  const struct: FieldDef = {
    k: "struct",
    n: "S",
    m: [
      { k: "u32", n: "Flags", flags: { 1: "A", 2: "B", 4: "C" } },
      { k: "u32", n: "Value" },
      { k: "f32", n: "Weight" },
    ],
  };
  const words = (d: Uint8Array) => Array.from({ length: d.length / 4 }, (_, i) => new DataView(d.buffer, d.byteOffset).getUint32(i * 4, true));

  it("combines different fields of a struct and the bits of a flags field", () => {
    const base = u32(0, 10, 0);
    const a = u32(1, 10, 0); // sets a flag
    const b = u32(2, 99, 0); // sets another flag, changes the value
    const r = mergeData(struct, base, a, b, "b");
    expect(words(r.data)).toEqual([3, 99, 0]);
    expect(r.collisions).toBe(0);
  });

  it("reports a field both sides changed differently", () => {
    const r = mergeData(struct, u32(0, 10, 0), u32(0, 20, 0), u32(0, 30, 0), "b");
    expect(words(r.data)).toEqual([0, 30, 0]);
    expect(r.collisions).toBe(1);
    expect(words(mergeData(struct, u32(0, 10, 0), u32(0, 20, 0), u32(0, 30, 0), "a").data)).toEqual([0, 20, 0]);
  });

  it("merges lists of fixed-size entries", () => {
    const list: FieldDef = { k: "array", n: "Keywords", of: { k: "fid", n: "Keyword" } };
    const r = mergeData(list, u32(1, 2), u32(1, 2, 3), u32(1, 2, 4), "b");
    expect(words(r.data)).toEqual([1, 2, 3, 4]);
    expect(r.collisions).toBe(0);
    expect(words(mergeData(list, u32(1, 2), u32(1), u32(1, 2, 4), "b").data)).toEqual([1, 4]);
  });

  it("falls back to one side when it cannot see inside", () => {
    const r = mergeData(null, u32(1), u32(2), u32(3), "b");
    expect(words(r.data)).toEqual([3]);
    expect(r.collisions).toBe(1);
  });
});

// ---------- whole records, with real layouts ----------

const sub = (type: string, data: Uint8Array): Subrecord => ({ type, data });
const w = (...n: number[]) => {
  const d = new Uint8Array(n.length * 4);
  n.forEach((v, i) => new DataView(d.buffer).setUint32(i * 4, v >>> 0, true));
  return d;
};
/** NPC_ configuration: flags, then 20 bytes of other fields, of which level is at 10. */
const acbs = (flags: number, level: number) => {
  const d = new Uint8Array(24);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, flags, true);
  dv.setUint16(8, level, true); // after flags (4) + magicka (2) + stamina (2)
  return sub("ACBS", d);
};
const cnto = (item: number, count = 1) => sub("CNTO", w(item, count));
const coct = (n: number) => sub("COCT", w(n));
const counts = (subs: Subrecord[]) => new DataView(subs.find((s) => s.type === "COCT")!.data.buffer).getUint32(0, true);
const items = (subs: Subrecord[]) => subs.filter((s) => s.type === "CNTO").map((s) => new DataView(s.data.buffer, s.data.byteOffset).getUint32(0, true));
const later = () => "b" as const;

describe("mergeRecordVersions", () => {
  const edid = sub("EDID", encodeZString("Guard"));
  const base = { subs: [edid, acbs(0, 5), coct(1), cnto(0x100)], flags: 0 };

  it("gives an NPC the sword one plugin added and the armor the other added, with the right item count", () => {
    const sword = { input: 0, flags: 0, subs: [edid, acbs(0, 5), coct(2), cnto(0x100), cnto(0x200)] };
    const armor = { input: 1, flags: 0, subs: [edid, acbs(0, 5), coct(2), cnto(0x100), cnto(0x300)] };
    const r = mergeRecordVersions("NPC_", "Guard", base, [sword, armor], later)!;
    expect(items(r.subs)).toEqual([0x100, 0x200, 0x300]);
    expect(counts(r.subs)).toBe(3); // both plugins wrote 2; the merged record has 3
    expect(r.collisions).toBe(0);
    expect(r.changes.map((c) => c.fields.length > 0)).toEqual([true, true]);
    // nothing shared with the plugins it came from was changed
    expect(counts(sword.subs)).toBe(2);
  });

  it("combines different fields of the same subrecord and the record flags", () => {
    const a = { input: 0, flags: 0x1, subs: [edid, acbs(0x2, 5), coct(1), cnto(0x100)] }; // Essential flag
    const b = { input: 1, flags: 0x4, subs: [edid, acbs(0x0, 40), coct(1), cnto(0x100)] }; // level
    const r = mergeRecordVersions("NPC_", "Guard", base, [a, b], later)!;
    const d = r.subs.find((s) => s.type === "ACBS")!.data;
    const dv = new DataView(d.buffer, d.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x2);
    expect(dv.getUint16(8, true)).toBe(40);
    expect(r.flags).toBe(0x5);
    expect(r.collisions).toBe(0);
  });

  it("uses the preferred plugin where both change the same field, and says what collided", () => {
    const a = { input: 0, flags: 0, subs: [edid, acbs(0, 10), coct(1), cnto(0x100)] };
    const b = { input: 1, flags: 0, subs: [edid, acbs(0, 20), coct(1), cnto(0x100)] };
    const last = mergeRecordVersions("NPC_", "Guard", base, [a, b], later)!;
    expect(new DataView(last.subs.find((s) => s.type === "ACBS")!.data.buffer).getUint16(8, true)).toBe(20);
    expect(last.collisions).toBe(1);
    expect(last.collided.some((c) => /ACBS/.test(c))).toBe(true);
    const first = mergeRecordVersions("NPC_", "Guard", base, [a, b], (contributors) => (contributors.includes(0) ? "a" : "b"))!;
    expect(new DataView(first.subs.find((s) => s.type === "ACBS")!.data.buffer).getUint16(8, true)).toBe(10);
  });

  it("is the same record when nobody changed anything, and the one that changed when only one did", () => {
    const same = { input: 0, flags: 0, subs: base.subs };
    expect(sameSubrecords(mergeRecordVersions("NPC_", "Guard", base, [same, { ...same, input: 1 }], later)!.subs, base.subs)).toBe(true);
    const changed = { input: 1, flags: 0, subs: [edid, acbs(0, 9), coct(1), cnto(0x100)] };
    const r = mergeRecordVersions("NPC_", "Guard", base, [same, changed], later)!;
    expect(sameSubrecords(r.subs, changed.subs)).toBe(true);
    expect(r.changes[0]!.fields).toEqual([]);
  });

  it("merges three plugins one after the other", () => {
    const mk = (input: number, ...extra: Subrecord[]) => ({ input, flags: 0, subs: [edid, acbs(0, 5), coct(1 + extra.length), cnto(0x100), ...extra] });
    const r = mergeRecordVersions("NPC_", "Guard", base, [mk(0, cnto(0x200)), mk(1, cnto(0x300)), mk(2, cnto(0x400))], later)!;
    expect(items(r.subs)).toEqual([0x100, 0x200, 0x300, 0x400]);
    expect(counts(r.subs)).toBe(4);
  });

  it("does not touch the versions it was given", () => {
    const a = { input: 0, flags: 0, subs: [edid, acbs(0, 5), coct(2), cnto(0x100), cnto(0x200)] };
    const b = { input: 1, flags: 0, subs: [edid, acbs(0, 5), coct(2), cnto(0x100), cnto(0x300)] };
    const before = JSON.stringify([a, b, base].map((v) => v.subs.map((s) => [s.type, Array.from(s.data)])));
    mergeRecordVersions("NPC_", "Guard", base, [a, b], later);
    expect(JSON.stringify([a, b, base].map((v) => v.subs.map((s) => [s.type, Array.from(s.data)])))).toBe(before);
  });
});
