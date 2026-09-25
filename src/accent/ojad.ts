/**
 * OJAD adjudications, entered by hand, with their provenance.
 *
 * These are `analyser = 'manual'` rows: they beat both the primary derivation
 * and the cross-check, outright, in `accent_resolved`. That is the right weight —
 * OJAD is 東京大学's accent dictionary, and it settled words where OpenJTalk and
 * UniDic disagreed, INCLUDING words where both were wrong (正義: OpenJTalk
 * refused it, UniDic read it as the personal name マサヨシ, OJAD says せいぎ 頭高).
 *
 * A HAND-WRITTEN TABLE, ON PURPOSE. A few dozen rows, each one is a citation,
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
 *
 * （2026-09-25 追記）その「カードの 意味 で解く」を、CARD 単位で手で行ったのが
 * `CARD_ADJUDICATIONS`。語の単位には今も何も書かない。
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
  /** When it was looked up. Absent on the first batch, which was 2026-08-20. */
  readonly looked?: string;
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

  // ─── 2026-09-25: 未決 56 件の洗い出し ─────────────────────────────────────
  // 同じ一括検索、見出し完全一致のみ、カードの振り仮名の読みで照合した。
  // 市場 はここに無い: OJAD は しじょう 0 · いちば 1 と答えるが、彼のカードは
  // 振り仮名が しじょう で意味が いちば の語釈 — カード自体が食い違っている。
  { word: "台数", reading: "だいすう", accent: 3, type: "中高", backed: "unidic", looked: "2026-09-25" },
  // UniDic は カチュウ と読んだ。カードの振り仮名は いえじゅう。
  { word: "家中", reading: "いえじゅう", accent: 0, type: "平板", backed: "ours", looked: "2026-09-25" },
  { word: "当たり前", reading: "あたりまえ", accent: 0, type: "平板", backed: "unidic", looked: "2026-09-25" },
  { word: "機械", reading: "きかい", accent: 2, type: "中高", backed: "unidic", looked: "2026-09-25" },
  // UniDic は ハクハツ と読んだ。カードの振り仮名は しらが。
  { word: "白髪", reading: "しらが", accent: 3, type: "尾高", backed: "ours", looked: "2026-09-25" },
  { word: "非婚", reading: "ひこん", accent: 0, type: "平板", backed: "unidic", looked: "2026-09-25" },
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

  // ─── 2026-09-25: 未決 56 件の洗い出し ─────────────────────────────────────
  //
  // OJAD に見出しが無い語。出典は en.wiktionary の {{ja-pron}} で、採ったのは
  // acc_ref が辞書を名指ししているものだけ (DJR 大辞林 · NHK 日本語発音アクセント
  // 辞典 · SMK 新明解 · ZAJ 全国アクセント辞典)。ref の無い acc は Wiktionary の
  // 編集者の記憶であって辞書ではないので、UniDic と一致していても採らない
  // (さりげない · ずるずる · だらけ · 敵軍 · はえ が それで未決に残っている)。
  //
  // 正直に言うと、見たのは Wiktionary が辞書を引用している箇所であって、辞書
  // そのものではない。`source` はそのとおりに書いてある。
  wiktionary("きっと", "きっと", 0, "平板", "neither", "DJR,NHK", "「surely」の義。DJR は「serious」の義に 1 も挙げる"),
  wiktionary("くっ付く", "くっつく", 3, "中高", "unidic", "DJR,NHK"),
  wiktionary("ちょうど", "ちょうど", 0, "平板", "unidic", "DJR"),
  wiktionary("とうとう", "とうとう", 1, "頭高", "unidic", "DJR,SMK8", "到頭 の項"),
  wiktionary("まくる", "まくる", 0, "平板", "unidic", "DJR,NHK,SMK5", "捲る の項"),
  wiktionary("むしろ", "むしろ", 1, "頭高", "unidic", "DJR", "寧ろ の項"),
  wiktionary("容れる", "いれる", 0, "平板", "unidic", "DJR,NHK,SMK5", "入れる の項 — 同じ語の別表記"),
  wiktionary("嗤う", "わらう", 0, "平板", "unidic", "DJR,SMK5,NHK", "笑う の項 — 同じ語の別表記"),
  wiktionary("引き続き", "ひきつづき", 0, "平板", "ours", "DJR", "副詞の項 (動詞連用形の 4 は ref 無し)"),
  wiktionary("手すり", "てすり", 3, "尾高", "ours", "DJR", "手摺 の項"),
  // OpenJTalk は ヨコガラ と読んでいた — 語そのものを取り違えている。
  wiktionary("横柄", "おうへい", 1, "頭高", "unidic", "DJR"),
  wiktionary("正方", "せいほう", 0, "平板", "ours", "DJR4"),
  wiktionary("河口", "かこう", 0, "平板", "ours", "ZAJ"),
  wiktionary("百合", "ゆり", 0, "平板", "ours", "DJR"),
  // OJAD は はいけい 0 と 1 の両方を載せる。三辞書が 0 で一致するので 0。
  wiktionary("背景", "はいけい", 0, "平板", "unidic", "DJR,NHK,SMK5", "OJAD は 0 と 1 を併記"),
  wiktionary("脆弱", "ぜいじゃく", 0, "平板", "unidic", "DJR,SMK7"),
  wiktionary("行きつけ", "いきつけ", 0, "平板", "ours", "DJR,NHK,SMK5", "行き付け の項"),
  wiktionary("言い合い", "いいあい", 0, "平板", "unidic", "DJR,NHK16"),
  wiktionary("飾りつけ", "かざりつけ", 0, "平板", "unidic", "DJR4,NHK16", "飾り付け の項"),
  // 名詞そのものは OJAD に無く、あるのは 専念する 0。アクセントのある名詞は
  // する の前でも核を保つ (握手 1 → あくしゅする 1、手術 1 → しゅじゅつする 1
  // が同じ検索結果にある) ので、する形が 0 なら名詞も 0。推論であって引用では
  // ないので、そう書いておく。
  {
    word: "専念",
    reading: "せんねん",
    accent: 0,
    type: "平板",
    backed: "unidic",
    source: "OJAD 専念する 0/6 から: 有核名詞は する の前で核を保つ (同じ結果に 握手する 1 · 手術する 1)",
    looked: "2026-09-25",
  },
];

function wiktionary(
  word: string,
  reading: string,
  accent: number,
  type: AccentType,
  backed: Adjudication["backed"],
  refs: string,
  remark?: string,
): CitedAdjudication {
  const where = remark === undefined ? "" : `; ${remark}`;
  return {
    word,
    reading,
    accent,
    type,
    backed,
    source: `en.wiktionary {{ja-pron}} acc=${accent}, acc_ref=${refs}${where}`,
    looked: "2026-09-25",
  };
}

/**
 * 決定 22 の同形語を、CARD ごとに裁定したもの。
 *
 * 決定 22 は「文字列に一つのラベルは正しくない」から語の単位では付けない、と
 * 言い、解くにはカードの `意味` が要る、と言う。これはその `意味` を人が読んで
 * 引いた結果で、語の単位には一切書かない — 別の `まく` のカードが来ても、ここに
 * 無い id には何も起きない。
 *
 * 見つけた経緯が理由でもある: 語の単位で「付けない」はずの六語に、
 * `materialiseAccents` は OpenJTalk のラベルをそのまま書いていた。六枚のうち四枚
 * はカードの語義に対して誤りだった (いか 尾高、どく 頭高、まく 平板、やかん 中高)。
 *
 * だぶだぶ はここに無い: OJAD は だぶだぶ[な] 0 · だぶだぶ 1 で、カードの
 * 「loose (of clothing); baggy」はどちらの品詞でも読める。
 */
export interface CardAdjudication {
  readonly cardId: string;
  readonly word: string;
  readonly reading: string;
  /** カードの `意味` の、どの語義で裁定したか。 */
  readonly sense: string;
  readonly accent: number;
  readonly type: AccentType;
  readonly source: string;
  readonly looked: string;
}

export const CARD_ADJUDICATIONS: readonly CardAdjudication[] = [
  { cardId: "tEVIMxIM", word: "いか", reading: "いか", sense: "cuttlefish; squid", accent: 0, type: "平板", source: "OJAD イカ 0 (以下 は 1)", looked: "2026-09-25" },
  { cardId: "iYFegtzP", word: "どく", reading: "どく", sense: "to step aside (退く)", accent: 0, type: "平板", source: "OJAD 退く どく 0 (毒 は 2)", looked: "2026-09-25" },
  { cardId: "lbCBdLzs", word: "まく", reading: "まく", sense: "to sow; to scatter (蒔く・撒く)", accent: 1, type: "頭高", source: "OJAD 蒔く 1 · 撒く 1 (巻く 0 · 膜 2 · 幕 2)", looked: "2026-09-25" },
  { cardId: "rqNT771y", word: "やかん", reading: "やかん", sense: "kettle (薬缶)", accent: 0, type: "平板", source: "OJAD 薬缶 0 (夜間 は 1)", looked: "2026-09-25" },
  { cardId: "M8VFdqGc", word: "弾く", reading: "ひく", sense: "to play (an instrument); 振り仮名 ひく", accent: 0, type: "平板", source: "OJAD 弾く ひく 0 (はじく は 2)", looked: "2026-09-25" },
];

/** `materialiseAccents` の `cardOverrides` に渡す形。 */
export function cardAccentOverrides(): ReadonlyMap<
  string,
  { readonly type: AccentType; readonly accentType: number }
> {
  return new Map(CARD_ADJUDICATIONS.map((row) => [row.cardId, { type: row.type, accentType: row.accent }]));
}

/** Apply every adjudication as a manual override. Idempotent. */
export function applyOjadAdjudications(db: Db): { readonly applied: number } {
  for (const row of OJAD_ADJUDICATIONS) {
    setManualAccent(db, row.word, {
      type: row.type,
      accentType: row.accent,
      note: `OJAD ${row.looked ?? "2026-08-20"}, ${row.reading}; backed ${row.backed}`,
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
