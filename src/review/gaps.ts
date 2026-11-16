import { generationIdentity, lookupGeneration } from "../blobs/generation.js";
import { resolveAudioHash } from "../cards/audio.js";
import { resolveDescriptorText } from "../generate/store.js";
import type { SqliteHandle } from "../db/browser.js";
import { memoryDocument, renderSides } from "../render/index.js";
import type { BlobKind } from "../schema/index.js";
import { prepareCard } from "./mount.js";
import { ACCENT_FIELD_TYPE } from "./mode.js";
import { yomiOf } from "../fields/yomi.js";
import { accentOfLabel, isKana } from "../accent/speech.js";

export interface CardGap {
  readonly kind: BlobKind;
  readonly text: string;
  readonly lang: string | null;
  readonly voice: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly pronounce?: Pronunciation;
}

export interface Pronunciation {
  readonly reading: string;
  readonly accent: number;
}

export function wordPronunciation(
  db: SqliteHandle,
  cardId: string,
  text: string,
): { readonly waiting: true } | { readonly waiting: false; readonly pronounce?: Pronunciation } | null {
  const card = db
    .prepare(
      `SELECT c.name AS name,
              (SELECT v.value FROM card_field_values v
                 JOIN template_fields f ON f.template_id = c.template_id AND f.id = v.field_id
                WHERE v.card_id = c.id AND f.type = ? LIMIT 1) AS label,
              EXISTS (SELECT 1 FROM template_fields f WHERE f.template_id = c.template_id AND f.type = ?) AS drilled
         FROM cards c WHERE c.id = ?`,
    )
    .get(ACCENT_FIELD_TYPE, ACCENT_FIELD_TYPE, cardId) as
    | { name: string; label: string | null; drilled: number }
    | undefined;
  if (card === undefined || Number(card.drilled) !== 1) return null;
  const name = card.name.trim();
  const yomi = yomiOf(db, cardId);
  const spoken = text.trim();
  if (spoken !== name && spoken !== yomi) return null;
  const reading = yomi ?? (isKana(name) ? name : null);
  if (reading === null) return { waiting: true };
  const accent = accentOfLabel(card.label ?? "", reading);
  return accent === null ? { waiting: false } : { waiting: false, pronounce: { reading, accent } };
}

export const FILLABLE_KINDS: ReadonlySet<string> = new Set(["ai", "translate", "speech"]);

export function cardGaps(
  db: SqliteHandle,
  cardId: string,
  kinds: ReadonlySet<string> = FILLABLE_KINDS,
): CardGap[] {
  const prepared = prepareCard({ db, cardId, direction: "forward" });
  if (prepared === null) return [];
  const out = renderSides(prepared.sides, { document: memoryDocument() });
  const seen = new Set<string>();
  const gaps: CardGap[] = [];
  for (const generation of out.generations) {
    const request = generation.request;
    if (request === null || !kinds.has(request.kind)) continue;
    if (String(request.text).trim() === "") continue;
    const identity = generationIdentity({
      kind: request.kind,
      text: request.text,
      voice: request.voice,
      lang: request.lang,
      options: request.options,
    });
    const key = JSON.stringify(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    const present =
      request.kind === "speech"
        ? resolveAudioHash(db, cardId, { origin: "generator", request }) !== null
        : lookupGeneration(db, identity) !== null && resolveDescriptorText(db, request) !== null;
    if (present) continue;
    const word = request.kind === "speech" ? wordPronunciation(db, cardId, String(request.text)) : null;
    if (word?.waiting === true) continue;
    gaps.push({
      kind: request.kind,
      text: request.text,
      lang: request.lang,
      voice: request.voice,
      options: request.options,
      ...(word?.waiting === false && word.pronounce !== undefined ? { pronounce: word.pronounce } : {}),
    });
  }
  return gaps;
}
