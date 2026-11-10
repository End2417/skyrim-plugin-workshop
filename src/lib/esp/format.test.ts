import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import {
  FLAG_COMPRESSED,
  deleteRecord,
  encodeZString,
  getEditorId,
  getSubrecords,
  markDirty,
  parseEsp,
  serializeEsp,
  serializeSubrecords,
  type EspFile,
  type EspGroup,
  type EspRecord,
} from "./format";

const sig = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
function record(type: string, formId: number, body: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(24 + body.length);
  const dv = new DataView(out.buffer);
  out.set(sig(type), 0);
  dv.setUint32(4, body.length, true);
  dv.setUint32(8, flags, true);
  dv.setUint32(12, formId, true);
  dv.setUint16(20, 44, true);
  out.set(body, 24);
  return out;
}
function group(label: string, children: Uint8Array[]): Uint8Array {
  const size = 24 + children.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(sig("GRUP"), 0);
  dv.setUint32(4, size, true);
  out.set(sig(label), 8);
  let o = 24;
  for (const c of children) (out.set(c, o), (o += c.length));
  return out;
}
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

function samplePlugin() {
  const hedr = new Uint8Array(12);
  new DataView(hedr.buffer).setFloat32(0, 1.7, true);
  new DataView(hedr.buffer).setInt32(4, 4, true);
  const tes4 = record("TES4", 0, serializeSubrecords([{ type: "HEDR", data: hedr }]));
  const big = new Uint8Array(70000).fill(7);
  const weap = record(
    "WEAP",
    0x01000800,
    serializeSubrecords([
      { type: "EDID", data: encodeZString("IronSword") },
      { type: "MODL", data: big },
    ]),
  );
  const inner = serializeSubrecords([{ type: "EDID", data: encodeZString("Bandit") }]);
  const z = zlibSync(inner);
  const compressedBody = new Uint8Array(4 + z.length);
  new DataView(compressedBody.buffer).setUint32(0, inner.length, true);
  compressedBody.set(z, 4);
  const npc = record("NPC_", 0x01000801, compressedBody, FLAG_COMPRESSED);
  return concat([tes4, group("WEAP", [weap]), group("NPC_", [npc])]);
}

const firstIn = (f: EspFile, i: number) => (f.nodes[i] as EspGroup).children[0] as EspRecord;

describe("Skyrim plugin format", () => {
  it("saves an unedited plugin byte-for-byte identical", () => {
    const bytes = samplePlugin();
    expect(serializeEsp(parseEsp(bytes))).toEqual(bytes);
  });

  it("reads subrecords larger than 65535 bytes", () => {
    const file = parseEsp(samplePlugin());
    const weap = firstIn(file, 1);
    expect(getSubrecords(weap).map((s) => [s.type, s.data.length])).toEqual([
      ["EDID", 10],
      ["MODL", 70000],
    ]);
  });

  it("keeps edits to a compressed record after saving and reopening", () => {
    const file = parseEsp(samplePlugin());
    const npc = firstIn(file, 2);
    expect(getEditorId(npc)).toBe("Bandit");
    markDirty(npc);
    getSubrecords(npc)[0]!.data = encodeZString("BanditChief");
    const reopened = parseEsp(serializeEsp(file));
    const npc2 = firstIn(reopened, 2);
    expect(npc2.flags & FLAG_COMPRESSED).toBe(FLAG_COMPRESSED);
    expect(getEditorId(npc2)).toBe("BanditChief");
  });

  it("lowers the header's record count by one when a record is deleted", () => {
    const file = parseEsp(samplePlugin());
    deleteRecord(file, firstIn(file, 1));
    const reopened = parseEsp(serializeEsp(file));
    const hedr = getSubrecords(reopened.nodes[0] as EspRecord)[0]!.data;
    expect(new DataView(hedr.buffer).getInt32(4, true)).toBe(3);
  });
});
