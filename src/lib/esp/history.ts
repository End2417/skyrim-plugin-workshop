// Undo and redo. Records are edited in place, so each step remembers a record's state from just before it changed and
// swaps it back on undo. UI-free so it stays testable.
//
// How edits are seen: format.ts calls the history (setMutationObserver) right before any record is first changed. Edits to
// the same record that follow each other quickly (typing a number digit by digit) become one step. Several records changed
// together (a bulk edit) become one step through `batch`. Deleting and creating records are steps of their own.
import { revertRecord, setMutationObserver, type EspFile, type EspGroup, type EspNode, type EspRecord, type Subrecord } from "./format";

/** One undoable thing. Undo and redo are always called in turn, never twice in a row. */
interface Step {
  label: string;
  undo(): void;
  redo(): void;
}

type RecordState =
  | { clean: true }
  | { clean: false; flags: number; formId: number; stamp: number; version: number; unknown: number; subrecords: Subrecord[]; original: EspRecord["original"] };

const copySubs = (subs: Subrecord[]): Subrecord[] => subs.map((s) => ({ type: s.type, data: s.data.slice() }));

/** The record as it is now. A record nobody has edited is just "clean": its own bytes are the original. */
export function captureRecord(r: EspRecord): RecordState {
  if (!r.dirty) return { clean: true };
  return {
    clean: false,
    flags: r.flags,
    formId: r.formId,
    stamp: r.stamp,
    version: r.version,
    unknown: r.unknown,
    subrecords: copySubs(r.subrecords ?? []),
    original: r.original ? { ...r.original } : undefined,
  };
}

export function restoreRecord(r: EspRecord, s: RecordState): void {
  if (s.clean) {
    revertRecord(r);
    return;
  }
  r.flags = s.flags;
  r.formId = s.formId;
  r.stamp = s.stamp;
  r.version = s.version;
  r.unknown = s.unknown;
  r.subrecords = copySubs(s.subrecords);
  r.original = s.original ? { ...s.original } : undefined;
  r.dirty = true;
  r.editorIdCache = undefined;
  r.nameCache = undefined;
}

class RecordStep implements Step {
  private after: RecordState | null = null;
  constructor(
    readonly label: string,
    readonly record: EspRecord,
    private before: RecordState,
  ) {}
  undo() {
    this.after = captureRecord(this.record);
    restoreRecord(this.record, this.before);
  }
  redo() {
    if (this.after) restoreRecord(this.record, this.after);
  }
}

/** A record or group put into or taken out of the tree, with the file's lists of deleted and created records as they were. */
class PresenceStep implements Step {
  constructor(
    readonly label: string,
    private file: EspFile,
    private list: EspNode[],
    private node: EspNode,
    private index: number,
    /** True when the node is in the tree right after the action (a creation), false after a deletion. */
    private presentAfter: boolean,
    private lists: { before: { deleted: string[] | undefined; created: EspRecord[] | undefined }; after: { deleted: string[] | undefined; created: EspRecord[] | undefined } },
  ) {}
  private put(present: boolean, lists: { deleted: string[] | undefined; created: EspRecord[] | undefined }) {
    const i = this.list.indexOf(this.node);
    if (present && i < 0) this.list.splice(Math.min(this.index, this.list.length), 0, this.node);
    if (!present && i >= 0) this.list.splice(i, 1);
    if (lists.deleted) this.file.deleted = [...lists.deleted];
    else delete this.file.deleted;
    if (lists.created) this.file.created = [...lists.created];
    else delete this.file.created;
  }
  undo() {
    this.put(!this.presentAfter, this.lists.before);
  }
  redo() {
    this.put(this.presentAfter, this.lists.after);
  }
}

class CompoundStep implements Step {
  constructor(
    readonly label: string,
    readonly steps: Step[],
  ) {}
  undo() {
    for (let i = this.steps.length - 1; i >= 0; i--) this.steps[i]!.undo();
  }
  redo() {
    for (const s of this.steps) s.redo();
  }
}

export interface HistoryOptions {
  /** Edits to one record closer together than this (ms) are one step. */
  coalesceMs?: number;
  /** Steps kept; the oldest are dropped. */
  limit?: number;
  now?: () => number;
}

const lists = (file: EspFile) => ({ deleted: file.deleted ? [...file.deleted] : undefined, created: file.created ? [...file.created] : undefined });

export class History {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private lastEdit = new Map<EspRecord, number>();
  private openBatch: Step[] | null = null;
  private readonly coalesceMs: number;
  private readonly limit: number;
  private readonly now: () => number;
  /** Bumped on every change, so a screen can tell the buttons need redrawing. */
  version = 0;

  constructor(opts: HistoryOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? 1200;
    this.limit = opts.limit ?? 200;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Starts listening for edits. Call `detach` (or attach another history) when the file is closed. */
  attach(): void {
    setMutationObserver((r) => this.before(r));
  }
  detach(): void {
    setMutationObserver(null);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastEdit.clear();
    this.openBatch = null;
    this.version++;
  }

  private push(step: Step): void {
    if (this.openBatch) {
      this.openBatch.push(step);
      return;
    }
    this.undoStack.push(step);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.version++;
  }

  /** Called with a record just before it is first changed. */
  before(r: EspRecord): void {
    const t = this.now();
    const last = this.lastEdit.get(r);
    this.lastEdit.set(r, t);
    if (!this.openBatch) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (last !== undefined && t - last < this.coalesceMs && top instanceof RecordStep && top.record === r) return; // same burst of typing
    } else if (this.openBatch.some((s) => s instanceof RecordStep && s.record === r)) {
      return; // a batch remembers each record once
    }
    this.push(new RecordStep("Edit record", r, captureRecord(r)));
  }

  /** Everything changed inside `fn` becomes one step. */
  batch<T>(label: string, fn: () => T): T {
    if (this.openBatch) return fn(); // already inside a batch
    const steps: Step[] = [];
    this.openBatch = steps;
    try {
      return fn();
    } finally {
      this.openBatch = null;
      if (steps.length > 0) this.push(new CompoundStep(label, steps));
    }
  }

  /** Remembers a record or group that was just added to, or taken out of, the tree. Call it before changing the tree. */
  trackPresence(label: string, file: EspFile, node: EspNode, change: () => void, creating: boolean): void {
    const list = (node.parent ? node.parent.children : file.nodes) as EspNode[];
    const index = list.indexOf(node);
    const before = lists(file);
    change();
    this.push(new PresenceStep(label, file, list, node, creating ? list.indexOf(node) : index, creating, { before, after: lists(file) }));
  }

  undo(): string | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    step.undo();
    this.redoStack.push(step);
    this.lastEdit.clear();
    this.version++;
    return step.label;
  }

  redo(): string | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    step.redo();
    this.undoStack.push(step);
    this.lastEdit.clear();
    this.version++;
    return step.label;
  }
}

export type { EspGroup };
