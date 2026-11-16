import type { Db } from "../db/index.js";
import { SETTING_KEYS } from "../schema/index.js";

export interface VoiceResolution {
  readonly voice: string | null;
  readonly source: "card" | "deck" | "workspace" | "field";
  readonly deckId?: string;
}

const RESOLVED_SQL = "SELECT voice, source FROM card_voice_resolved WHERE card_id = ?";

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function voiceFor(
  db: Db,
  cardId: string,
  fieldVoice: string | null = null,
): VoiceResolution {
  const row = db.prepare(RESOLVED_SQL).get(cardId) as
    | { voice: string | null; source: VoiceResolution["source"] }
    | undefined;
  const resolved = clean(row?.voice);
  if (row === undefined || resolved === null) {
    return { voice: fieldVoice, source: "field" };
  }
  if (row.source === "deck") {
    const deckId = db.prepare("SELECT deck_id FROM cards WHERE id = ?").pluck().get(cardId) as
      | string
      | undefined;
    return deckId === undefined
      ? { voice: resolved, source: "deck" }
      : { voice: resolved, source: "deck", deckId: nearestDeck(db, deckId) };
  }
  return { voice: resolved, source: row.source };
}

function nearestDeck(db: Db, deckId: string): string {
  const row = db
    .prepare(
      `SELECT a.id FROM deck_ancestry an JOIN decks a ON a.id = an.ancestor_id
        WHERE an.deck_id = ? AND NULLIF(TRIM(a.voice), '') IS NOT NULL
        ORDER BY an.depth LIMIT 1`,
    )
    .pluck()
    .get(deckId) as string | undefined;
  return row ?? deckId;
}

export function setCardVoice(db: Db, cardId: string, voice: string | null): boolean {
  const info = db
    .prepare("UPDATE cards SET voice = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(clean(voice), cardId);
  return info.changes === 1;
}

export function setDeckVoice(db: Db, deckId: string, voice: string | null): boolean {
  const info = db
    .prepare("UPDATE decks SET voice = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(clean(voice), deckId);
  return info.changes === 1;
}

export function setDefaultVoice(db: Db, voice: string | null): void {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
    clean(voice) ?? "",
    SETTING_KEYS.voiceDefault,
  );
}
