import { describe, expect, it } from "vitest";
import { buildPlugin } from "./testPlugin";
import { getEditorId, walkRecords, type EspRecord } from "./format";
import { nextSort, sortChildren, sortRecords } from "./sort";

const named = (formId: number, edid: string, full: string | null) => ({
  type: "MISC",
  formId,
  edid,
  subs: full === null ? [] : [{ type: "FULL", data: Uint8Array.from([...new TextEncoder().encode(full), 0]) }],
});

function records(): EspRecord[] {
  const f = buildPlugin("T.esp", ["Skyrim.esm"], [
    named(0x01000812, "Cup", "Wooden Cup"),
    named(0x01000800, "Apple", "apple"),
    named(0x01000805, "", null),
    named(0x01000810, "Bowl10", "Bowl 10"),
    named(0x01000809, "Bowl2", "Bowl 2"),
  ]);
  return [...walkRecords(f.nodes)].filter((r) => r.type === "MISC");
}
const edids = (rs: EspRecord[]) => rs.map((r) => getEditorId(r) || null); // "" (no Editor ID) shown as null

describe("nextSort", () => {
  it("goes ascending, descending, then off, and restarts on another column", () => {
    const a = nextSort(null, "name");
    expect(a).toEqual({ column: "name", dir: "asc" });
    const b = nextSort(a, "name");
    expect(b).toEqual({ column: "name", dir: "desc" });
    expect(nextSort(b, "name")).toBe(null);
    expect(nextSort(b, "formId")).toEqual({ column: "formId", dir: "asc" });
  });
});

describe("sortRecords", () => {
  it("sorts by FormID numerically, both ways", () => {
    const rs = records();
    expect(edids(sortRecords(rs, { column: "formId", dir: "asc" }, false))).toEqual(["Apple", null, "Bowl2", "Bowl10", "Cup"]);
    expect(edids(sortRecords(rs, { column: "formId", dir: "desc" }, false))).toEqual(["Cup", "Bowl10", "Bowl2", null, "Apple"]);
  });
  it("sorts by Editor ID alphabetically with numbers in order, empty ones last", () => {
    const rs = records();
    expect(edids(sortRecords(rs, { column: "editorId", dir: "asc" }, false))).toEqual(["Apple", "Bowl2", "Bowl10", "Cup", null]);
    expect(edids(sortRecords(rs, { column: "editorId", dir: "desc" }, false))).toEqual(["Cup", "Bowl10", "Bowl2", "Apple", null]);
  });
  it("sorts by name ignoring case", () => {
    const rs = records();
    expect(edids(sortRecords(rs, { column: "name", dir: "asc" }, false))).toEqual(["Apple", "Bowl2", "Bowl10", "Cup", null]);
  });
  it("does not change the input", () => {
    const rs = records();
    const before = edids(rs);
    sortRecords(rs, { column: "editorId", dir: "desc" }, false);
    expect(edids(rs)).toEqual(before);
  });
});

describe("sortChildren", () => {
  it("leaves groups that contain sub-groups in file order", () => {
    const rs = records();
    const group = { kind: "group" as const } as never;
    const mixed = [rs[0]!, group, rs[1]!];
    expect(sortChildren(mixed, { column: "formId", dir: "asc" }, false)).toBe(mixed);
  });
});
