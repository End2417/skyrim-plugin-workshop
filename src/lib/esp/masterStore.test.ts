import { describe, expect, it } from "vitest";
import { packIds, unpackIds } from "./masterStore";

describe("master ID storage", () => {
  it("round-trips a set of FormIDs, including ones above 2^31", () => {
    const ids = new Set([0x800, 0x123456, 0x00ffffff, 0xfe000801]);
    const back = unpackIds(packIds(ids));
    expect([...back].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
  });
  it("handles an empty file", () => expect(unpackIds(packIds(new Set())).size).toBe(0));
});
