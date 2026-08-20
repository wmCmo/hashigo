# OJAD adjudication, 2026-08-20

The 90-word queue from `accent_disagreements` (9 words the probe rule refused, 81
where OpenJTalk and UniDic disagree), taken to **OJAD** — the Online Japanese
Accent Dictionary, 東京大学 峯松研究室 / 齋藤研究室.

**Method, and why it is not a scraper.** OJAD's own search box says
*「カンマ，スペースで区切ると複数の単語を同時に検索できます」* — batch lookup is a
feature of their interface. Three page loads were used, driven through the
browser the way a person would, with the words in the URL their own UI generates.
Their terms permit educational and research use and ask people to refrain from
bulk automated use; this is publicly funded university infrastructure and Zach's
instruction was explicit that it is used through the UI, not crawled.

**How the accent is read off the page.** Each mora is a `<span>`; `accent_top`
marks the nucleus, `accent_plain` marks high-continuing, unmarked is low. No
`accent_top` anywhere means 平板 (0).

## Three traps in the results, all of which would have produced wrong labels

1. **OJAD PREFIX-MATCHES.** Searching `低め` returns 低下, 低気圧, 低カロリー,
   低血圧 — and not 低め, which it does not have. 86 of the 99 rows in the second
   batch were this kind of noise. Attributing 低気圧's accent to 低め would be a
   silent, confident error, so only **exact headword matches** are attributed
   here.
2. **な-ADJECTIVES INCLUDE THE な IN THE MORA COUNT.** OJAD shows 地味 as じみな,
   accent 2 of 3 morae, which classifies as 中高. The bare noun じみ is 2 morae
   with accent 2, which is **尾高** — a different label for the same word. Only
   the count changes, not the nucleus, so the fix is to strip the trailing な and
   re-derive the type. Words affected here: 地味 (中高 -> 尾高). 丈夫, 大まか and
   厳か are unaffected because their nucleus is 0 or interior.
3. **KANA-ONLY HEADWORDS ARE GENUINELY AMBIGUOUS, not wrong.** `まく` returns
   FIVE entries with three different accents — 巻く(0), 蒔く(1), 撒く(1), 膜(2),
   幕(2). So for these the OpenJTalk/UniDic "disagreement" is not an error in
   either analyser; both are guessing which lemma was meant, and OJAD confirms
   several are valid. **These cannot be settled from the string alone** and must
   not be given a single label. The card's 意味 field is the only thing that
   disambiguates them.

## Settled — unambiguous exact matches

`accent` is the nucleus position, 1-based; 0 is 平板. "agrees with" says which of
the two analysers OJAD backed, which is the interesting column.

| word | OJAD reading | accent | type | agrees with |
|---|---|--:|---|---|
| 光 | ひかり | 3 | 尾高 | UniDic (ours refused) |
| 正義 | せいぎ | 1 | 頭高 | **neither** — UniDic read it as the name マサヨシ |
| 見物 | けんぶつ | 0 | 平板 | UniDic (ours refused) |
| おだてる | おだてる | 0 | 平板 | UniDic (ours refused) |
| 潰れる | つぶれる | 0 | 平板 | UniDic (ours refused) |
| 点ける | つける | 2 | 中高 | UniDic (ours refused) |
| 叱る (しかる) | しかる | 0 | 平板 | ours |
| 額 (ひたい) | ひたい | 0 | 平板 | UniDic |
| ぶどう | ぶどう | 0 | 平板 | UniDic |
| ぺらぺら | ぺらぺら | 0 | 平板 | ours |
| 側 | そば | 1 | 頭高 | ours |
| ブリ (ぶり) | ぶり | 1 | 頭高 | ours |
| 薔薇 / バラ (ばら) | ばら | 0 | 平板 | ours |
| 剥く / 向く (むく) | むく | 0 | 平板 | — both entries agree |
| 一様 | いちよう | 0 | 平板 | UniDic |
| 人前 | ひとまえ | 0 | 平板 | UniDic |
| 全員 | ぜんいん | 0 | 平板 | UniDic |
| 共存 | きょうそん | 0 | 平板 | UniDic |
| 丈夫 | じょうぶ | 0 | 平板 | UniDic |
| コツ | こつ | 0 | 平板 | — |
| オウム | おうむ | 0 | 平板 | — |
| もみあげ | もみあげ | 0 | 平板 | — |
| 咲く | さく | 0 | 平板 | UniDic |
| 汚す | よごす | 0 | 平板 | — |
| 蒸す | むす | 1 | 頭高 | — |
| 混じる | まじる | 2 | 中高 | — |
| 漬ける | つける | 0 | 平板 | — |
| 強いる | しいる | 2 | 中高 | — |
| 存じる | ぞんじる | 3 | 中高 | — |
| 大まか | おおまか | 0 | 平板 | UniDic |
| 厳か | おごそか | 2 | 中高 | UniDic |
| 地味 | じみ | 2 | 尾高 | UniDic (after the な correction) |
| 布 | ぬの | 0 | 平板 | — |

**33 words settled.**

## Ambiguous — a single label would be wrong

| word | OJAD entries | why it cannot be settled here |
|---|---|---|
| まく | 巻く 0 · 蒔く 1 · 撒く 1 · 膜 2 · 幕 2 | three different accents |
| どく | 退く 0 · 毒 2 | verb vs noun |
| いか | イカ 0 · 以下 1 | |
| やかん | 薬缶 0 · 夜間 1 | |
| 弾く | ひく 0 · はじく 2 | two readings of one spelling |
| だぶだぶ | だぶだぶ[な] 0 · だぶだぶ 1 | adjective vs adverb |
| 共存 | きょうそん 0 · きょうぞん 0 | both 平板, so SETTLED above |

**6 genuinely ambiguous** (共存 resolves because both readings share an accent).

## Not in OJAD at all

さあ · なおざり · 嗤う · 低め · 高め · 台数 · 家中 · 容れる · 専念 · 市場 ·
引き続き · 当たり前 · 手すり · 敵軍 · 根本 · 極まる · 横柄 · 機械 · 正方 · 河口 ·
白髪 · 百合 · 空前 · 背景 · 脆弱 · 航行 · 行きつけ · 裏面 · 言い合い · 転嫁 ·
近々 · 非婚 · 飾りつけ · きっと · くっ付く · さりげない · ずるずる · だらけ ·
ちょうど · とうとう · はえ · まくる · まみれ · むしろ · もやもや · カンカン ·
ニコニコ · バタバタ · バラン · ベタベタ · 一足 · 家中 …

OJAD holds ~9,000 nouns and ~3,500 用言, which does not reach his 上級 vocabulary
or his onomatopoeia. **~51 words are still unadjudicated** and stay `guarded` or
keep the primary derivation — which is the honest state, not a gap to paper over.

## The pattern worth acting on

Of the 15 settled words where OJAD backed one analyser against the other, it
backed **UniDic 11 times and OpenJTalk 4**, and the UniDic wins cluster hard:
一様, 人前, 全員, 共存, 丈夫, 大まか, 厳か, 地味, 額, ぶどう, 咲く — almost all
**平板 where our probe rule produced 中高 or 頭高**.

**INFERRED, not yet measured:** the probe rule over-produces a nucleus on
Sino-Japanese compounds and な-adjectives. That is a hypothesis about a
systematic bias, on 15 adjudicated words, and it should be tested against a
larger OJAD sample before anything in `tools/accent.py` changes. It is
NOT a licence to shift every compound to 平板.

What it does justify immediately: **平板 is the safe default when the rule is
uncertain**, which is also what the distribution says (54.3% 平板) and what the
notation's most important job is (do not add a downstep).
