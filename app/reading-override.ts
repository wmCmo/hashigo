import type { ScopedDb } from "./deck-scope.js";
import { yomiOf } from "../src/fields/yomi.js";

export function readingOverride(db: ScopedDb, cardId: string): string | null {
  return yomiOf(db, cardId);
}
