import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import { buildMerged, planMerge } from "./mergePlugins";
import { checkPlugin } from "./check";
import { decodeSubrecord } from "./decode";
import { encodeZString, getEditorId, getSubrecords, parseEsp, serializeEsp, walkRecords, type EspFile, type Subrecord } from "./format";
import { readVmad } from "./scripts";
import { ids, rawGroup, rawRecord, u32 } from "./testPlugin";

// Damaged files are common (half-copied downloads, broken mods). Whatever is wrong with the bytes, the editor has to say so
// with an ordinary error, never fail with something like "cannot read properties of undefined", and never hang.

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const header = (masters: string[]) => {
  const hedr = new Uint8Array(12);
  new DataView(hedr.buffer).setFloat32(0, 1.7, true);
  const subs: Subrecord[] = [{ type: "HEDR", data: hedr }];
  for (const m of masters) subs.push({ type: "MAST", data: encodeZString(m) }, { type: "DATA", data: new Uint8Array(8) });
  return rawRecord("TES4", 0, subs, 0);
};
const packed = (type: string, formId: number, subs: Subrecord[]) => {
  const raw = rawRecord(type, formId, subs);
  const body = raw.subarray(24);
  const z = new Uint8Array(zlibSync(body));
  const out = new Uint8Array(28 + z.length);
  out.set(raw.subarray(0, 24));
  const dv = new DataView(out.buffer);
  dv.setUint32(4, 4 + z.length, true);
  dv.setUint32(8, 0x40000, true);
  dv.setUint32(24, body.length, true);
  out.set(z, 28);
  return out;
};
const group = (groupType: number, label: number, children: Uint8Array[]) => {
  const g = rawGroup("AAAA", children);
  const dv = new DataView(g.buffer);
  dv.setInt32(12, groupType, true);
  dv.setUint32(8, label, true);
  return g;
};
const edid = (s: string): Subrecord => ({ type: "EDID", data: encodeZString(s) });

const seedPlugin = () =>
  concat([
    header(["Skyrim.esm"]),
    rawGroup("ARMO", [
      rawRecord("ARMO", 0x01000800, [edid("Armor"), { type: "KWDA", data: ids(1, 2) }, { type: "KSIZ", data: ids(2) }]),
      packed("ARMO", 0x01000801, [edid("Packed"), { type: "FULL", data: encodeZString("Name") }]),
    ]),
    rawGroup("CELL", [
      group(2, 0, [group(3, 0, [rawRecord("CELL", 0x01000900, [edid("Cell")]), group(6, 0x01000900, [group(9, 0x01000900, [rawRecord("REFR", 0x01000901, [{ type: "NAME", data: u32(0x1a000) }])])])])]),
    ]),
    rawGroup("DIAL", [rawRecord("DIAL", 0x01000a00, [edid("Topic")]), group(7, 0x01000a00, [rawRecord("INFO", 0x01000a01, [edid("Resp")])])]),
  ]);

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** Programming mistakes show up as TypeError ("x is undefined"); damaged data must not cause them. */
const isMistake = (e: unknown) => e instanceof TypeError;
const describeError = (e: unknown) => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));

describe("damaged plugins", () => {
  it("are refused or read with ordinary errors, and everything built on them copes", async () => {
    const rand = rng(20261118);
    const base = seedPlugin();
    const mistakes: string[] = [];
    const note = (stage: string, e: unknown) => {
      if (isMistake(e)) mistakes.push(`${stage}: ${describeError(e)}`);
    };
    let parsed = 0;
    let merged = 0;

    for (let i = 0; i < 400; i++) {
      const b = base.slice();
      const mode = Math.floor(rand() * 4);
      if (mode === 0) for (let k = 0; k < 1 + rand() * 6; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
      if (mode === 1) for (let k = 0; k < 3; k++) new DataView(b.buffer).setUint32(Math.floor(rand() * (b.length - 4)), Math.floor(rand() * 4294967296), true);
      const data = mode === 2 ? b.subarray(0, Math.floor(rand() * b.length)) : mode === 3 ? concat([b, b.subarray(0, Math.floor(rand() * 200))]) : b;

      let file: EspFile;
      try {
        file = parseEsp(data, "Damaged.esp");
      } catch (e) {
        note("parse", e);
        continue;
      }
      parsed++;
      for (const r of walkRecords(file.nodes)) {
        try {
          getEditorId(r);
          for (const s of getSubrecords(r)) {
            try {
              decodeSubrecord(r.type, s, "", { localized: false, resolveFormId: (id: number) => id.toString(16) });
            } catch (e) {
              note("decode", e);
            }
          }
        } catch (e) {
          note("records", e);
        }
      }
      try {
        serializeEsp(file);
      } catch (e) {
        note("serialize", e);
      }
      try {
        await checkPlugin(file, {}, () => false);
      } catch (e) {
        note("check", e);
      }
      try {
        const other = parseEsp(seedPlugin(), "Other.esp");
        const plan = await planMerge([file, other], {});
        if (plan?.ok) {
          const result = await buildMerged([file, other], plan);
          if (result) merged++;
        }
      } catch (e) {
        note("merge", e);
      }
    }

    expect(mistakes).toEqual([]);
    // the test is only meaningful if a good share of the damaged files still got through to the later stages
    expect(parsed).toBeGreaterThan(30);
    expect(merged).toBeGreaterThan(5);
  });

  it("never make script reading throw or hang", () => {
    const rand = rng(7);
    for (let i = 0; i < 2000; i++) {
      const d = new Uint8Array(Math.floor(rand() * 90));
      for (let j = 0; j < d.length; j++) d[j] = rand() < 0.4 ? [2, 5, 3, 1, 0][Math.floor(rand() * 5)]! : Math.floor(rand() * 256);
      expect(() => readVmad(d, ["QUST", "ACTI", "INFO", "PACK"][i % 4]!)).not.toThrow();
    }
  });
});
