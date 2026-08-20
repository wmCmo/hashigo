/**
 * Which voice a card's speech should use — the fifth pain point, in code.
 *
 * Mochi sets the TTS voice on the TEMPLATE. It applies to every card, there is
 * no per-card override, and unwanted audio is very hard to delete. The
 * consequence was not theoretical: four years of pitch-accent shadowing happened
 * against `ja-JP-NanamiNeural`, a female voice, because changing it was not
 * worth the blast radius. The settled replacement is `ja-JP-Neural2-C`, male,
 * chosen by ear and agreeing with an F0 measurement.
 *
 * RESOLUTION IS THREE-STATE, the same shape as `reverse`:
 *
 *     card.voice ?? (deck.voice, up the parent chain) ?? settings['voice.default']
 *
 * and when all of those are empty, the FIELD's own recorded voice wins. That
 * last fallback is the important one and it is why `voice.default` ships empty:
 * every one of the 10,791 speech blobs is addressed by the voice Mochi recorded,
 * so a global default of `ja-JP-Neural2-C` would miss every lookup at once and
 * re-bill the entire corpus. Overriding is opt-in, per card or per deck.
 *
 * LOOKUP AND GENERATION USE DIFFERENT VOICES, ON PURPOSE. `resolveFieldGeneration`
 * looks up the FIELD's voice first and falls back to any voice (the
 * `other-voice` bucket, 507 slots); `voiceFor` answers what a NEW generation
 * should use. Conflating them would either regenerate everything or never honour
 * an override.
 */

import type { Db } from "../db/index.js";
import { SETTING_KEYS } from "../schema/index.js";

export interface VoiceResolution {
  /** The voice to generate with, or null to leave the field's voice alone. */
  readonly voice: string | null;
  /** Where it came from, so a caller can explain a surprising choice. */
  readonly source: "card" | "deck" | "workspace" | "field";
  /** The deck whose voice won, when `source` is `deck`. */
  readonly deckId?: string;
}

/**
 * The inheritance lives in the `card_voice_resolved` VIEW, not here.
 *
 * It was a hand-rolled tree walk in this file first, which made two definitions
 * of one rule — a SQL one for `reverse` and `target_retention`, and a
 * TypeScript one for voice. `deck_ancestry` already existed. The view returns
 * the winner and names its source; the only hop left in TypeScript is the field
 * fallback, which SQL cannot do because a voice is recorded per FIELD and the
 * view only knows about cards and decks.
 */
const RESOLVED_SQL = "SELECT voice, source FROM card_voice_resolved WHERE card_id = ?";

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The voice for a new generation on this card.
 *
 * `fieldVoice` is what the template recorded, and is returned unchanged when
 * nothing overrides it — so calling this on an untouched database is a no-op
 * rather than a corpus-wide change.
 */
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
    // Nothing overrides it, so the template's own voice stands. NOT
    // null-as-"provider default": that would silently change what 7,093 Nanami
    // clips were made with.
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

/** Which deck in the chain actually supplied the voice, for the explanation. */
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

/**
 * Set or clear a card's voice override. `null` clears it back to inherit.
 *
 * Returns false when the card does not exist, rather than throwing: a voice
 * override is a preference, and a caller sweeping a deck should not have to
 * pre-check every id.
 */
export function setCardVoice(db: Db, cardId: string, voice: string | null): boolean {
  const info = db
    .prepare("UPDATE cards SET voice = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(clean(voice), cardId);
  return info.changes === 1;
}

/** Set or clear a deck's voice override. `null` clears it back to inherit. */
export function setDeckVoice(db: Db, deckId: string, voice: string | null): boolean {
  const info = db
    .prepare("UPDATE decks SET voice = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(clean(voice), deckId);
  return info.changes === 1;
}

/** Set or clear the workspace default. `null` stores `''`, i.e. "the field's". */
export function setDefaultVoice(db: Db, voice: string | null): void {
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
    clean(voice) ?? "",
    SETTING_KEYS.voiceDefault,
  );
}
