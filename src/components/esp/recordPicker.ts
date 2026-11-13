import { createContext } from "react";
/**
 * Finds records by what they are called, for the reference editor's suggestions: those in the open plugin, then those
 * in its remembered masters. Resolves to FormIDs as the open plugin would write them, or to null while the search
 * index is still being prepared.
 */
export type RecordFinder = (query: string, limit: number, cancelled: () => boolean) => Promise<number[] | null>;

export const RecordFinderContext = createContext<RecordFinder | null>(null);
