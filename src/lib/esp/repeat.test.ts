import { describe, expect, it } from "vitest";
import { canAddAnother, insertionIndex } from "./repeat";

const sub = (type: string) => ({ type, data: new Uint8Array(0) });

describe("canAddAnother", () => {
  it("offers it for list fields and for anything already repeated", () => {
    expect(canAddAnother("NPC_", "CNTO", 1)).toBe(true);
    expect(canAddAnother("NPC_", "SNAM", 1)).toBe(true);
    expect(canAddAnother("WEAP", "DATA", 2)).toBe(true);
  });
  it("does not offer it for single fields", () => {
    expect(canAddAnother("WEAP", "DNAM", 1)).toBe(false);
    expect(canAddAnother("WEAP", "SNAM", 1)).toBe(false); // a single sound on a weapon, not a faction list
  });
});

describe("insertionIndex", () => {
  it("goes right after the entry", () => {
    expect(insertionIndex([sub("COCT"), sub("CNTO"), sub("CNTO")], 1)).toBe(2);
  });
  it("skips the extra data that belongs to a container item", () => {
    expect(insertionIndex([sub("CNTO"), sub("COED"), sub("CNTO")], 0)).toBe(2);
  });
});
