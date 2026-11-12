import { describe, expect, it } from "vitest";
import { buildPlugin, ids } from "./testPlugin";
import { checkPlugin, localIds } from "./check";

const weapon = (refs: number[], formId = 0x01000801) => ({ type: "WEAP", formId, edid: "MySword", subs: [{ type: "KWDA", data: ids(...refs) }] });

describe("checkPlugin", () => {
  it("finds nothing wrong in a consistent plugin", async () => {
    const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [{ type: "KYWD", formId: 0x01000800, edid: "K" }, weapon([0x01000800, 0x00012345])]);
    const report = (await checkPlugin(file))!;
    expect(report.total).toBe(0);
    expect(report.records).toBe(2);
    expect(report.refs).toBe(2);
    expect(report.masters).toEqual([{ name: "Skyrim.esm", uses: 1, verified: false }]);
  });

  it("flags a FormID that points at a master slot the header does not list", async () => {
    const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [weapon([0x02000800])]);
    const report = (await checkPlugin(file))!;
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ kind: "undeclared-master", target: 0x02000800, where: "KWDA › Keyword" });
  });

  it("flags a reference to a record missing from this plugin", async () => {
    const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [weapon([0x01000999])]);
    expect((await checkPlugin(file))!.issues[0]).toMatchObject({ kind: "missing-record", target: 0x01000999 });
  });

  it("flags a record whose own FormID uses an unlisted master slot", async () => {
    const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [{ type: "KYWD", formId: 0x03000800, edid: "K" }]);
    expect((await checkPlugin(file))!.issues[0]).toMatchObject({ kind: "own-id", where: "Record FormID" });
  });

  it("reports each missing target once per record", async () => {
    const file = buildPlugin("Mod.esp", [], [weapon([0x00000900, 0x00000900], 0x00000801)]);
    expect((await checkPlugin(file))!.total).toBe(1);
  });

  it("looks up references into a master only when its file is supplied", async () => {
    const mod = () => buildPlugin("Mod.esp", ["Skyrim.esm"], [weapon([0x00012345, 0x00099999])]);
    expect((await checkPlugin(mod()))!.total).toBe(0);

    const skyrim = buildPlugin("Skyrim.esm", [], [{ type: "KYWD", formId: 0x00012345, edid: "K" }]);
    const report = (await checkPlugin(mod(), { masterIds: new Map([["skyrim.esm", localIds(skyrim)]]) }))!;
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ kind: "missing-record", target: 0x00099999 });
    expect(report.masters[0]).toMatchObject({ verified: true });
  });

  it("does not demand engine-reserved FormIDs (player, gold...) exist", async () => {
    const file = buildPlugin("Mod.esp", [], [weapon([0x0000000f, 0x00000014], 0x00000801)]);
    expect((await checkPlugin(file))!.total).toBe(0);
  });

  it("can be cancelled", async () => {
    const file = buildPlugin("Mod.esp", [], Array.from({ length: 3000 }, (_, i) => ({ type: "KYWD", formId: 0x800 + i, edid: `K${i}` })));
    expect(await checkPlugin(file, {}, () => true)).toBeNull();
  });
});
