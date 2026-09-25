/**
 * OJAD adjudications, entered by hand, with their provenance.
 *
 * These are `analyser = 'manual'` rows: they beat both the primary derivation
 * and the cross-check, outright, in `accent_resolved`. That is the right weight —
 * OJAD is 東京大学's accent dictionary, and it settled words where OpenJTalk and
 * UniDic disagreed, INCLUDING words where both were wrong (正義: OpenJTalk
 * refused it, UniDic read it as the personal name マサヨシ, OJAD says せいぎ 頭高).
 *
 * A HAND-WRITTEN TABLE, ON PURPOSE. 33 rows is small, each one is a citation,
 * and the alternative — a scraper — is the thing Zach explicitly ruled out and
 * OJAD's own terms ask people to refrain from. See
 * notes/accent-ojad-adjudication.md for the method, and for the three traps in
 * their output that would each have produced a confidently wrong label:
 * prefix matching, な-adjectives carrying the な in the mora count, and
 * kana-only headwords being genuinely ambiguous rather than wrong.
 *
 * WHAT IS DELIBERATELY ABSENT: the 6 ambiguous words. `まく` has three different
 * accents across 巻く / 蒔く・撒く / 膜・幕, and giving it one label would drill a
 * wrong contour on two thirds of its senses. They stay unresolved until the
 * card's own 意味 disambiguates them, which is a review-UI question, not this
 * file's.
 */

import type { Db } from "../db/index.js";
import { setManualAccent, type AccentType } from "./store.js";

export interface Adjudication {
  readonly word: string;
  readonly reading: string;
  /** Nucleus position, 1-based. 0 is 平板. */
  readonly accent: number;
  readonly type: AccentType;
  /** Which analyser OJAD backed, for the record. */
  readonly backed: "ours" | "unidic" | "neither" | "n/a";
}

/**
 * Looked up 2026-08-20 through OJAD's own batch search. Exact headword matches
 * only — their search prefix-matches, and 86 of 99 rows in one batch were other
 * words that merely started the same way.
 */
export const OJAD_ADJUDICATIONS: readonly Adjudication[] = [
  // The words the probe rule REFUSED. All six had an answer waiting.
  { word: "光", reading: "ひかり", accent: 3, type: "尾高", backed: "unidic" },
  // Both analysers were wrong here: ours refused, UniDic said マサヨシ.
  { word: "正義", reading: "せいぎ", accent: 1, type: "頭高", backed: "neither" },
  { word: "見物", reading: "けんぶつ", accent: 0, type: "平板", backed: "unidic" },
  { word: "おだてる", reading: "おだてる", accent: 0, type: "平板", backed: "unidic" },
  { word: "潰れる", reading: "つぶれる", accent: 0, type: "平板", backed: "unidic" },
  { word: "点ける", reading: "つける", accent: 2, type: "中高", backed: "unidic" },

  // Disagreements OJAD settled for US.
  { word: "しかる", reading: "しかる", accent: 0, type: "平板", backed: "ours" },
  { word: "ぺらぺら", reading: "ぺらぺら", accent: 0, type: "平板", backed: "ours" },
  { word: "側", reading: "そば", accent: 1, type: "頭高", backed: "ours" },
  { word: "ぶり", reading: "ぶり", accent: 1, type: "頭高", backed: "ours" },
  { word: "ばら", reading: "ばら", accent: 0, type: "平板", backed: "ours" },

  // Disagreements OJAD settled for UNIDIC. Note the cluster: almost all are
  // 平板 where our probe rule produced a nucleus. See the note's last section —
  // that is a hypothesis about a systematic bias, not yet a measurement.
  { word: "ひたい", reading: "ひたい", accent: 0, type: "平板", backed: "unidic" },
  { word: "ぶどう", reading: "ぶどう", accent: 0, type: "平板", backed: "unidic" },
  { word: "一様", reading: "いちよう", accent: 0, type: "平板", backed: "unidic" },
  { word: "人前", reading: "ひとまえ", accent: 0, type: "平板", backed: "unidic" },
  { word: "全員", reading: "ぜんいん", accent: 0, type: "平板", backed: "unidic" },
  { word: "共存", reading: "きょうそん", accent: 0, type: "平板", backed: "unidic" },
  { word: "丈夫", reading: "じょうぶ", accent: 0, type: "平板", backed: "unidic" },
  { word: "咲く", reading: "さく", accent: 0, type: "平板", backed: "unidic" },
  { word: "大まか", reading: "おおまか", accent: 0, type: "平板", backed: "unidic" },
  { word: "厳か", reading: "おごそか", accent: 2, type: "中高", backed: "unidic" },
  // AFTER the な correction: OJAD shows じみな, accent 2 of 3 morae, which reads
  // as 中高. The bare noun じみ is 2 morae with accent 2, which is 尾高. The
  // nucleus did not move; the mora count did.
  { word: "地味", reading: "じみ", accent: 2, type: "尾高", backed: "unidic" },

  // Words neither analyser had settled, where OJAD simply has the answer.
  { word: "むく", reading: "むく", accent: 0, type: "平板", backed: "n/a" },
  { word: "コツ", reading: "こつ", accent: 0, type: "平板", backed: "n/a" },
  { word: "オウム", reading: "おうむ", accent: 0, type: "平板", backed: "n/a" },
  { word: "もみあげ", reading: "もみあげ", accent: 0, type: "平板", backed: "n/a" },
  { word: "汚す", reading: "よごす", accent: 0, type: "平板", backed: "n/a" },
  { word: "蒸す", reading: "むす", accent: 1, type: "頭高", backed: "n/a" },
  { word: "混じる", reading: "まじる", accent: 2, type: "中高", backed: "n/a" },
  { word: "漬ける", reading: "つける", accent: 0, type: "平板", backed: "n/a" },
  { word: "強いる", reading: "しいる", accent: 2, type: "中高", backed: "n/a" },
  { word: "存じる", reading: "ぞんじる", accent: 3, type: "中高", backed: "n/a" },
  { word: "布", reading: "ぬの", accent: 0, type: "平板", backed: "n/a" },
];

/**
 * Words OJAD gives MORE THAN ONE accent for. Recorded so they are visibly
 * unresolved rather than quietly missing, and so nobody "fixes" them by picking
 * one.
 */
export const OJAD_AMBIGUOUS: readonly { readonly word: string; readonly entries: string }[] = [
  { word: "まく", entries: "巻く 0 · 蒔く 1 · 撒く 1 · 膜 2 · 幕 2" },
  { word: "どく", entries: "退く 0 · 毒 2" },
  { word: "いか", entries: "イカ 0 · 以下 1" },
  { word: "やかん", entries: "薬缶 0 · 夜間 1" },
  { word: "弾く", entries: "ひく 0 · はじく 2" },
  { word: "だぶだぶ", entries: "だぶだぶ[な] 0 · だぶだぶ 1" },
];

/**
 * Adjudications from a DICTIONARY, for words OJAD has no entry for — kept apart
 * from `OJAD_ADJUDICATIONS` so that list never claims a source it did not use.
 *
 * OJAD's word search is built from textbook vocabulary, so a word like 航行 simply
 * is not in it. Each row here names what WAS consulted and when, in `source`,
 * and that text lands in `accents.note` beside the value.
 *
 * ─── WHY THESE ARE WORTH DOING, MEASURED 2026-09-25 ─────────────────────────
 *
 * The note on the UniDic rows above called it "a hypothesis about a systematic
 * bias, not yet a measurement". Measured over the disputes OJAD settled: where
 * OUR probe rule produced a nucleus and UniDic said 平板, OJAD backed UniDic
 * **12 times out of 14**; for every other shape of disagreement ours won 8 of 13.
 * 27 of the 57 still-open disputes have that shape. Decision 8 still stands —
 * UniDic never resolves on its own — so each one needs a citation, like this.
 */
export interface CitedAdjudication extends Adjudication {
  readonly source: string;
  readonly looked: string;
}

export const DICTIONARY_ADJUDICATIONS: readonly CitedAdjudication[] = [
  // Zach, 2026-09-25, over the card on his phone: "I thought 航行 was 平板". He was
  // right. OpenJTalk: 頭高 [[4,1]]; UniDic: 平板 [[4,0]]. OJAD: no entry.
  {
    word: "航行",
    reading: "こうこう",
    accent: 0,
    type: "平板",
    backed: "unidic",
    source: "Weblio 発音欄「(東京) こーこー [kòókóó] (平板型 – [0])」; OJAD has no entry",
    looked: "2026-09-25",
  },
];

/** Apply every adjudication as a manual override. Idempotent. */
export function applyOjadAdjudications(db: Db): { readonly applied: number } {
  for (const row of OJAD_ADJUDICATIONS) {
    setManualAccent(db, row.word, {
      type: row.type,
      accentType: row.accent,
      note: `OJAD 2026-08-20, ${row.reading}; backed ${row.backed}`,
    });
  }
  for (const row of DICTIONARY_ADJUDICATIONS) {
    setManualAccent(db, row.word, {
      type: row.type,
      accentType: row.accent,
      note: `${row.source} (${row.looked}), ${row.reading}; backed ${row.backed}`,
    });
  }
  return { applied: OJAD_ADJUDICATIONS.length + DICTIONARY_ADJUDICATIONS.length };
}
