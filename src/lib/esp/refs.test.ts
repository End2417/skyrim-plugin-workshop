import { describe, expect, it } from "vitest";
import { buildPlugin, ids, u32 } from "./testPlugin";
import { collectFormIdRefs } from "./refs";
import { walkRecords } from "./format";

describe("collectFormIdRefs", () => {
  it("lists typed FormID fields and skips null references", () => {
    const file = buildPlugin("Mod.esp", ["Skyrim.esm"], [
      {
        type: "WEAP",
        formId: 0x01000801,
        edid: "MySword",
        subs: [
          { type: "KSIZ", data: u32(2) },
          { type: "KWDA", data: ids(0x01000800, 0x00012345) },
          { type: "SNAM", data: ids(0) },
          { type: "INAM", data: ids(0x01000802) },
        ],
      },
    ]);
    const weap = [...walkRecords(file.nodes)].find((r) => r.type === "WEAP")!;
    const refs = collectFormIdRefs(weap, false);
    expect(refs.map((r) => r.id)).toEqual([0x01000800, 0x00012345, 0x01000802]);
    expect(refs[0]).toMatchObject({ sub: "KWDA" });
  });

  it("does not keep a parsed copy on the record", () => {
    const file = buildPlugin("Mod.esp", [], [{ type: "KYWD", formId: 0x800, edid: "K" }]);
    const kywd = [...walkRecords(file.nodes)].find((r) => r.type === "KYWD")!;
    collectFormIdRefs(kywd, false);
    expect(kywd.subrecords).toBeNull();
  });
});
