// Auto-backup: before the first save of a plugin that was opened, a copy of the original file is written next to the saved
// one. Saving never overwrites anything, so this mainly protects the original when the saved copy is later copied over it
// by hand. Only the Android app does it: a browser cannot save two files quietly.
const KEY = "esp-editor-auto-backup";

/** On unless the person turned it off. */
export function autoBackupEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutoBackup(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable: the default (on) stays */
  }
}

/** "Mod.esp" -> "Mod.esp.bak": no plugin extension, so a game or mod manager never loads it by mistake. */
export const backupFileName = (name: string) => `${name}.bak`;

/**
 * Remembers which originals were already backed up this session, so saving again and again does not write the same copy
 * each time. A file is told apart by its name and size.
 */
export class BackupLedger {
  private done = new Set<string>();
  private key = (name: string, size: number) => `${name.toLowerCase()}:${size}`;
  has(name: string, size: number): boolean {
    return this.done.has(this.key(name, size));
  }
  add(name: string, size: number): void {
    this.done.add(this.key(name, size));
  }
}
