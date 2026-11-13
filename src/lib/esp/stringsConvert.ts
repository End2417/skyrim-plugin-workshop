// Re-encodes a Special Edition strings file for Legendary Edition. SE can write its text as UTF-8; LE reads
// Windows-1252. Plain English text is the same in both, so only strings with other characters change.
// UI-free so it stays testable.

export interface StringsConversion {
  bytes: Uint8Array;
  /** Strings whose text was re-encoded. */
  changed: number;
  /** Characters Windows-1252 has no code for; each became "?". */
  unmappable: number;
  /** Strings in the file. */
  total: number;
}

let encodeMap: Map<number, number> | null = null;

/** Unicode code point -> Windows-1252 byte, built from the browser's own decoder so there is no table to get wrong. */
function cp1252Map(): Map<number, number> {
  if (encodeMap) return encodeMap;
  const dec = new TextDecoder("windows-1252");
  const m = new Map<number, number>();
  for (let b = 0; b < 256; b++) m.set(dec.decode(new Uint8Array([b])).codePointAt(0)!, b);
  return (encodeMap = m);
}

const QUESTION_MARK = 0x3f;

/** Text -> Windows-1252 bytes, with the number of characters that could not be represented. */
export function encodeCp1252(text: string): { bytes: Uint8Array; unmappable: number } {
  const map = cp1252Map();
  const out: number[] = [];
  let unmappable = 0;
  for (const ch of text) {
    const b = map.get(ch.codePointAt(0)!);
    if (b === undefined) {
      out.push(QUESTION_MARK);
      unmappable++;
    } else out.push(b);
  }
  return { bytes: Uint8Array.from(out), unmappable };
}

const isAscii = (b: Uint8Array) => b.every((x) => x < 0x80);

/**
 * Converts one .STRINGS, .DLSTRINGS or .ILSTRINGS file. A string that is valid UTF-8 with non-ASCII characters is
 * re-encoded; anything else (plain ASCII, or text already in Windows-1252) is copied untouched. The string IDs and
 * their order stay the same.
 */
export function convertStringsToLe(name: string, bytes: Uint8Array): StringsConversion {
  if (!/\.(dl|il)?strings$/i.test(name)) throw new Error(`${name} is not a strings file (.STRINGS, .DLSTRINGS or .ILSTRINGS).`);
  const lengthPrefixed = /\.(dl|il)strings$/i.test(name);
  if (bytes.length < 8) throw new Error(`${name} is too short to be a strings file.`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);
  const dataSize = dv.getUint32(4, true);
  const dataStart = 8 + count * 8;
  if (dataStart > bytes.length || dataStart + dataSize > bytes.length) throw new Error(`${name} looks damaged or incomplete.`);

  const entries: { id: number; offset: number }[] = [];
  for (let i = 0; i < count; i++) entries.push({ id: dv.getUint32(8 + i * 8, true), offset: dv.getUint32(12 + i * 8, true) });

  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  const newOffset = new Map<number, number>();
  let used = 0;
  let changed = 0;
  let unmappable = 0;

  // Strings can share data (two IDs, one offset), so convert each distinct offset once, in file order.
  for (const offset of [...new Set(entries.map((e) => e.offset))].sort((a, b) => a - b)) {
    let o = dataStart + offset;
    let chunk: Uint8Array;
    if (o >= bytes.length || (lengthPrefixed && o + 4 > bytes.length)) {
      chunk = new Uint8Array(lengthPrefixed ? 4 : 1); // points outside the file: keep an empty string
    } else {
      let end: number;
      if (lengthPrefixed) {
        const len = dv.getUint32(o, true);
        o += 4;
        end = Math.min(bytes.length, o + len);
      } else {
        end = bytes.indexOf(0, o);
        if (end < 0) end = bytes.length;
      }
      const raw = bytes.subarray(o, end);
      const hadNull = raw.length > 0 && raw[raw.length - 1] === 0;
      const text = hadNull ? raw.subarray(0, raw.length - 1) : raw;
      let body: Uint8Array = text;
      if (!isAscii(text)) {
        let decoded: string | null = null;
        try {
          decoded = utf8.decode(text);
        } catch {
          /* not UTF-8: already Windows-1252 */
        }
        if (decoded !== null) {
          const enc = encodeCp1252(decoded);
          body = enc.bytes;
          unmappable += enc.unmappable;
          changed++;
        }
      }
      const terminator = lengthPrefixed ? (hadNull ? 1 : 0) : 1;
      const payload = new Uint8Array(body.length + terminator);
      payload.set(body);
      if (lengthPrefixed) {
        chunk = new Uint8Array(4 + payload.length);
        new DataView(chunk.buffer).setUint32(0, payload.length, true);
        chunk.set(payload, 4);
      } else chunk = payload;
    }
    newOffset.set(offset, used);
    chunks.push(chunk);
    used += chunk.length;
  }

  const out = new Uint8Array(8 + count * 8 + used);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, count, true);
  odv.setUint32(4, used, true);
  entries.forEach((e, i) => {
    odv.setUint32(8 + i * 8, e.id, true);
    odv.setUint32(12 + i * 8, newOffset.get(e.offset)!, true);
  });
  let w = dataStart;
  for (const c of chunks) {
    out.set(c, w);
    w += c.length;
  }
  return { bytes: out, changed, unmappable, total: count };
}
