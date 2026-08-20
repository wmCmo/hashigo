# `src/accent` — 高低アクセント derivation, and `<<型>>`

`<<型>>` shows 平板 / 頭高 / 中高 / 尾高 beside the audio. It is **Zach's idea**,
and it turned out to be the error-detection mechanism for the whole pitch-accent
pipeline: **a wrong label is visible where a wrong contour is silently absorbed.**
He can hear that 橋 sounds slightly off; he can *see* that it says 平板 when he
expects 尾高. That is the only cheap check on 3,850 derivations.

## The pipeline, and why it crosses two languages

```bash
npx vite-node src/accent/cli.ts -- words --db build/hashigo.db --out build/head-words.txt
.venv-accent/Scripts/python tools/accent_derive.py \
    --words build/head-words.txt --out build/accents.jsonl
npx vite-node src/accent/cli.ts -- load  --db build/hashigo.db --in build/accents.jsonl
npx vite-node src/accent/cli.ts -- write --db build/hashigo.db --dry-run
```

OpenJTalk exists here only as a Python wheel — `pyopenjtalk-plus` 0.4.1.post9
installs prebuilt; upstream `pyopenjtalk` wants cmake and fails on this machine.
So **Python owns the analyser and nothing else.** TypeScript owns the text
transform, the schema and its CHECK constraints.

That boundary is a bug fix, not tidiness. An earlier version read values straight
from the database and mis-read his own vocabulary, because two things in an
authored value are invisible:

| authored | analyser heard | should be |
|---|---|---|
| `[[参考\|UQB66cP2]]にする` | …ユーキュービーロクジューロクシーピーニ… | 参考にする |
| `準‎備` (U+200E inside) | ジュン + ソナエ | ジュンビ |
| `面‎倒` | メン + タオセ | メンドー |

Those are wrong **readings**, not mora-count wobbles, and 3,016 of those marks
sit on 2,504 cards. `accentKey()` in [`key.ts`](key.ts) is the one definition of
the fix — and the same lesson as the audio binding in `src/generate`: **the
generator's input is the rendered text, never the stored value.**

Placeholders are **normalised, not stripped** — `～` marks an accent-phrase
boundary better than the analyser's own guess.

## What it refuses, and why that is the feature

Measured over 3,850 distinct normalised head-word keys (単語 + 言葉):

| | keys | |
|---|--:|---|
| labelled | 3,816 | 平板 2,073 · 中高 910 · 頭高 778 · 尾高 55 |
| guarded | 34 | the rule refused; `type` is NULL |

A guarded word writes **nothing** into `<<型>>`. Writing 不明 or `''` would look
exactly like "not derived yet" on screen, and the whole value of the label is
that it is visibly wrong when the pipeline is wrong.

`accentFor` returns a guarded row rather than null, because **"the rule refused"
and "nobody has looked" are different states** — collapsing them is the
miss-as-silence defect again.

## Two numbers that drive decisions

* **平板 is 54.3%**, the majority pattern. The notation's most important job is to
  *not* add a downstep, so that is what any TTS work should test first.
* **尾高 is 1.4% — 55 words.** This is the number Zach's *"no particle in the
  audio"* decision rests on: the 平板/尾高 distinction affects 55 cards, not
  thousands, and `<<型>>` carries them. The naive `if accent > 0` rule would have
  drilled 2,065 phantom 尾高.

Both are pinned by `test/accent.test.ts` as ratios, so an analyser upgrade that
moved either by an order of magnitude would fail rather than pass quietly.

## Overrides never live in `card_field_values`

That table is authored text, verbatim, and re-running the materialiser must not
be able to destroy a human correction. So a correction is an
`analyser = 'manual'` row in `accents`, which `accent_resolved` prefers outright,
and the analyser's answer stays beside it to audit. `materialiseAccents` writes
only the resolved answer into the render cache, and is idempotent.
