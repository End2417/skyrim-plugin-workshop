// Builds tiny BSA archives and LZ4 data in memory for tests. Not imported by the app.
import { zlibSync } from "fflate";

export const text = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
export const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

// Greedy LZ4 block encoder.
export function lz4Block(input: Uint8Array): number[] {
  const out: number[] = [];
  const n = input.length;
  const table = new Map<number, number>();
  const ext = (v: number) => {
    while (v >= 255) (out.push(255), (v -= 255));
    out.push(v);
  };
  const sequence = (litStart: number, litEnd: number, offset: number, matchLen: number) => {
    const lit = litEnd - litStart;
    out.push((Math.min(lit, 15) << 4) | (matchLen ? Math.min(matchLen - 4, 15) : 0));
    if (lit >= 15) ext(lit - 15);
    for (let i = litStart; i < litEnd; i++) out.push(input[i]!);
    if (matchLen) {
      out.push(offset & 0xff, offset >> 8);
      if (matchLen - 4 >= 15) ext(matchLen - 4 - 15);
    }
  };
  let anchor = 0;
  let i = 0;
  while (i + 4 <= n - 5) {
    const key = (input[i]! | (input[i + 1]! << 8) | (input[i + 2]! << 16) | (input[i + 3]! << 24)) >>> 0;
    const cand = table.get(key);
    table.set(key, i);
    if (cand !== undefined && i - cand <= 65535) {
      let m = 4;
      while (i + m < n - 5 && input[cand + m] === input[i + m]) m++;
      sequence(anchor, i, i - cand, m);
      i += m;
      anchor = i;
    } else i++;
  }
  sequence(anchor, n, 0, 0);
  return out;
}

/** LZ4 frame in independent blocks of `blockSize`; blocks listed in `stored` are written uncompressed. */
export function lz4Frame(input: Uint8Array, blockSize = 65536, stored: number[] = []): Uint8Array {
  const out: number[] = [0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x00];
  let idx = 0;
  for (let p = 0; p < input.length; p += blockSize, idx++) {
    const chunk = input.subarray(p, Math.min(input.length, p + blockSize));
    if (stored.includes(idx)) out.push(...le32(chunk.length | 0x80000000), ...chunk);
    else {
      const b = lz4Block(chunk);
      out.push(...le32(b.length), ...b);
    }
  }
  out.push(0, 0, 0, 0);
  return Uint8Array.from(out);
}



export interface F {
  folder: string;
  name: string;
  data: Uint8Array;
  /** Store this file the other way round from the archive's default. */
  toggle?: boolean;
}
export function buildBsa(version: 104 | 105, files: F[], opts: { compress?: boolean; embed?: boolean } = {}): Uint8Array {
  const compress = opts.compress ?? false;
  const folders = [...new Set(files.map((f) => f.folder))];
  const folderSize = version === 105 ? 24 : 16;
  const payloads = files.map((f) => {
    const packed = compress !== !!f.toggle;
    const body = packed ? [...le32(f.data.length), ...(version === 105 ? lz4Frame(f.data) : zlibSync(f.data))] : Array.from(f.data);
    const embedded = opts.embed ? [`${f.folder}\\${f.name}`.length, ...Array.from(text(`${f.folder}\\${f.name}`))] : [];
    return { f, bytes: [...embedded, ...body], packed };
  });
  const totalNames = files.reduce((a, f) => a + f.name.length + 1, 0);
  const blocks = folders.map((fo) => ({ fo, files: payloads.filter((p) => p.f.folder === fo) }));
  const blockSize = (b: (typeof blocks)[number]) => 1 + b.fo.length + 1 + b.files.length * 16;
  const recordsEnd = 36 + folders.length * folderSize;
  const blocksTotal = blocks.reduce((a, b) => a + blockSize(b), 0);
  const dataStart = recordsEnd + blocksTotal + totalNames;

  const out: number[] = [0x42, 0x53, 0x41, 0, ...le32(version), ...le32(36), ...le32(0x3 | (compress ? 0x4 : 0) | (opts.embed ? 0x100 : 0)), ...le32(folders.length), ...le32(files.length), ...le32(folders.reduce((a, f) => a + f.length + 1, 0)), ...le32(totalNames), 0, 0, 0, 0];
  let blockPos = recordsEnd;
  for (const b of blocks) {
    out.push(...Array(8).fill(0), ...le32(b.files.length));
    if (version === 105) out.push(0, 0, 0, 0, ...le32(blockPos + totalNames), 0, 0, 0, 0);
    else out.push(...le32(blockPos + totalNames));
    blockPos += blockSize(b);
  }
  let dataPos = dataStart;
  const order: typeof payloads = [];
  for (const b of blocks) {
    out.push(b.fo.length + 1, ...Array.from(text(b.fo)), 0);
    for (const p of b.files) {
      out.push(...Array(8).fill(0), ...le32((p.bytes.length | (p.packed !== compress ? 0x40000000 : 0)) >>> 0), ...le32(dataPos));
      dataPos += p.bytes.length;
      order.push(p);
    }
  }
  for (const p of order) out.push(...Array.from(text(p.f.name)), 0);
  for (const p of order) out.push(...p.bytes);
  return Uint8Array.from(out);
}

/** A .STRINGS file: id and text pairs. */
export function stringsFile(entries: [number, string][], lengthPrefixed = false): Uint8Array {
  const data: number[] = [];
  const dir: number[] = [];
  for (const [id, s] of entries) {
    dir.push(...le32(id), ...le32(data.length));
    const bytes = Array.from(new TextEncoder().encode(s));
    if (lengthPrefixed) data.push(...le32(bytes.length + 1));
    data.push(...bytes, 0);
  }
  return Uint8Array.from([...le32(entries.length), ...le32(data.length), ...dir, ...data]);
}


export const repetitive = (n: number) => text(Array.from({ length: n }, (_, i) => `line ${i % 37}: the quick brown fox jumps over the lazy dog\n`).join(""));
