import { describe, expect, it } from "vitest";
import { libraryOf, readVmad, scanScripts, scriptFileList } from "./scripts";
import { encodeText } from "./format";
import { buildPlugin } from "./testPlugin";

// ---- tiny VMAD writer for the tests ----
const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u8 = (n: number) => [n & 0xff];
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const i16 = u16;
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const f32 = (n: number) => Array.from(new Uint8Array(new Float32Array([n]).buffer));
const ws = (s: string) => [...u16(s.length), ...Array.from(encodeText(s))];

const obj2 = (formId: number, alias = -1) => [...u16(0), ...i16(alias), ...u32(formId)];
const obj1 = (formId: number, alias = -1) => [...u32(formId), ...i16(alias), ...u16(0)];

interface P {
  name: string;
  body: number[];
  type: number;
  status?: number;
}
const prop = (p: P) => [...ws(p.name), ...u8(p.type), ...u8(p.status ?? 1), ...p.body];
const script = (name: string, props: P[], status = 0) => [...ws(name), ...u8(status), ...u16(props.length), ...props.flatMap(prop)];
const header = (scripts: number[][], version = 5, format = 2) => [...i16(version), ...i16(format), ...u16(scripts.length), ...scripts.flat()];

describe("readVmad", () => {
  it("reads scripts and every kind of property", () => {
    const data = bytes(
      header([
        script("MyFollowerScript", [
          { name: "Leader", type: 1, body: obj2(0x00012eb7, 3) },
          { name: "Greeting", type: 2, body: ws("Hello") },
          { name: "Count", type: 3, body: u32(7) },
          { name: "Speed", type: 4, body: f32(1.5) },
          { name: "Enabled", type: 5, body: u8(1) },
          { name: "Gone", type: 0, body: [] },
          { name: "Targets", type: 11, body: [...u32(2), ...obj2(0x01000801), ...obj2(0x01000802)] },
          { name: "Names", type: 12, body: [...u32(1), ...ws("a")] },
          { name: "Nums", type: 13, body: [...u32(0)] },
        ]),
        script("SKI_ConfigBase", []),
      ]),
    );
    const info = readVmad(data, "QUST");
    expect(info.complete).toBe(true);
    expect(info.scripts.map((s) => s.name)).toEqual(["MyFollowerScript", "SKI_ConfigBase"]);
    const props = info.scripts[0]!.properties;
    expect(props.map((p) => p.typeName)).toEqual(["Object", "String", "Int", "Float", "Bool", "None", "Object[]", "String[]", "Int[]"]);
    expect(props[0]).toMatchObject({ formId: 0x00012eb7, alias: 3, text: "00012EB7 alias 3" });
    expect(props[1]!.text).toBe('"Hello"');
    expect(props[2]!.text).toBe("7");
    expect(props[3]!.text).toBe("1.5");
    expect(props[4]!.text).toBe("true");
    expect(props[6]).toMatchObject({ formId: 0x01000801, text: "[01000801, … 2 entries]" });
    expect(props[8]!.text).toBe("[] (empty)");
  });

  it("reads the older object layout (FormID first)", () => {
    const data = bytes(header([script("S", [{ name: "P", type: 1, body: obj1(0x01000abc, 2) }])], 5, 1));
    const p = readVmad(data, "ACTI").scripts[0]!.properties[0]!;
    expect(p).toMatchObject({ formId: 0x01000abc, alias: 2 });
  });

  it("keeps the scripts it found when the data is cut short", () => {
    const full = bytes(header([script("First", []), script("Second", [{ name: "X", type: 2, body: ws("long text here") }])]));
    const info = readVmad(full.subarray(0, full.length - 6), "ACTI");
    expect(info.complete).toBe(false);
    expect(info.note).toContain("ends too early");
  });

  it("refuses an unknown version or property type without throwing", () => {
    expect(readVmad(bytes(header([], 9)), "ACTI")).toMatchObject({ complete: false });
    const info = readVmad(bytes(header([script("S", [{ name: "P", type: 99, body: [] }])])), "ACTI");
    expect(info.complete).toBe(false);
    expect(info.note).toContain("type (99)");
    expect(readVmad(new Uint8Array(0), "ACTI").complete).toBe(false);
  });

  it("rejects script names that are not names (garbage is not reported as scripts)", () => {
    const info = readVmad(bytes(header([[...ws("not a script!"), 0, 0, 0]])), "ACTI");
    expect(info.complete).toBe(false);
    expect(info.scripts).toHaveLength(0);
  });

  it("lists quest fragment and alias scripts", () => {
    const aliasScripts = (alias: number, names: string[]) => [...obj2(0x01000800, alias), ...i16(5), ...i16(2), ...u16(names.length), ...names.flatMap((n) => script(n, []))];
    const data = bytes(
      header([script("QuestMain", [])]),
      [
        ...u8(2),
        ...u16(1),
        ...ws("QF_MyQuest_01000800"),
        ...u16(10), ...i16(0), ...u32(0), ...u8(1), ...ws("QF_MyQuest_01000800"), ...ws("Fragment_0"),
        ...u16(2),
        ...aliasScripts(0, ["FollowerAlias"]),
        ...aliasScripts(1, ["FollowerAlias", "PlayerAlias"]),
      ],
    );
    const info = readVmad(data, "QUST");
    expect(info.complete).toBe(true);
    expect(info.scripts.map((s) => `${s.kind}:${s.name}${s.aliasId !== undefined ? `@${s.aliasId}` : ""}`)).toEqual([
      "script:QuestMain",
      "fragment:QF_MyQuest_01000800",
      "alias:FollowerAlias@0",
      "alias:FollowerAlias@1",
      "alias:PlayerAlias@1",
    ]);
  });

  it("lists the fragment script of dialogue and packages, and says what it skips", () => {
    const frag = bytes(header([]), [...u8(2), ...u8(1), ...ws("TIF__01000900")]);
    expect(readVmad(frag, "INFO").scripts.map((s) => s.name)).toEqual(["TIF__01000900"]);
    const scene = bytes(header([script("S", [])]), [1, 2, 3]);
    const info = readVmad(scene, "SCEN");
    expect(info.scripts.map((s) => s.name)).toEqual(["S"]);
    expect(info.complete).toBe(false);
    expect(info.note).toContain("SCEN");
  });
});

describe("libraryOf", () => {
  it("recognises well-known libraries by name only", () => {
    expect(libraryOf("SKI_ConfigBase")?.needs).toContain("SkyUI");
    expect(libraryOf("PO3_SKSEFunctions")?.name).toBe("Papyrus Extender");
    expect(libraryOf("JMap")?.name).toBe("JContainers");
    expect(libraryOf("MCM")?.name).toBe("MCM Helper");
    expect(libraryOf("MyFollowerScript")).toBeNull();
    expect(libraryOf("Jacket")).toBeNull();
  });
});

describe("scanScripts", () => {
  const vmad = (scripts: number[][]) => ({ type: "VMAD", data: bytes(header(scripts)) });

  it("summarises scripts across records and flags properties that point nowhere", async () => {
    const file = buildPlugin("Follower.esp", ["Skyrim.esm"], [
      { type: "NPC_", formId: 0x01000800, edid: "Follower", subs: [vmad([script("FollowerScript", [{ name: "Ok", type: 1, body: obj2(0x01000801) }, { name: "Skyrim", type: 1, body: obj2(0x00012eb7) }, { name: "Gone", type: 1, body: obj2(0x01000999) }, { name: "Bad", type: 1, body: obj2(0x05000800) }, { name: "Player", type: 1, body: obj2(0x00000014) }])])] },
      { type: "ACTI", formId: 0x01000801, edid: "Marker", subs: [vmad([script("FollowerScript", []), script("SKI_ConfigBase", [])])] },
      { type: "MISC", formId: 0x01000802, edid: "NoScripts" },
    ]);
    const report = (await scanScripts(file))!;
    expect(report.scanned).toBe(3);
    expect(report.records).toHaveLength(2);
    expect(report.scripts.map((s) => s.name)).toEqual(["SKI_ConfigBase", "FollowerScript"]); // known libraries first
    const follower = report.scripts.find((s) => s.name === "FollowerScript")!;
    expect(follower).toMatchObject({ recordCount: 2, types: { NPC_: 1, ACTI: 1 } });
    expect(report.libraries).toHaveLength(1);
    expect(report.libraries[0]!.library.name).toBe("SkyUI");
    expect(report.issues.map((i) => [i.kind, i.property])).toEqual([
      ["missing-record", "Gone"],
      ["undeclared-master", "Bad"],
    ]);
    expect(scriptFileList(report)).toBe("SKI_ConfigBase.pex\nFollowerScript.pex");
  });

  it("ignores properties of removed scripts and reports records it cannot read", async () => {
    const file = buildPlugin("A.esp", [], [
      { type: "ACTI", formId: 0x00000801, edid: "A", subs: [vmad([script("Old", [{ name: "P", type: 1, body: obj2(0x00000999) }], 3)])] },
      { type: "ACTI", formId: 0x00000802, edid: "B", subs: [{ type: "VMAD", data: Uint8Array.from([5, 0, 2, 0, 9]) }] },
    ]);
    const report = (await scanScripts(file))!;
    expect(report.issues).toHaveLength(0);
    expect(report.scripts[0]).toMatchObject({ name: "Old", removed: 1 });
    expect(report.unreadable).toHaveLength(1);
  });

  it("stops when cancelled", async () => {
    const file = buildPlugin("A.esp", [], Array.from({ length: 3200 }, (_, i) => ({ type: "ACTI", formId: 0x800 + i, edid: `A${i}` })));
    expect(await scanScripts(file, () => true)).toBeNull();
  });
});
