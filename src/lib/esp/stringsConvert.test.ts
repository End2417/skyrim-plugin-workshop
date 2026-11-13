import { describe, expect, it } from "vitest";
import { convertStringsToLe, encodeCp1252 } from "./stringsConvert";
import { parseStringsFile } from "./strings";

const enc = new TextEncoder();

/** Builds a strings file; `prefixed` for .DLSTRINGS/.ILSTRINGS. */
function build(items: [number, Uint8Array][], prefixed: boolean, shareLast = false): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let used = 0;
  for (const [, body] of items) {
    const payload = new Uint8Array(body.length + 1);
    payload.set(body);
    const part = prefixed ? new Uint8Array(4 + payload.length) : payload;
    if (prefixed) {
      new DataView(part.buffer).setUint32(0, payload.length, true);
      part.set(payload, 4);
    }
    offsets.push(used);
    parts.push(part);
    used += part.length;
  }
  const ids = items.map(([id]) => id);
  const entries = ids.map((id, i) => [id, offsets[i]!] as const);
  if (shareLast) entries.push([999, offsets[0]!]); // a second ID pointing at the first string
  const out = new Uint8Array(8 + entries.length * 8 + used);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, entries.length, true);
  dv.setUint32(4, used, true);
  entries.forEach(([id, off], i) => {
    dv.setUint32(8 + i * 8, id, true);
    dv.setUint32(12 + i * 8, off, true);
  });
  let w = 8 + entries.length * 8;
  for (const p of parts) {
    out.set(p, w);
    w += p.length;
  }
  return out;
}

describe("encodeCp1252", () => {
  it("encodes accents and punctuation, and flags what cannot be encoded", () => {
    expect(Array.from(encodeCp1252("é€").bytes)).toEqual([0xe9, 0x80]);
    const r = encodeCp1252("a日b");
    expect(Array.from(r.bytes)).toEqual([0x61, 0x3f, 0x62]);
    expect(r.unmappable).toBe(1);
  });
});

describe("convertStringsToLe", () => {
  it("re-encodes UTF-8 text as Windows-1252 and keeps the IDs", () => {
    const src = build([[1, enc.encode("Sword")], [2, enc.encode("Épée de fer")], [3, enc.encode("Ünïcode")]], false);
    const r = convertStringsToLe("Skyrim_french.STRINGS", src);
    expect(r.changed).toBe(2);
    expect(r.total).toBe(3);
    const raw = r.bytes;
    // The bytes are now Windows-1252, so the UTF-8 sniffing reader falls back to it and the text still reads the same.
    const back = parseStringsFile("Skyrim_french.STRINGS", raw);
    expect(back.get(1)).toBe("Sword");
    expect(back.get(2)).toBe("Épée de fer");
    expect(back.get(3)).toBe("Ünïcode");
    expect(raw.includes(0xc3)).toBe(false); // no UTF-8 lead bytes left
  });

  it("works on length-prefixed files", () => {
    const src = build([[10, enc.encode("Café au lait, with a long description")]], true);
    const r = convertStringsToLe("Skyrim_french.DLSTRINGS", src);
    expect(r.changed).toBe(1);
    expect(parseStringsFile("Skyrim_french.DLSTRINGS", r.bytes).get(10)).toBe("Café au lait, with a long description");
  });

  it("leaves ASCII and text that is already Windows-1252 alone", () => {
    const latin1 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in Windows-1252: not valid UTF-8
    const src = build([[1, enc.encode("Plain")], [2, latin1]], false);
    const r = convertStringsToLe("A.STRINGS", src);
    expect(r.changed).toBe(0);
    expect(Array.from(r.bytes)).toEqual(Array.from(src));
  });

  it("converts text shared by two IDs once and keeps both pointing at it", () => {
    const src = build([[1, enc.encode("Épée")]], false, true);
    const r = convertStringsToLe("A.STRINGS", src);
    const back = parseStringsFile("A.STRINGS", r.bytes);
    expect(back.get(1)).toBe("Épée");
    expect(back.get(999)).toBe("Épée");
    expect(r.changed).toBe(1);
  });

  it("counts characters Windows-1252 cannot hold", () => {
    const r = convertStringsToLe("A.STRINGS", build([[1, enc.encode("日本")]], false));
    expect(r.unmappable).toBe(2);
  });

  it("rejects other files and damaged ones", () => {
    expect(() => convertStringsToLe("A.esp", new Uint8Array(16))).toThrow(/not a strings file/);
    expect(() => convertStringsToLe("A.STRINGS", new Uint8Array(4))).toThrow(/too short/);
  });
});
