import { describe, expect, it } from "vitest";
import { BackupLedger, backupFileName } from "./backup";

describe("backup", () => {
  it("names the copy so it cannot be loaded as a plugin", () => {
    expect(backupFileName("Mod.esp")).toBe("Mod.esp.bak");
    expect(backupFileName("Mod.esl")).toMatch(/\.bak$/);
  });

  it("remembers what was backed up, by name (any case) and size", () => {
    const ledger = new BackupLedger();
    expect(ledger.has("Mod.esp", 100)).toBe(false);
    ledger.add("Mod.esp", 100);
    expect(ledger.has("MOD.ESP", 100)).toBe(true);
    expect(ledger.has("Mod.esp", 101)).toBe(false);
    expect(ledger.has("Other.esp", 100)).toBe(false);
  });
});
