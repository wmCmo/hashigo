/**
 * Which exercise a card runs — decision 29, and the switch the whole review
 * screen hangs off.
 *
 *     const mode = reviewModeFor(loaded);       // "produce" | "identify"
 *
 * Until 2026-08-23 there was only one exercise and the rule was absolute: audio
 * fires on the cloze reveal, never on side entry. That is still exactly true of
 * the **692** cards where `Reading` is true, and it is wrong about the **3,177**
 * where it is not, which run the drill the other way round:
 *
 *     produce    Reading = true      692 単語   see the kanji, recall the reading
 *                                              and the accent, SAY IT, then
 *                                              reveal and hear it to compare.
 *                                              Audio on REVEAL. `型` behind a cloze.
 *
 *     identify   otherwise         3,177 cards  hear the clip, name the kanji.
 *                                              (2,785 単語 + 392 言葉)
 *                                              Audio on ENTRY. `型` plain.
 *
 * *"my listening skill is far worse than my reading skill … that's why most of the
 * cards are like that."* So `identify` is the majority and `boolean-default` is
 * `false`: 1,882 of the 単語 cards have no `Reading` row at all.
 *
 * ─── `Reading` IS A STATE HE MOVES CARDS THROUGH ─────────────────────────────
 *
 * Not a property of the word — a position in his own learning, and the reason the
 * screen needs a way to flip it mid-review:
 *
 * > i didn't know that 尾高 was a thing, so from now on, if `Reading` is false,
 * > the audio would play on the first side when enter the card, i would see that
 * > it's 尾高, and i'll be like, damn, i didn't know this, ive been pronounced it
 * > has 平板 all along, and then i'll just go ahead and edit the card to
 * > `Reading` -> true
 *
 * That is why `型` must be PLAIN in identify mode. Gating it there does not make
 * the exercise harder, it removes the audit — and the audit is what the entire
 * accent pipeline was built to feed. `readingFieldId` below is what a toggle
 * writes to.
 *
 * ─── THE TWO THINGS THAT MAKE THIS MORE THAN ONE `if` ────────────────────────
 *
 * **1. `漢字` DECLARES A FIELD NAMED `Reading` AND IT IS NOT A BOOLEAN.** It is
 * `plain`, holding the actual reading — コウ on 36 cards, ショウ on 33 — over
 * 1,662 cards. A rule that asked "is this card's `Reading` truthy" would call
 * every one of them `produce` on the strength of a name collision. So the type is
 * checked, and that check is load-bearing rather than defensive.
 *
 * **2. `identify` IS NOT "EVERYTHING THAT IS NOT `produce`".** Two templates run
 * the pitch-accent drill and they are the two carrying an `accent`-typed field:
 * 単語 and 言葉. Everything else must keep mode-1 behaviour, and this is not
 * tidiness — it is the same defect autoplay was, measured:
 *
 *     敬語        21 cards   side 1 is `<<言葉>>` then `<speech>`: the word is
 *                            VISIBLE and the clip is beside it. Read it aloud,
 *                            THEN hear it. Autoplay hands him the pronunciation.
 *     New Vocab   1,203      side 1 is `<<Vocab>>` then `<<Pronunciation>>`.
 *                            Same shape, sixty times the cards.
 *     基本情報      471      `Audio`, and no head word to name.
 *
 * Neither declares `Reading`, so "declares no `Reading` field" cannot be the
 * identify rule — 言葉 declares none either and is identify on all 392 of its
 * cards. The accent field is what actually separates them, and it separates them
 * for a reason rather than by coincidence: `型` exists on exactly the templates
 * where naming a contour is the exercise (decisions 20, 26, 27).
 *
 * **The default is therefore `produce`, which is the silent one.** A template
 * Zach adds tomorrow does not start autoplaying because this file had not heard
 * of it.
 *
 * ─── WHY IT IS NOT PER CARD-SIDE, AND WHY THE PROMPT IS ─────────────────────
 *
 * The MODE is a property of the card. Whether a given side asks its question on
 * entry is a property of the side, and `promptsOnEntry` is separate for a reason
 * measured over the real templates: an identify card has a sentence side too.
 *
 *     単語 identify, side 2   2 clozes, 1 clip   the word is hidden → PROMPT
 *     単語 identify, side 3   0 clozes, 1 clip   例文 is visible    → no prompt
 *     言葉 identify, side 1   1 cloze,  1 clip   the word is hidden → PROMPT
 *     言葉 identify, side 2   0 clozes, 1 clip   the sentence shows → no prompt
 *
 * So the condition is **something on this side is masked**. Where nothing is
 * hidden the clip would give away a thing he has not produced — which is 敬語's
 * defect again, arriving one level down. `reveal()` still covers those sides,
 * through the show-answer control that has to exist anyway.
 */

import type { LoadedCard } from "../cards/index.js";
import type { RenderElement } from "../render/dom.js";
import type { ShadowingSide } from "../render/reveal.js";

/** The two exercises. Decision 29. */
export type ReviewMode =
  /** Recall the reading and the accent, then reveal and compare. Audio on reveal. */
  | "produce"
  /** Hear the clip and name the word. Audio on entry, `型` plain. */
  | "identify";

/** The field name Mochi authored the switch under, on 単語. */
export const READING_FIELD = "Reading";

/**
 * The field TYPE that marks a template as running the pitch-accent drill.
 * `scripts/accent-field-apply.ts` writes exactly one such field per template,
 * and only 単語 and 言葉 have one.
 */
export const ACCENT_FIELD_TYPE = "accent";

export interface CardMode {
  readonly mode: ReviewMode;
  /**
   * True when the card's own template declares an `accent`-typed field — i.e.
   * this card is part of the pitch-accent drill at all. False for 漢字, 敬語,
   * New Vocab and everything else, all of which take `produce` semantics.
   */
  readonly accentDrill: boolean;
  /**
   * `template_fields.id` of a declared BOOLEAN field named `Reading`, or null.
   * Null means the switch cannot be flipped on this card: 言葉 has no such field
   * and its 392 cards are permanently `identify`, and 漢字's `Reading` is a plain
   * text field that this deliberately does not return.
   *
   * A mid-review toggle writes `card_field_values` at (card, this id).
   */
  readonly readingFieldId: string | null;
  /** Whether that field is truthy on this card right now. */
  readonly reading: boolean;
}

/** `card_field_values.value` is TEXT; the importer writes `"true"` / `"false"`. */
function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const text = value.trim();
  return text !== "" && text !== "false";
}

/**
 * Everything the screen needs to know about which exercise this card runs, and
 * about flipping it.
 */
export function cardMode(loaded: LoadedCard): CardMode {
  const fields = loaded.template?.fields ?? [];
  const accentDrill = fields.some((field) => field.type === ACCENT_FIELD_TYPE);
  // The type check is the point — see note 1 in this file's header. 漢字 holds
  // 1,662 cards under a plain field of the same name.
  const reading = fields.find(
    (field) => field.name.trim() === READING_FIELD && field.type === "boolean",
  );
  const readingFieldId = reading === undefined ? null : reading.id;
  const isReading = readingFieldId === null ? false : truthy(loaded.values.get(readingFieldId));
  return {
    // `produce` is the fail-safe: it is the mode that plays nothing on entry, so
    // an unrecognised template stays silent rather than starting to autoplay.
    mode: accentDrill && !isReading ? "identify" : "produce",
    accentDrill,
    readingFieldId,
    reading: isReading,
  };
}

/** `cardMode(loaded).mode`, for the callers that only want the switch. */
export function reviewModeFor(loaded: LoadedCard): ReviewMode {
  return cardMode(loaded).mode;
}

/**
 * Does entering this side ask its question out loud?
 *
 * TWO ways to qualify, and they are independent. A side with audio and neither
 * gets the deliberate gesture it has always had.
 *
 * ─── 1. THE MASKED ARM: `identify` mode, and a cloze on the side ────────────
 *
 * Decision 29. The word is hidden and the clip is the question. Gated on the
 * mode, because on a `produce` card the same shape means the opposite.
 *
 * ─── 2. THE WIDGET ARM, AND IT IS NOT GATED ON THE MODE AT ALL ──────────────
 *
 * **Zach caught this on 2026-08-23 and he was right.** His 数字 template is
 *
 *     << Voice >>
 *     <input value=<<NoComma>>>
 *     ---
 *     << Number >>
 *
 * — hear a number, TYPE it, then see it. The clip is unambiguously the question,
 * and it never played, because arm 1 requires `identify` and `identify` requires
 * the template to declare an `accent` field. **That was a fact about 単語 and 言葉
 * encoded as if it were a rule**, and it is the hardcoding he asked about: not a
 * side index — `promptsOnEntry` has always been per-side — but an assumption that
 * the pitch-accent drill is the only place audio can be a question.
 *
 * What it cost, measured before the fix: the 数字 question side rendered an empty
 * input, no text and no sound. **Ninety cards whose prompt was a blank screen.**
 *
 * A WIDGET is the signal, and it is a better one than "the side shows no text"
 * would be. `<input>` and `<draw>` mean *produce your answer here*, so whatever
 * is sounding beside them is the question by construction — there is nothing on
 * the side that could be the answer, because the answer is the thing he is being
 * asked to make. That is why this arm needs no mode gate and cannot leak.
 *
 * Measured over every template's question side, which is what makes this precise
 * rather than plausible:
 *
 *     template     cards  audio  cloze  widget  shows            arm
 *     単語          3,477      1      2       0  型 + masks        1 (identify only)
 *     漢字          1,662      0      0       0  the kanji         —
 *     New Vocab    1,203      1      0       0  "strife"          — the word is RIGHT THERE
 *     基本情報        471      0      3       0  masked text       —
 *     言葉            392      1      1       0  型 + mask         1
 *     数字             90      1      0       1  NOTHING           2
 *     敬語             21      1      0       0  "会社"            — the word is RIGHT THERE
 *
 * 数字 is the only template on either side of that line, and 敬語 and New Vocab —
 * the two this file has always protected, because they show the head word beside
 * its clip — are untouched: neither has a widget.
 */
export function promptsOnEntry<E extends RenderElement>(
  mode: ReviewMode,
  side: ShadowingSide<E>,
  /**
   * Widget mounts (`<input>`, `<draw>`) on this side. The caller counts them,
   * because `ShadowingSide` deliberately carries only what the reveal loop needs
   * and a widget is not that. Defaults to 0, so a caller that does not know
   * cannot accidentally start playing.
   */
  widgets = 0,
): boolean {
  if (side.audio.length === 0) return false;
  const masked = mode === "identify" && side.trigger === "cloze";
  const producesHere = widgets > 0;
  return masked || producesHere;
}
