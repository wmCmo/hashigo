import type { Db } from "../db/index.js";
import { setManualAccent, type AccentType } from "./store.js";

export interface Adjudication {
  readonly word: string;
  readonly reading: string;
  readonly accent: number;
  readonly type: AccentType;
  readonly backed: "ours" | "unidic" | "neither" | "n/a";
  readonly looked?: string;
}

export const OJAD_ADJUDICATIONS: readonly Adjudication[] = [
  { word: "光", reading: "ひかり", accent: 3, type: "尾高", backed: "unidic" },
  { word: "正義", reading: "せいぎ", accent: 1, type: "頭高", backed: "neither" },
  { word: "見物", reading: "けんぶつ", accent: 0, type: "平板", backed: "unidic" },
  { word: "おだてる", reading: "おだてる", accent: 0, type: "平板", backed: "unidic" },
  { word: "潰れる", reading: "つぶれる", accent: 0, type: "平板", backed: "unidic" },
  { word: "点ける", reading: "つける", accent: 2, type: "中高", backed: "unidic" },

  { word: "しかる", reading: "しかる", accent: 0, type: "平板", backed: "ours" },
  { word: "ぺらぺら", reading: "ぺらぺら", accent: 0, type: "平板", backed: "ours" },
  { word: "側", reading: "そば", accent: 1, type: "頭高", backed: "ours" },
  { word: "ぶり", reading: "ぶり", accent: 1, type: "頭高", backed: "ours" },
  { word: "ばら", reading: "ばら", accent: 0, type: "平板", backed: "ours" },

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
  { word: "地味", reading: "じみ", accent: 2, type: "尾高", backed: "unidic" },

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

  { word: "台数", reading: "だいすう", accent: 3, type: "中高", backed: "unidic", looked: "2026-09-25" },
  { word: "家中", reading: "いえじゅう", accent: 0, type: "平板", backed: "ours", looked: "2026-09-25" },
  { word: "当たり前", reading: "あたりまえ", accent: 0, type: "平板", backed: "unidic", looked: "2026-09-25" },
  { word: "機械", reading: "きかい", accent: 2, type: "中高", backed: "unidic", looked: "2026-09-25" },
  { word: "白髪", reading: "しらが", accent: 3, type: "尾高", backed: "ours", looked: "2026-09-25" },
  { word: "非婚", reading: "ひこん", accent: 0, type: "平板", backed: "unidic", looked: "2026-09-25" },
];

export const OJAD_AMBIGUOUS: readonly { readonly word: string; readonly entries: string }[] = [
  { word: "まく", entries: "巻く 0 · 蒔く 1 · 撒く 1 · 膜 2 · 幕 2" },
  { word: "どく", entries: "退く 0 · 毒 2" },
  { word: "いか", entries: "イカ 0 · 以下 1" },
  { word: "やかん", entries: "薬缶 0 · 夜間 1" },
  { word: "弾く", entries: "ひく 0 · はじく 2" },
  { word: "だぶだぶ", entries: "だぶだぶ[な] 0 · だぶだぶ 1" },
];

export interface CitedAdjudication extends Adjudication {
  readonly source: string;
  readonly looked: string;
}

export const DICTIONARY_ADJUDICATIONS: readonly CitedAdjudication[] = [
  {
    word: "航行",
    reading: "こうこう",
    accent: 0,
    type: "平板",
    backed: "unidic",
    source: "Weblio 発音欄「(東京) こーこー [kòókóó] (平板型 – [0])」; OJAD has no entry",
    looked: "2026-09-25",
  },

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
  wiktionary("横柄", "おうへい", 1, "頭高", "unidic", "DJR"),
  wiktionary("正方", "せいほう", 0, "平板", "ours", "DJR4"),
  wiktionary("河口", "かこう", 0, "平板", "ours", "ZAJ"),
  wiktionary("百合", "ゆり", 0, "平板", "ours", "DJR"),
  wiktionary("背景", "はいけい", 0, "平板", "unidic", "DJR,NHK,SMK5", "OJAD は 0 と 1 を併記"),
  wiktionary("脆弱", "ぜいじゃく", 0, "平板", "unidic", "DJR,SMK7"),
  wiktionary("行きつけ", "いきつけ", 0, "平板", "ours", "DJR,NHK,SMK5", "行き付け の項"),
  wiktionary("言い合い", "いいあい", 0, "平板", "unidic", "DJR,NHK16"),
  wiktionary("飾りつけ", "かざりつけ", 0, "平板", "unidic", "DJR4,NHK16", "飾り付け の項"),
  {
    word: "専念",
    reading: "せんねん",
    accent: 0,
    type: "平板",
    backed: "unidic",
    source: "OJAD 専念する 0/6 から: 有核名詞は する の前で核を保つ (同じ結果に 握手する 1 · 手術する 1)",
    looked: "2026-09-25",
  },

  jpdb("さあ", "さあ", 1, "頭高", "unidic", "OpenJTalk refused"),
  jpdb("なおざり", "なおざり", 0, "平板", "unidic", "OpenJTalk refused"),
  jpdb("さりげない", "さりげない", 4, "中高", "unidic"),
  jpdb("だらけ", "だらけ", 1, "頭高", "unidic", "suffix; citation form"),
  jpdb("まみれ", "まみれ", 1, "頭高", "unidic", "suffix; citation form"),
  jpdb("ニコニコ", "ニコニコ", 1, "頭高", "unidic"),
  jpdb("バラン", "バラン", 1, "頭高", "unidic", "every jpdb sense is 1"),
  jpdb("敵軍", "てきぐん", 0, "平板", "unidic"),
  jpdb("空前", "くうぜん", 0, "平板", "unidic"),
  jpdb("転嫁", "てんか", 1, "頭高", "unidic"),
  jpdb("高め", "たかめ", 0, "平板", "unidic"),
  jpdb("ベタベタ", "ベタベタ", 1, "頭高", "neither", "jpdb lists 1, 0 and 2; the first is taken, and none is 中高"),
  jpdb("カンカン", "カンカン", 3, "中高", "neither", "the can-can; the onomatopoeia is 1 or 0"),
  jpdb("一足", "いっそく", 4, "尾高", "unidic", "a pair of shoes; ひとあし is 2"),
  jpdb("裏面", "りめん", 1, "頭高", "unidic", "うらめん is 0"),
];

function jpdb(
  word: string,
  reading: string,
  accent: number,
  type: AccentType,
  backed: Adjudication["backed"],
  remark?: string,
): CitedAdjudication {
  const where = remark === undefined ? "" : `; ${remark}`;
  return { word, reading, accent, type, backed, source: `jpdb.io ${reading} ${accent}${where}`, looked: "2026-10-25" };
}

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

export interface CardAdjudication {
  readonly cardId: string;
  readonly word: string;
  readonly reading: string;
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

export function cardAccentOverrides(): ReadonlyMap<
  string,
  { readonly type: AccentType; readonly accentType: number }
> {
  return new Map(CARD_ADJUDICATIONS.map((row) => [row.cardId, { type: row.type, accentType: row.accent }]));
}

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
