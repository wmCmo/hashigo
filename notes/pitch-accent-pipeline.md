# Pitch-accent TTS pipeline

Investigation, 2026-08-20. Five questions, in the order they were asked.

Every figure below is labelled **MEASURED** (I ran it, on this machine, and the command
is quoted), **INFERRED** (I reasoned from something measured), or **UNVERIFIED** (I could
not confirm it and neither could the sources). Read the labels. There are places where
this document's answer and the SPEC's answer differ, and each of those is called out.

---

## Recommendation

**The hard part is done, and it is not the provider.** The local accent derivation now
works: a probe particle `が` appended to the bare word turns OpenJTalk's mora-count output
into a real accent type, and it reproduces Google's own documented examples exactly —
箸 → `^は!し`, 橋 → `^はし!`, 端 → `^はし`, derived here from scratch with no knowledge of
those examples (§3). That cross-check is the strongest single result in this document,
because it validates the notation semantics and the derivation rule against each other
from two independent directions. **Both providers can specify the nucleus.** Azure's
apostrophe is defined by Microsoft, in Microsoft's own words, as *"Accent position"* —
not stress; the "Primary stress" gloss everyone reads is a global IPA legend that was
never localised for ja-JP (§1). Google's `^`/`!` is documented on a live page with the
端/箸/橋 minimal pair, and — the finding that changes the plan — is reachable through
**SSML `<phoneme alphabet="yomigana">` on a Neural2 or WaveNet voice**, which is better
documented and better attested than the `custom_pronunciations` field the brief asked
about (§2). So: **make an Azure account and run the probe in §6 against both providers.**
Azure first, because a pass there keeps 7,403 existing Nanami clips as an asset instead of
a liability and costs nothing on the F0 free tier. The single most important thing to
listen for is *not* 箸 vs 橋 — it is whether **平板 stays flat**, because 平板 is 55.2% of
his vocabulary (MEASURED, §3), and a notation that helpfully adds a downstep everywhere is
worse than no notation at all. Ship `<<型>>` (§4) regardless of which provider wins: a
wrong *label* is visible in a way a wrong *contour* is not, which makes it the cheapest
error-detector available for the other four questions.

---

## 1. Can Azure specify a Japanese accent nucleus?

### Answer: YES at the documentation level. RESOLVED, where it was open in SPEC draft 7.

SPEC's "TTS is reopened" section says the apostrophe "is documented as **stress**, inherited
from SAPI" and that *"the words 'accent', 'pitch' and 'downstep' appear nowhere in the ja-JP
material."* Both halves of that are correct about the *current Azure* docs and both are
answered by a page the current docs link to but never quote.

**The decisive source** (primary, fetched): Microsoft's own archived
*"Japanese Phonemes (Microsoft Speech Platform)"* reference —
<https://learn.microsoft.com/en-us/previous-versions/office/developer/speech-technologies/jj127901(v=msdn.10)>
(Microsoft-published, `ms.date` 2012-05-09). Its **SAPI Supported Japanese Phonemes
(Katakana)** table opens with a symbol legend whose `Remarks` column reads, verbatim:

| Symbol | Remarks (verbatim, Microsoft) |
|---|---|
| `'` (U+0027) | "Accent position" |
| `+` (U+002B) | "Accent boundary" |
| `\|` (U+007C) | "Phrase boundary" |
| `_` (U+005F) | "One mora pause" |

The word "stress" does not appear on that page. For Japanese, "accent position" is
アクセント核 — Japanese has no stress accent, so there is nothing else it can denote.

**Why the current docs mislabel it** (primary, read from the doc source repo
`MicrosoftDocs/azure-ai-docs`, so none of this is a rendering artefact):

* `speech-ssml-phonetic-sets.md` puts its "Primary stress / Secondary stress" legend for
  `ˈ`/`ˌ` in a **single global table at the top of the page**, before any locale section,
  covering ~40 locales. It is not a ja-JP statement. The ja-JP content arrives ~60 lines
  later via `[!INCLUDE]`.
* `includes/phonetic-sets/text-to-speech/ja-jp.md` is 3,310 bytes of kana/viseme tables
  plus the three-row examples table, and **contains no legend for `'`, `+` or `?` at all**.
  The apostrophe in `ゴ'ウセ` therefore has no ja-JP-local definition; readers inherit the
  English-stress gloss purely by page adjacency.
* `speech-synthesis-markup-pronunciation.md` states the placement rule verbatim: *"For
  `sapi`, if you want to stress one syllable, you need to place the stress symbol **after**
  this syllable"*. IPA stress goes *before* the syllable; the Japanese accent-nucleus
  convention marks the *last high mora*, with the drop following. Microsoft documenting
  `sapi` as after-the-syllable and IPA as before it is itself a Japanese-accent tell.

**A contrast test that kills the obvious objection.** "Microsoft just doesn't document
tone" is false: `includes/phonetic-sets/text-to-speech/zh-cn.md` has an explicit *"Pinyin
Tone for zh-CN"* section and encodes tone as numerals in every example
(`<phoneme alphabet="sapi" ph="ni 3 hao 3">`). The ja-JP omission is a documentation gap,
not evidence of absent capability.

**Azure has an internal ja-JP accent model.** Microsoft's Neural TTS launch post
(<https://techcommunity.microsoft.com/blog/azure-ai-services-blog/azure-neural-tts-upgraded-with-hifinet-achieves-better-audio-fidelity/1505911>)
states that *"about 60% of production system's problems in Japanese synthesis are related
to intonation and accents"* and that *"The accent model **predicts** accent phrase
boundaries and accent type information"*. That is an internal component, not a user
parameter — **but** it means the ja-JP pipeline carries an explicit accent-type
representation internally, which is exactly what the `'` notation would have to address.
That makes the notation plausible rather than vestigial. **INFERRED.**

### Corroboration, and its weaknesses

* **A practitioner test with rendered audio on a neural voice** — note.com
  `n302f18c043b3`, 発音調整 section. Renders 午後4時ごろ three ways on
  `ja-JP-NanamiNeural`: `ph="ゴゴ ヨジ ゴロ"` (平板調), `ph="ゴ'ゴ ヨジ ゴロ"` (頭高型),
  `ph="ゴゴ ヨ'ジ ゴロ"` (中高型), and reports the accent landing in three different
  places. He also states the rule that a trailing `+` reads the word 平板型.
  **Weakness, stated plainly:** the author says he worked with ChatGPT's help and near-zero
  programming background, so his *rule statement* may be LLM-derived and circular. Two
  things survive that: he published rendered samples, and his `+`-means-heiban claim
  independently explains Microsoft's own `最適化 → サィテキカ+` row — 最適化 *is* a heiban
  word, and a word-final `+` is incoherent as "secondary stress" and exactly right as
  "accent boundary". That convergence is **INFERRED**.
* **Amazon Polly, as a comparison point.** AWS ships a purpose-built notation and
  documents it in one line: `x-amazon-pron-kana`, katakana that "can encode pitch accent",
  with the example `ph="ヒロカ'ズ"` — *visually identical convention to Azure's* `ゴ'ウセ`
  (<https://docs.aws.amazon.com/polly/latest/dg/ph-table-japanese.html>). A Classmethod
  writeup confirms it audibly works and places the apostrophe *"right before the mora where
  the pitch drops"* — i.e. AWS describes placement from the opposite side to Microsoft's
  rule. Same phenomenon, two descriptions, off by one. **Do not port Polly strings
  verbatim; verify placement by ear.**
* **A production app that hit the real ja-JP limits** — TrainLCD/MobileApp, Azure Speech,
  Japanese station announcements. PR #6243 (merged 2026-06-16) adopts
  `<phoneme alphabet="ipa">` gated on an accent nucleus `ˈ`, with the problem statement
  *"駅名など固有名詞のピッチアクセントが Azure TTS のフロントエンド推定で体系的に外れる"* —
  proper-noun pitch accent is *systematically* wrong from Azure's frontend estimation.
  PR #6276 reverts the whole thing **two days later with no audible reason given**, and
  #6243's gate meant the `<phoneme>` path stayed inert until their API emitted accent data,
  so they may have reverted without ever hearing it. **This is not evidence that the
  notation failed.** PR #6279 is the revealing one: Azure's Japanese frontend
  *"alias 文字列を再解析した際に先頭モーラを助詞と誤認し、アクセント句が分割される"* (re-parses
  the alias, mistakes the first mora for a particle, and splits the accent phrase) — 都営
  coming out as と・えい. Their only lever was orthography: pass katakana, not hiragana.
  **Nobody in that repo tried `alphabet="sapi"` with kana + apostrophe** — the one path the
  archived legend actually documents.

### Also available, and better than expected: a custom lexicon for ja-JP

`speech-synthesis-markup-pronunciation.md` states the custom-lexicon `alphabet` accepts
`ipa` or `x-microsoft-sapi`, and that *"The Speech service defines sapi phonetic set for
these locales:"* — ja-JP is in that list. The ja-JP voices in
`includes/language-support/tts.md` carry **no footnote 3**, and footnote 3 is what marks
"Phonemes / custom lexicon aren't supported". So phonemes and custom lexicon are supported
for ja-JP standard neural voices. **A PLS lexicon with `alphabet="x-microsoft-sapi"` and
kana+apostrophe entries is the documented bulk-accent path** — one entry per vocabulary
item, 100 KB per file, cached 15 minutes. That maps well onto a fixed 3,741-word corpus.
**UNVERIFIED** — nobody has published using it for Japanese accent, and I did not test it.

Two ja-JP voices are exempt from phoneme support: `Nanami:DragonHDLatestNeural` and
`Masaru:DragonHDLatestNeural` (Neural HD). MAI-Voice-2-Flash voices are preview. Stay on
the plain neural voices.

### What remains unresolved

**Exactly one thing, and it is a listening judgment:** do the *current* ja-JP neural voices
still honour the sapi accent notation, and is the resulting downstep clean enough to serve
as shadowing reference audio? The legend is from 2012 and documents the old concatenative
engines. Azure could plausibly have kept the phone-set parser and re-pointed it at the
neural accent model — the most likely implementation, since that model consumes exactly
"accent phrase boundaries and accent type" — but that is **INFERRED**, and the total public
empirical record is one blog post.

### Searches that returned nothing (so you don't repeat them)

* **Azure release notes** — `releasenotes.md` fetched from source. Zero matches for accent,
  Japanese, or ja-JP.
* **GitHub** — `Azure-Samples/Cognitive-Speech-TTS` and
  `Azure-Samples/cognitive-services-speech-sdk`: **0 results** for Japanese + accent via
  the search API. No feature requests, no complaints. Nobody has asked.
* **Speech Studio / Audio Content Creation** — no ja-JP accent or pitch-accent editing
  surface documented anywhere. Generic "pronunciation, break, pitch, rate, intonation" only.
* Qiita `51017b4b268f66e11c42` and kunsen.net `post-3343` discuss Japanese SAPI phoneme
  strings but explain neither `'` nor `+`. Qiita `5f64e2a051c0d038d6d2` is the
  `<prosody pitch>` per-mora experiment — real, reports sounding natural, never touches
  `<phoneme>`.
* No academic or practitioner comparison of Azure/Google/Amazon Japanese accent control
  exists that could be found.

**A warning worth recording:** several web-search *result summaries* confidently asserted
that Azure accent-nucleus experiments existed, and one fabricated a description of the
note.com article before it was fetched. Every substantive claim above was verified against
the actual page. Discount any Azure-ja-JP-accent claim not traced to a fetched source.

### Verdict on the Azure account

**Create it.** This is now a narrow confirmation task, not exploration. The documentation
question is settled; only the listening question is open, and no further reading closes it.
Cost is not an objection: the Speech F0 free tier is 500,000 characters/month against a
106,926-character library (MEASURED, §5). A card is required at signup.

**Test order** (the harness in §6 implements this):

1. Three accent patterns on one word, one voice — if they differ audibly, it works.
2. Confirm placement direction: after the high mora (Microsoft's rule) vs before the drop
   (Polly's). Do not assume.
3. Test `|` (phrase boundary) and `_` (one mora pause). Undocumented in current Azure
   material and potentially the highest-value find, because accent-*phrase* splitting is
   what actually broke TrainLCD, and 117 of his own entries are multi-phrase (MEASURED, §3).
4. **Skip `alphabet="ipa"` for ja-JP.** The one practitioner report says it errors
   frequently, and Microsoft's own ja-JP IPA examples are garbled (see below).
5. Only if 1–3 pass, prototype the PLS lexicon.

### One caveat about Microsoft's own examples table

The ja-JP examples SPEC quotes are themselves corrupt, and this matters before leaning on
them. `合成 → ゴ'ウセ` drops the final イ — ごうせい has four morae, that string has three.
The IPA column is worse: `goˈwɯseji` for ごうせい and `ɕjojɯˈwɯɕja` for 所有者 both insert
spurious glides. **The example rows are unreliable as evidence of anything, apostrophe
placement included.** The archived legend is the trustworthy artefact.

---

## 2. Google's CustomPronunciations, verified without calling it

### The three beliefs in the brief

| Belief | Status |
|---|---|
| `PHONETIC_ENCODING_JAPANESE_YOMIGANA` exists on `CustomPronunciationParams` | **CONFIRMED** — primary docs + canonical proto, enum value `3` |
| `^` = accent-phrase start, `!` = downstep, Tokyo dialect, at most one `!` per phrase | **CONFIRMED verbatim**, with one wording correction |
| Examples are `^はし` / `^は!し` / `^はし!` for 端 / 箸 / 橋 | **CONFIRMED** — but Google supplies **no glosses**; the page shows kanji only |

**Wording correction, and it matters for the schema.** Google's docs never say "accent
phrase" or "accent nucleus". They say pitch **phrase** and **down-pitch position**.
Verbatim from the phonemes page: *"The start of a pitch phrase is specified with ^"*
(<https://docs.cloud.google.com/text-to-speech/docs/phonemes>). The at-most-one rule,
verbatim from the RPC reference: *"which allows at most one down-pitch per phrase"*
(<https://docs.cloud.google.com/text-to-speech/docs/reference/rest/Shared.Types/PhoneticEncoding>),
scoped to the Tokyo-dialect limitation and phrased as "one `!` between `^`".

### The finding that changes the plan: there are TWO mechanisms, not one

**(a) SSML `<phoneme alphabet="yomigana">`.** Documented at
<https://docs.cloud.google.com/text-to-speech/docs/phonemes>. **This is where the
端/箸/橋 examples appear, as working SSML** —
`<phoneme alphabet="yomigana" ph="^は!し">箸</phoneme>`. The same page documents three
things absent from the API-field docs: *"Compound words are allowed, and segmentation is
performed automatically"*, *"Both katakana and hiragana are allowed"*, and automatic vowel
elongation (女王 → じょおー, not じょーう). The SSML page states Japanese *"must be
specified as `yomigana`"* (<https://docs.cloud.google.com/text-to-speech/docs/ssml>).

**(b) `SynthesisInput.custom_pronunciations`.** The API field, field number 3, added for HD
voices in April 2025.

**They are explicitly incompatible:** the field comment says *"If using SSML, the phrase
must not be inside a phoneme tag."*

**For this project, (a) is the better bet** — better documented, the examples that matter
literally live there, "compound words allowed" is directly relevant to a kanji-compound
vocabulary deck, and it works on the mid-tier voices that are free at this volume.

### Voice tiers — the practical crux, and it is genuinely unresolved

Primary documentation is **self-contradictory across three official pages**:

* `SynthesisInput.custom_pronunciations` still carries, in v1, v1beta1 and the canonical
  proto: *"The initial support is for en-us, with plans to expand to other locales in the
  future. Instant Clone voices aren't supported."*
  (<https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/SynthesisInput>,
  <https://github.com/googleapis/googleapis/blob/master/google/cloud/texttospeech/v1/cloud_tts.proto>)
* Release notes 2025-05-07 (GA) contradict it: custom pronunciations *"available across all
  locales except"* an 8-locale list — ja-jp not among them
  (<https://docs.cloud.google.com/text-to-speech/docs/release-notes>).
* The Chirp 3 HD page gives a **different, 26-locale** exclusion list — ja-jp again absent
  (<https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd>).

**INFERRED:** the en-us sentence is stale proto text never updated after the May 2025
locale expansion. **Not confirmable without a call.**

Per tier, what the docs actually say:

| Tier | SSML `<phoneme yomigana>` — path (a) | `custom_pronunciations` field — path (b) |
|---|---|---|
| Standard / WaveNet / Neural2 | **Documented** (SSML in the Controllability column of `list-voices-and-types`) | **No doc anywhere states these support the field. UNVERIFIED.** |
| Studio | SSML supported *"except for the following tags: `<mark>`, `<emphasis>`, `<prosody pitch>`, and `<lang>`"* — `<phoneme>` not excluded, so it should work. **UNVERIFIED.** | UNVERIFIED |
| Chirp 3: HD | **Impossible** — *"doesn't support SSML input, speaking rate and pitch-audio parameters"* | The only route, but the Chirp 3 HD page documents **only IPA and X-SAMPA** and never mentions yomigana. **UNVERIFIED and doubtful.** |
| Gemini-TTS | No SSML | No `customPronunciations`. Control is prompt-based natural language; **no mention of pitch accent anywhere.** Useless for deterministic per-word contours. |

### SSML vs plain text, for the field

Both, but differently. The field works with `text` or `ssml` (a union: *"Supplying both or
neither returns `google.rpc.Code.INVALID_ARGUMENT`"*), requires *"an exact match of the
phrase in the input"*, and forbids the phrase being inside a `<phoneme>` tag. Path (a) is
SSML-only by construction.

### The exact request shape — and a documentation bug in Google's own example

The reference schema
(<https://docs.cloud.google.com/text-to-speech/docs/reference/rest/Shared.Types/CustomPronunciations>)
is a wrapper around a repeated list. There *is* a `pronunciations[]` array:

```json
{
  "input": {
    "text": "橋を渡る",
    "custom_pronunciations": {
      "pronunciations": [
        { "phrase": "橋",
          "phonetic_encoding": "PHONETIC_ENCODING_JAPANESE_YOMIGANA",
          "pronunciation": "^はし!" }
      ]
    }
  },
  "voice": { "language_code": "ja-JP", "name": "ja-JP-Neural2-B" },
  "audio_config": { "audio_encoding": "MP3" }
}
```

**The Chirp 3 HD page's own example is malformed** — it places `phrase` /
`phonetic_encoding` / `pronunciation` directly under `custom_pronunciations`, omitting the
`pronunciations` array. Corroborated by the one public bug report found
(<https://discuss.ai.google.dev/t/custom-pronunciations-not-working-with-chirp3-hd-voices/106259>):
en-US Chirp3-HD-Leda, X-SAMPA, API returned 200 but the word was unchanged; a community
member's fix was to format it as an array. No Google response in the thread.

### Limits

* **5,000 bytes total per request** (<https://docs.cloud.google.com/text-to-speech/quotas>)
  — the only hard number.
* `phrase` *"shouldn't span the length of the sentence."*
* **No documented cap on the number of custom pronunciations per request, and no
  phrase-length limit.** Confirmed *absent* from the docs, not merely unfound.
* RPM: Neural2 1,000 · Studio 500 · Chirp3 200.

### Has anyone published that it works for Japanese pitch accent?

**No — not for the API field. This is a real gap, and it is the reason to test rather than
trust.**

* The launch is precisely dated from Google's own client changelog: `custom_pronunciations`
  / HD voice support in **v2.26.0 (2025-04-12)**, and *"Support pinyin/yomigana custom
  pronunciation encodings for cmn-cn/ja-jp"* in **v2.27.0 (2025-05-08)**
  (<https://docs.cloud.google.com/python/docs/reference/texttospeech/latest/changelog>).
  Groundwork in v2.18.0 (2024-10-10), "Add CustomPronunciationParams for upcoming feature
  work". GA per the release notes.
* Japanese-language third-party material exists but uses **path (a), not the field** — and
  not even with yomigana: a note.com experiment used `ja-JP-Neural2-B` with `<phoneme>` and
  **X-SAMPA apostrophe** accent marks (<https://note.com/makoto_honikaze/n/n65498d234bd5>).
* **Searches that returned nothing:** Reddit and Hacker News (site-restricted, zero
  discussion); no GitHub issue in `googleapis/nodejs-text-to-speech` or
  `google-cloud-python` about yomigana; no Qiita/Zenn post testing `^`/`!` specifically.

### Pitch accent elsewhere in Google's docs

Only the phonemes page. The v1 REST reference, `list-voices-and-types`, Chirp 3 HD, and
Gemini-TTS are all silent on アクセント for ja-JP.

### Pricing at this volume

Official, from Google: **4M characters/month free for Standard**, **1M/month free for
WaveNet** (<https://cloud.google.com/text-to-speech/pricing>). **The per-1M dollar table is
JS-rendered and could not be read from the official page.** Third-party and therefore
**UNVERIFIED**: Standard $4, Neural2 $16, Chirp 3 HD $30, Studio $160
(<https://texttolab.com/blog/google-cloud-tts-pricing>) — treat the Standard/WaveNet split
as suspect; the commonly cited figures are Standard $4 / WaveNet $16.

**For 106,926 characters (MEASURED, §5): entirely inside the free tier on Standard,
WaveNet, or Neural2 — one-off, or re-run monthly for a year without paying.** SPEC's
"cost cannot decide the TTS provider" holds. What decides it is whether the contour is
right, and secondarily which male voice you like.

### One inference worth flagging, because §3 depends on it

`!` marks the boundary *after* the accented mora: 箸 `^は!し` = drop after は; 橋 `^はし!`
= drop after し, i.e. onto the following particle. Consistent with standard Japanese accent
description, and it is what the derivation in §3 independently produces — but **Google
never states it**; the docs only say "down-pitch position". **INFERRED.** This is exactly
the CLAUDE.md decision-6 hazard: "accent position" (the last high mora) and "downstep
location" (the boundary after it) differ by one, and Azure and Polly describe them from
opposite sides. **Name the basis in the schema or the field is not a fact.**

---

## 3. The accent derivation, and the bare-word problem

### Tooling: what worked and what did not

**MEASURED.** `pip install pyopenjtalk` **fails on this machine**: no `cmake` on PATH
(`cmake --version` → command not found), so the source build dies at
`CalledProcessError: Command '['cmake', '..']' returned non-zero exit status 1`.

**MEASURED.** `pyopenjtalk-plus` **0.4.1.post9** installs from a prebuilt cp313 win_amd64
wheel and exposes the module as `pyopenjtalk`, `extract_fullcontext` included. Everything
below was run against it, in a throwaway venv (nothing installed into the user's global
site-packages).

> **UNVERIFIED, and the one caveat on every number in this section:** `pyopenjtalk-plus` is
> a **fork**. Its bundled dictionary may differ from upstream `pyopenjtalk`'s
> `open_jtalk_dic_utf_8-1.11` (naist-jdic). I could not install upstream to diff them. If
> the accent-type distribution below is going to drive a regeneration of the whole library,
> re-run it against upstream on a machine with a C++ toolchain first, and diff. The
> *mechanism* validation does not depend on this; the *content* does.

### The trap, quantified on his own vocabulary

**BASIS:** `card_field_values.value` where `field_id='name'` and the card's template is
単語 or 言葉. n = 3,860. Analyser `pyopenjtalk-plus` 0.4.1.post9. Probe particle `が`.

SPEC says OpenJTalk returns the mora count instead of 0 for 平板, so `if accent > 0` emits
a phantom downstep. **MEASURED, and it is worse than that framing:**

```
single-accent-phrase words analysed                 3,741
naive `if bare_accent > 0` fires on                 3,741  (100.0%)
words that actually carry a downstep                1,676  ( 44.8%)
PHANTOM downsteps the naive rule would emit         2,065  ( 55.2%)
```

**OpenJTalk never returned 0 for a single bare word anywhere in this corpus.** The naive
rule does not merely misfire often — it misfires on *every* word, and turns 2,065 平板
words into 尾高. That is 55.2% of his vocabulary, drilled wrong, through spaced
repetition.

### The fix: a probe particle, and it is validated

Append `が`, analyse the probed string, and read the accent type off the *probed* mora
count.

**MEASURED** — bare vs probed, from `extract_fullcontext`'s `/F:f1_f2` field
(f1 = moras in the accent phrase, f2 = accent position, 1-based):

| word | bare `F:` | probed (`+が`) `F:` | derived | Google's documented notation |
|---|---|---|---|---|
| 箸 | `2_1` | `3_1` | 頭高 (1) | `^は!し` ✅ matches |
| 橋 | `2_2` | `3_2` | 尾高 (2) | `^はし!` ✅ matches |
| 端 | `2_2` | `3_3` | 平板 (0) | `^はし` ✅ matches |
| 花 | `2_2` | `3_2` | 尾高 (2) | `^はな!` |
| 鼻 | `2_2` | `3_3` | 平板 (0) | `^はな` |

**This is the strongest result in the document.** Bare 橋 and bare 鼻 are *identical* to the
analyser (`2_2`), exactly as SPEC says they are identical to a native listener. The probe
separates them. And the notation my rule emits for 箸/橋/端 is character-for-character
what Google's documentation shows for those three words — derived here from the analyser
with no reference to that page. Two independent chains agreeing is what makes both
trustworthy.

### The rule, stated precisely

Let `bare_moras` = f1 of the bare word (single accent phrase required), and
`probed_moras` / `probed_accent` = f1 / f2 of `word + が`.

```
GUARD   probed_moras != bare_moras + 1   -> refuse, flag for manual review.
                                            The probe changed the reading.
probed_accent == 0 or >= probed_moras    -> 平板,  accent_type 0   (no downstep)
probed_accent == 1                       -> 頭高,  accent_type 1
probed_accent == bare_moras              -> 尾高,  accent_type bare_moras
1 < probed_accent < bare_moras           -> 中高,  accent_type probed_accent
probed_accent > bare_moras (else)        -> 不明,  refuse
```

Then emit notation **for the bare word alone**: `^` + moras, with `!` inserted after mora
`accent_type` when `accent_type > 0`. 平板 emits no `!`. Mora splitting must keep small
kana (`ゃゅょぁぃぅぇぉ` and katakana equivalents) attached to the preceding mora.

**Two parser traps, both MEASURED, both of which I hit:**

1. **Do not detect accent-phrase boundaries by "the `/A:` a2 field resets to 1".** It fails
   on `に引き換え`, whose two phrases *both* start at a2=1 — the first phrase is the
   one-mora `に`. Use `(I.i3, F.f5)` instead: `/I:...@i3+` is the breath-group index in the
   utterance and `/F:...@f5_` is the accent-phrase index in the breath group. Together they
   are a unique phrase key. My first parser used the a2 heuristic and silently reported
   `に越したことはない` as two phrases of 1 and 2 moras when it has thirteen phonemes.
2. **Skip silence/pause labels** — they carry `xx` in both fields.

### The guard earns its place: 5 words where the probe changes the reading

**MEASURED.** 5 of 3,741 (0.13%) come back with `probed_moras != bare_moras + 1`:

```
光        bare=[(3,3)]  probed=[(3,1)]     probe ADDED NO MORA
見物      bare=[(4,4)]  probed=[(4,3)]     probe ADDED NO MORA
正義      bare=[(4,2)]  probed=[(4,1)]     probe ADDED NO MORA
潰れる    bare=[(5,4)]  probed=[(5,5)]     probe ADDED NO MORA
取り立てて bare=[(5,5)]  probed=[(7,7)]     probe ADDED TWO MORAE
controls: 猫 [(2,1)]->[(3,1)]   学生 [(4,4)]->[(5,5)]   橋 [(2,2)]->[(3,2)]
```

`光` + `が` coming back as 3 moras means the analyser re-read 光 as a 2-mora word (こう)
once a particle followed it. **Appending a particle can change the morphological analysis
of a homograph.** Without the guard those five get a silently wrong accent type; with it,
they land in a manual-review queue of five items. This is why the guard is not optional
tidiness — it is the only thing standing between a homograph and a wrong drill.

### The multi-phrase entries

**MEASURED.** 117 of 3,860 values split into more than one accent phrase (bare or probed).
2 are the empty string. The remaining 3,741 are single-phrase.

The 117 are not only the grammar patterns — they are mostly **verb phrases and idioms**
that legitimately carry an internal particle: `空気を読む`, `気を配る`, `腹を立てる`,
`にもかかわらず`, `目が点になる`, `白羽の矢が立つ`. For these the bare-word problem
**does not arise**, because each phrase except the last is already followed by material
inside its own phrase.

**MEASURED — the probe touches only the last phrase.** Across `空気を読む`, `気を配る`,
`にもかかわらず`, `～なり～なり` and `...は...に限る`, appending `が` left every leading
phrase's `(moras, accent)` byte-identical and changed only the final one:

```
'空気を読む'      bare=[(4,1),(2,1)]        probed=[(4,1),(3,1)]
'気を配る'        bare=[(2,2),(3,2)]        probed=[(2,2),(4,2)]
'にもかかわらず'  bare=[(2,1),(5,3)]        probed=[(2,1),(6,3)]
'～なり～なり'    bare=[(2,1),(2,1)]        probed=[(2,1),(3,1)]
'...は...に限る'  bare=[(1,1),(1,1),(3,2)]  probed=[(1,1),(1,1),(4,2)]
```

**So the multi-phrase rule is: analyse bare, take every phrase but the last verbatim,
apply the probe rule to the last one only, and emit one `^` per phrase.** That satisfies
Google's "at most one `!` between `^`" constraint by construction, and it is the same
notation Azure's `|` (phrase boundary) would express.

### The placeholders — `～` and `...` — measured, not presumed

SPEC says the `～` and `...` characters *"are presumably being read aloud in the current
audio."* **The presumption is now MEASURED, and the answer is: they were definitely sent
to Azure, and they change the analysis, but the audio evidence says they are not read as a
word.**

**MEASURED — an exhaustive codepoint census** over the same 3,860 values, not a regex
guess:

```
U+FF5E FULLWIDTH TILDE  ～    17 occurrences
U+301C WAVE DASH        〜     3
U+007E ASCII TILDE      ~      1     <- '~に越したことはない'
ASCII '...'                    3
VALUES containing at least one placeholder: 21
```

**Note the discrepancy with SPEC, and note the cause.** SPEC says *"23 entries are grammar
patterns carrying placeholders"*. On this basis — `field_id='name'`, templates 単語+言葉 —
I count **21**, and my own first pass counted **20** because I wrote a regex for `～〜...`
and missed the single **ASCII** tilde in `~に越したことはない`. Three tilde codepoints and
two ellipsis spellings are in use. Whichever number is right, this is precisely the class of
defect CLAUDE.md decision 6 describes: **name the basis or the number is not a fact.** The
basis for 21 is stated above; SPEC's basis for 23 is not stated, and may include the 敬語 /
Polysemy / 文法 templates or `content`-authored cards.

**MEASURED — all 21 were sent to Azure verbatim.** Every one has a byte-exact
`blobs.source_text` match at `kind='speech'`, `lang='ja-JP'`,
`voice='ja-JP-NanamiNeural'`, with a non-zero payload. 21 hits, 0 misses. So the
placeholders are not being stripped anywhere in the current pipeline.

**MEASURED — the placeholders change the analysis even when they produce no phoneme:**

```
g2p('～に越したことはない') == g2p('に越したことはない')   # identical phone strings
phrases('～なり')  = [(2, 1)]        phrases('なり')  = [(2, 2)]     <- DIFFERENT accent
phrases('～なり～なり') = [(2,1),(2,1)]   medial ～ becomes a `pau` and splits breath groups
g2p('...は...に限る') = 'w a pau n i k a g i r u'   <- leading '...' dropped, medial '...' -> pau
```

A **leading** tilde contributes no phoneme but flips `なり` from accent 2 to accent 1,
because the unknown symbol changes how the following morpheme is tagged. A **medial**
tilde or ellipsis becomes a pause. And `...は...に限る` loses its first `...` entirely
while the second becomes a pause — inconsistent handling of the same character.

**Weak evidence on whether Azure voiced them.** Comparing `blobs.byte_size` for the 21
placeholder clips against the median for their placeholder-stripped content length (Nanami
appears to be a constant-bitrate 480-byte-frame mp3, so bytes track duration), the deltas
are small and mostly negative: `～なり` is 2,400 bytes *shorter* than the 2-character
median, `～んばかり` is dead on it, `...にも程がある` is 5,280 bytes longer. **INFERRED,
weakly:** nothing here shows the ~1s a spoken word would add, so the tilde is probably not
being read as 「なみ」or 「から」. **But this comparison is uncontrolled** — different words
have different durations regardless — so it cannot rule out a short pause. **The controlled
test is two API calls: synthesise `なり` and `～なり` on the same voice and diff the
durations.** The harness in §6 does exactly that.

### Recommended handling of placeholders

1. **Strip every placeholder codepoint from the synthesis input and from the analyser
   input**, and normalise all three tilde spellings plus both ellipsis spellings to one
   internal marker first. The evidence that a leading `～` changes `なり` from accent 1 to
   accent 2 is sufficient reason on its own: it is corrupting the derivation.
2. **Keep the placeholder in the displayed text.** It is authored, it means something to
   him, and `card_field_values.value` is verbatim by decision.
3. **Emit one `^` per surviving segment.** Splitting on the placeholder gives exactly the
   accent-phrase segmentation Google's notation wants, and the placeholder positions are
   better phrase boundaries than the analyser's own guesses.
4. **Re-generating the 21 clips is not free of consequence** — they change, so their
   content addresses change. That is 21 blobs, and §5's regeneration path handles it.

### The accent-type distribution across his real vocabulary

**MEASURED.** Same basis as above. `SPLIT` = more than one accent phrase (§3 rule applies
per-phrase, not one label). `GUARD` = probe did not add exactly one mora.

| template | 平板 | 頭高 | 中高 | 尾高 | SPLIT | GUARD | total |
|---|--:|--:|--:|--:|--:|--:|--:|
| 単語 | 1,944 | 642 | 759 | 45 | 72 | 5 | 3,467 |
| 言葉 | 119 | 94 | 127 | 6 | 45 | 0 | 391 |
| **both** | **2,063** | **736** | **886** | **51** | **117** | **5** | **3,858** |

(+2 empty values = 3,860. 2,063+736+886+51 = 3,736 labelled.)

As percentages of the 3,736 cleanly labelled words: **平板 55.2% · 中高 23.7% · 頭高 19.7%
· 尾高 1.4%.**

**Three things follow, and they should shape the whole test plan.**

* **平板 is the majority pattern.** The notation's most important job is to *not* add a
  downstep. Test that first.
* **尾高 is 1.4% — 51 words.** The 平板/尾高 distinction SPEC raises as a pedagogy question
  affects 51 cards, not thousands. That reframes it: adding a particle to the audio for
  those 51 is a small, targeted change, not a library-wide policy.
* **中高 at 23.7% is where the *position* matters** and where a wrong drop is most
  audible. Some are 中高(2), some 中高(5). The label alone (§4) does not disambiguate
  them, which argues for rendering the number alongside.

**MEASURED sample** — first 20 単語 head-words that pass the guard, so you can eyeball
whether the analyser is sane before spending anything:

```
粗方 平板(0)/4    禁じ得ない 中高(4)/6   や否や 中高(2)/4     ～なり 頭高(1)/2
極まりない 中高(5)/6  ～上で 平板(0)/3    余儀なくされる 中高(6)/7  口にする 平板(0)/5
手に入れる 頭高(1)/5  巧みに 平板(0)/4    下手をすると 中高(2)/6   十人十色 中高(5)/7
実に 中高(2)/3     暗に 頭高(1)/3      果たして 中高(2)/4     期待はずれ 中高(4)/6
いたずらに 平板(0)/5  引き続き 平板(0)/5   大いに 頭高(1)/4      上げ膳据え膳 中高(5)/8
```

### How reliable is the dictionary content? Unresolved, and the reason §4 matters

I checked 15 common words against **my own recall**, which is *not* a citation and must not
be treated as one:

```
agree  学生 平板 · 日本語 平板 · 猫 頭高 · 雨 頭高 · 飴 平板 · 神 頭高 ·
       卵 中高(2) · 先生 中高(3) · 女の子 中高(3) · お母さん 中高(2)
DIFFER 紙 (says 尾高, I recall 平板) · 髪 (尾高 / 頭高) · 心 (尾高 / 中高) ·
       友達 (平板 / 中高) · 水 (平板 / 頭高)
```

**10 agree, 5 differ.** I cannot adjudicate the five: my recall is not authoritative, some
of them have genuine regional and register variation, and OJAD's terms permit hand
lookup but forbid the bulk scraping that would settle it at scale (SPEC).

**What this does and does not tell you.** It does **not** undermine the mechanism — the
mechanism is validated by 箸/橋/端/花/鼻, which are textbook-unambiguous and all five come
out right. What it tells you is that the **dictionary content has a non-trivial error rate
on common words**, which is exactly what SPEC predicted ("dictionary-driven analysis will
guess on rare words, proper nouns and novel compounds") except that it is not confined to
rare words. Three consequences:

1. **The manual override is not a nice-to-have.** Build it in stage 1 as SPEC says.
2. **§4's visible label is the cheapest possible error detector.** If 水 renders 平板 and
   he knows it is 頭高, he sees it and fixes it in one tap. If only the audio is wrong, he
   drills it.
3. **Spot-check ~30 words by hand against OJAD before regenerating anything.** That is the
   one measurement I could not make and the one that decides whether the derivation is
   good enough to drive 3,741 regenerations.

### The derivation module, validated

<!--BEGIN accent.py-->
```python
"""Accent derivation from OpenJTalk full-context labels.

Validated 2026-08-20 against 箸/橋/端/花/鼻: the notation this emits for
箸/橋/端 is character-for-character Google's documented ^は!し / ^はし! / ^はし.

BASIS, stated once: OpenJTalk emits one HTS full-context label per phoneme.
  /F:f1_f2#f3_f4@f5_f6|f7_f8   f1 = morae in this accent phrase
                               f2 = accent position, 1-based, within the phrase
                               f5 = index of this accent phrase in its breath group
  /I:i1-i2@i3+i4&...           i3 = index of this breath group in the utterance
An accent phrase is therefore keyed by (i3, f5).  Silence/pause labels carry xx
and are skipped.  DO NOT use "the /A: a2 field resets to 1" as the boundary
test: it fails on `に引き換え`, whose two phrases both start at a2=1.
"""
import re
import pyopenjtalk        # or pyopenjtalk_plus, which exposes the same module name

F_RE = re.compile(r'/F:(\d+)_(\d+)#[^@]*@(\d+)_(\d+)')
I_RE = re.compile(r'/I:[^@]*@(\d+)\+')

TYPES = ("平板", "頭高", "中高", "尾高")
SMALL = "ゃゅょぁぃぅぇぉャュョァィゥェォ"


def phrases(text):
    """[(morae, accent_pos)] per accent phrase, in utterance order."""
    seen, out = set(), []
    for lab in pyopenjtalk.extract_fullcontext(text):
        f, i = F_RE.search(lab), I_RE.search(lab)
        if not f or not i:
            continue
        key = (int(i.group(1)), int(f.group(3)))
        if key in seen:
            continue
        seen.add(key)
        out.append((int(f.group(1)), int(f.group(2))))
    return out


def classify(bare_moras, probed_moras, probed_accent):
    """Accent type of the BARE word, decided on the PROBED string (word + が).

    probed_accent >= probed_moras -> the nucleus is on the probe particle, i.e.
                                     no drop inside the word: 平板 (0).
    probed_accent == bare_moras   -> drop on the word's last mora: 尾高.
    probed_accent == 1            -> 頭高.
    1 < probed_accent < bare_moras-> 中高.
    """
    if probed_accent == 0 or probed_accent >= probed_moras:
        return "平板", 0
    if probed_accent > bare_moras:
        return "不明", probed_accent           # refuse
    if probed_accent == 1:
        return "頭高", 1
    if probed_accent == bare_moras:
        return "尾高", bare_moras
    return "中高", probed_accent


def derive(word, probe="が"):
    """`ok` False means: refuse and queue for manual review.

    `guarded` True means the probe did not add exactly one mora, i.e. it changed
    the morphological reading (光 + が came back as 3 morae, not 4).  MEASURED at
    5 of 3,741 on this corpus.  Never emit notation for a guarded word.
    """
    bare, probed = phrases(word), phrases(word + probe)
    r = {"word": word, "bare": bare, "probed": probed,
         "bare_phrases": len(bare), "probed_phrases": len(probed)}
    if len(bare) != 1 or len(probed) != 1:
        r["ok"] = False
        r["reason"] = "multi-phrase: apply the rule to the LAST phrase only"
        return r
    bm, ba = bare[0]
    pm, pa = probed[0]
    if pm != bm + 1:
        r.update(ok=False, guarded=True, bare_moras=bm, probed_moras=pm,
                 reason="probe changed the reading; manual review")
        return r
    name, atype = classify(bm, pm, pa)
    r.update(ok=(name != "不明"), guarded=False, bare_moras=bm, bare_accent=ba,
             probed_moras=pm, probed_accent=pa, type=name, accent_type=atype)
    return r


def split_moras(kana):
    """Small kana attach to the preceding mora: きょ is one mora, not two."""
    out = []
    for ch in kana:
        if ch in SMALL and out:
            out[-1] += ch
        else:
            out.append(ch)
    return out


def yomigana(reading, accent_type):
    """Google's notation for ONE accent phrase.  `^` opens it; `!` follows the
    mora carrying the downstep; 平板 (0) emits no `!`.
    UNVERIFIED against a live API call -- see the harness."""
    moras = split_moras(reading)
    if accent_type <= 0 or accent_type > len(moras):
        return "^" + "".join(moras)
    return "^" + "".join(moras[:accent_type]) + "!" + "".join(moras[accent_type:])


def sapi_kana(reading_katakana, accent_type):
    """Azure's ja-JP sapi notation.  `'` = "Accent position" (Microsoft's word),
    placed AFTER the affected syllable; a trailing `+` = "Accent boundary",
    reported to read the word 平板.  BOTH UNVERIFIED -- see the harness."""
    moras = split_moras(reading_katakana)
    if accent_type <= 0 or accent_type > len(moras):
        return "".join(moras) + "+"
    return "".join(moras[:accent_type]) + "'" + "".join(moras[accent_type:])
```
<!--END accent.py-->

`sapi_kana` needs a **katakana** reading, and `yomigana` accepts either (Google: *"Both
katakana and hiragana are allowed"*). Get the reading from
`pyopenjtalk.g2p(word, kana=True)` or from the existing furigana pipeline — `src/text` and
the 3,255 cached furigana generations already hold most of them, which is worth checking
before deriving readings a second way.

---

## 4. `<<型>>` — the accent-type label

### The value is derived, and where it is stored is the whole design question

`STAGE4.md` §3 already measured what happens when a derived field's value is *not*
materialised:

```
generator-typed template fields:                    ai 4 · speech 10 · translate 5
rows in card_field_values for ANY of those 19:      0
単語 Speech (6ov2HLxA) + Audio (efJTAfzT) values:   0
```

`<<Speech>>` interpolates to nothing on 3,477 of 3,477 単語 cards, which is why 26.2% of
all sides render blank. **"Resolve it on demand like the audio" is a description of a
measured defect, not a design.** STAGE4 §7.1 puts the recommendation plainly: *"(a)
materialise generator-field values … The measurements favour (a)."*

So `型` must be **materialised into `card_field_values`** — and then the renderer needs
zero new code, because `<<型>>` is just text.

### But `card_field_values` is for authored text

The schema comment is explicit: values are *"kept verbatim"*, *"round-trip fidelity is
non-negotiable"*. Writing derived data into it, and then re-deriving, would clobber a
manual override. Resolve that by putting the **derivation** and the **override** in a
separate table and using `card_field_values` only as the materialised render cache:

```sql
-- Derived accent facts, keyed by TEXT rather than by card: 橋 has one accent
-- whichever card it appears on, exactly as a blob has one address whatever
-- references it.  A manual override is a row with analyser = 'manual'.
CREATE TABLE accents (
  text         TEXT NOT NULL,      -- normaliseSourceText() output. Placeholders stripped.
  analyser     TEXT NOT NULL,      -- 'openjtalk' | 'manual'
  version      TEXT NOT NULL,      -- 'pyopenjtalk-plus/0.4.1.post9+naist-jdic/1.11'; '' for manual
  probe        TEXT NOT NULL,      -- 'が'; '' when no probe was used
  phrases      TEXT NOT NULL,      -- JSON [[morae,accent],...], ONE ENTRY PER ACCENT PHRASE
  type         TEXT CHECK (type IS NULL OR type IN ('平板','頭高','中高','尾高')),
  accent_type  INTEGER CHECK (accent_type IS NULL OR accent_type >= 0),
  reading      TEXT,               -- kana the notation was built from
  -- NAME THE BASIS (CLAUDE.md decision 6).  'accent-position' = the last HIGH
  -- mora, 1-based (Azure's word, and this schema's).  'downstep-after' = the
  -- boundary following it.  They differ by one and Azure and Polly describe
  -- them from opposite sides, so the column is not optional.
  position_basis TEXT NOT NULL DEFAULT 'accent-position'
                   CHECK (position_basis IN ('accent-position','downstep-after')),
  -- Why this row exists / how much to trust it.
  basis        TEXT NOT NULL CHECK (basis IN ('probe','bare','multi-phrase','manual','guarded')),
  note         TEXT,               -- 'probe changed the reading', an OJAD citation, ...
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (text, analyser, version, probe)
);

CREATE INDEX accents_text ON accents (text);
```

**Resolution:** an `analyser = 'manual'` row wins outright; otherwise the newest
`version`. One view, `accent_resolved`, mirroring `card_reverse_resolved`'s shape so there
is one definition of the answer and nothing can disagree with it.

**Materialisation:** a `hashigo accent derive` command walks the head-word fields, resolves
each through `accent_resolved`, and writes `type` (optionally `type (accent_type)`) into
`card_field_values` for the `型` field id. Re-running it is idempotent and cannot destroy an
override, because the override never lived there.

### Template integration

* Add `'accent'` to `template_fields.type`'s CHECK constraint. **Stage 1, not later** —
  SPEC: *"a feature whose storage is retrofitted later means a migration over 7,716 cards"*.
* 単語's `型` field gets `source_field_id = 'name'`; 言葉's likewise. That is the same
  `source` pointer the existing generation DAG resolver already walks, so ordering comes
  free — and unlike `例文`, the dependency is a real pointer and not buried in a prompt
  string, so it does not hit the incomplete-graph trap the schema comment warns about.
* Template body: `<<型>>` beside `<<Speech>>` on side 2. It must appear on the **reveal**
  side, never the production side. A 平板 label on the prompt side hands him the answer
  before he has produced it — the same class of error as autoplay, and the same reason.
  **This is the one thing to get right in the template edit.**
* No renderer change. `<<型>>` resolves through the ordinary plain-field path, and there is
  no new mount class, no new node type, no new test surface. Worth contrasting with the
  audio: a derived *label* can be materialised as text; a derived *clip* cannot, which is
  why §3 of STAGE4 is a harder problem than this one.

### The manual override, end to end

`INSERT OR REPLACE INTO accents (text, analyser, version, probe, ...) VALUES (?, 'manual',
'', '', ...)`, then re-materialise. In the UI that is one control on the card: the four
type buttons plus a mora-position picker when 中高 is chosen. It also wants a `note` — if
he checks OJAD he should be able to record that he did, because in six months the question
"is this override right or was I guessing?" will matter.

**The five guarded words and the 117 multi-phrase entries need a place to land.** A
`hashigo accent review` listing is the whole feature: 122 rows, one pass, done once.

### Why the label is worth building even before the provider question is settled

He is right that a wrong label is more visibly wrong than a wrong sound, and the §3
recall check quantifies the argument: **the dictionary and my own recall disagreed on 5 of
15 common words.** If that error rate is anywhere near real, then somewhere between a
handful and several hundred of 3,736 labels are wrong. A wrong label he can see and fix in
one tap. A wrong contour he shadows, out loud, on a spaced-repetition schedule. **The label
is the audit surface for everything else in this document** — including the answer to
"were the 7,403 existing Nanami clips right all along?", because once the label is on
screen he will notice the clip disagreeing with it.

---

## 5. Per-card voice, and cheap regeneration

### What the store already does

`src/import/blobs.ts` is more careful than the brief's premise. Two corrections:

1. **`blobs.hash` is `sha256(payload bytes)`, NOT `sha256(normalised_text, voice, lang)`.**
   The module header explains why, with measurements: 12 normalised generation keys resolve
   to live files whose *bytes differ* (Azure is not bit-reproducible), so tuple-addressing
   would force discarding 14 real, still-referenced files; and 30 live files have no cache
   provenance at all, whose tuple would collapse them to one address. `schema.sql`'s comment
   `-- lowercase hex sha256 of the identity tuple` is **stale and contradicts the
   implementation** — worth fixing, since it is the one place a reader would go for the
   answer.
2. **The identity tuple is stored *on* the row and is what the cache looks up.**
   `generationKey()` computes SPEC's `sha256(normalised text, voice, lang)` (widened to
   include `kind` and canonical `options`) for callers that want the key;
   `lookupGeneration()` does the actual hit test with a `WHERE kind=? AND source_text=? AND
   voice IS ? AND lang IS ? AND options=? AND byte_size>0` query.

**The good news, and it is substantial: the voice IS part of the cache identity.** So the
premise's conclusion survives its wrong premise — changing a voice yields a cache miss, a
new generation, a different content address, and regeneration is idempotent. The existing
store supports per-card voice cleanly at the *addressing* layer. Refcounting is maintained
by triggers (`blob_refs_ai` / `_ad` / `_au`), `blobs_immutable` forbids mutating an
identity tuple under a fixed hash, and `blobs_no_delete_while_referenced` makes an
accidental delete impossible.

### What is missing — four concrete gaps, all MEASURED by grep

1. **No voice on a card or a deck.** `grep -n "voice" src/schema/schema.sql` returns four
   hits: `template_fields.options`'s comment, `blobs.voice`, and two lines inside the
   immutability trigger. **Voice exists only on the template** — which is precisely his
   Mochi complaint, reproduced. He wanted a male voice and got a female one; nothing in
   the current schema would have let him fix that per card either.
2. **No way to drop or retarget a reference.** `addBlobRef` is `INSERT OR IGNORE` and
   nothing else. `grep -rn "DELETE FROM blob_refs\|removeBlobRef\|dropRef\|deleteRef"
   src/` returns **nothing in `src/`** — only three raw-SQL lines in
   `test/blobs.test.ts` and `test/schema.test.ts`. The `blob_refs_au` trigger exists
   specifically to keep refcounts straight when `blob_hash` is updated, and **nothing in
   production calls it.** So today a blob can never reach refcount 0 by user action, which
   means `sweepUnreferenced` can only ever reclaim blobs that were never referenced.
   **This is his "unwanted audio is very hard to delete" pain point, present in the new
   codebase.** The mechanism is built and tested; the API over it is missing.
3. **`sweepUnreferenced` has no grace period.** It takes everything at `refcount = 0`
   immediately. The index `blobs_unreferenced ON blobs (created_at) WHERE refcount = 0` is
   ordered by `created_at`, so an age filter was clearly anticipated — and it matters for
   exactly his use case (see below).
4. **The generation path is entirely synchronous.**
   `grep -rn "async |await |Promise" src/blobs/db.ts src/import/blobs.ts` returns
   **nothing**. `resolveGeneration(db, request, generate)` takes a *synchronous* `generate`
   callback, and `store.ts` documents the synchronous contract as a deliberate commitment
   (*"`read(hash): Uint8Array` forecloses a main-thread store permanently"*). **An HTTP
   call to Azure or Google cannot be passed to `resolveGeneration`.** Stage 9's generator
   must instead: (a) `lookupGeneration` → hit, done; (b) miss → `await` the HTTP call
   outside the store; (c) `putBlob` + `addBlobRef`. That is a small function, but it does
   not exist and `resolveGeneration`'s shape actively invites getting it wrong.

### Design: three-state voice, mirroring reverse-review resolution

`views.sql`'s pattern, verbatim in shape:

```sql
ALTER TABLE decks ADD COLUMN voice TEXT;   -- NULL = inherit; 'none' = no audio here
ALTER TABLE cards ADD COLUMN voice TEXT;   -- NULL = inherit; 'none' = no audio here
-- settings key 'voice.ja-JP.default' is the bottom of the walk.

CREATE VIEW deck_voice_resolved AS
SELECT d.id AS deck_id,
       COALESCE(
         (SELECT a.voice
            FROM deck_ancestry an JOIN decks a ON a.id = an.ancestor_id
           WHERE an.deck_id = d.id AND a.voice IS NOT NULL
           ORDER BY an.depth
           LIMIT 1),
         (SELECT value FROM settings WHERE key = 'voice.ja-JP.default')
       ) AS voice
  FROM decks d;

CREATE VIEW card_voice_resolved AS
SELECT c.id AS card_id, c.deck_id,
       c.voice AS card_voice, dv.voice AS deck_voice,
       COALESCE(c.voice, dv.voice) AS voice
  FROM cards c JOIN deck_voice_resolved dv ON dv.deck_id = c.deck_id;
```

**The three states, and why the third is the interesting one.** Reverse needed a literal
`'inherit'` sentinel because its value was boolean, so "unset" and "off" were otherwise
indistinguishable — SPEC's whole argument. A voice *name* is self-distinguishing, so `NULL`
can safely mean inherit. But the third state is worth having anyway, and it is the direct
answer to his complaint:

| `cards.voice` | Resolves to |
|---|---|
| `NULL` — default | Whatever the deck says, walking up the tree; then `voice.ja-JP.default` |
| a voice name | That voice, regardless of deck or template |
| `'none'` | **No audio on this card**, even when the deck and the template say otherwise |

`'none'` is how you delete unwanted audio: it drops the `blob_refs` row, the trigger
decrements the refcount, and the payload becomes reclaimable. In Mochi there was no way to
express that at all.

**The template keeps its voice as the fallback,** so nothing has to be migrated: today's
`template_fields.options.voice` becomes the value seeded into `voice.ja-JP.default`, and
every existing card resolves to what it resolves to now.

### Cheap regeneration, and one non-obvious consequence

Switching a card's voice from Nanami to Keita:

1. `card_voice_resolved` now yields `ja-JP-KeitaNeural`.
2. `generationIdentity` differs in `voice` → `lookupGeneration` misses.
3. `await` the provider call, `putBlob`, then **`UPDATE blob_refs SET blob_hash = ? WHERE
   card_id = ? AND field_id = ? AND ref_key = ?`** — this is the function that must be
   written (gap 2). The `blob_refs_au` trigger does the refcount arithmetic on both sides.
4. The old Nanami blob drops to refcount 0 and appears in `blobs_unreferenced`.

**The non-obvious consequence: do NOT sweep eagerly.** If he switches to Keita, dislikes
it, and switches back, an unswept Nanami blob is a *cache hit* — free, instant, and
byte-identical to what he was drilling before. Sweeping immediately destroys exactly the
A/B comparison he has been asking for. So:

* **Give `sweepUnreferenced` an `olderThan` argument** and a `--older-than` CLI flag. The
  `created_at` index is already there for it.
* **Default the sweep to manual.** 657 MB is not urgent; a lost comparison is annoying.
* **`--dry-run` already reports `bytesReclaimed` without deleting**, so "what would I get
  back" is answerable today.

**Regenerating with accent notation is a cache miss for every word,** because the notation
changes the request. The notation therefore belongs in `blobs.options` as canonical JSON —
`{"accent":"^はし!","notation":"yomigana"}` — so that a blob records *which accent it was
asked to say*. Without that, two clips of 橋 with different contours are indistinguishable
in the database, and you cannot tell a pre-notation clip from a post-notation one. Since
`options` is already part of the identity tuple and is already canonicalised, this is free.

### Male ja-JP voices — and how to enumerate them for nothing

He imitates the voice, so register matters, and 7,403 of 8,392 ja clips are the female
Nanami (MEASURED, §5 table below).

**UNVERIFIED — from recall, do not act on this list.** Azure: `ja-JP-KeitaNeural`,
`ja-JP-DaichiNeural`, `ja-JP-NaokiNeural`. Google: `ja-JP-Standard-C`/`-D`,
`ja-JP-Wavenet-C`/`-D`, `ja-JP-Neural2-C`. **Both providers expose a free, unmetered
list endpoint, so this should be measured rather than recalled:**

```bash
# Azure -- no synthesis, no characters billed
curl -s -H "Ocp-Apim-Subscription-Key: $KEY" \
  "https://$REGION.tts.speech.microsoft.com/cognitiveservices/voices/list" |
  python -c "import json,sys;[print(v['ShortName'],v['Gender'],v.get('VoiceType')) for v in json.load(sys.stdin) if v['Locale']=='ja-JP']"

# Google -- voices.list is free
curl -s "https://texttospeech.googleapis.com/v1/voices?languageCode=ja-JP&key=$KEY" |
  python -c "import json,sys;[print(v['name'],v['ssmlGender']) for v in json.load(sys.stdin)['voices']]"
```

The harness in §6 has a `voices` subcommand that does both. **Run it before choosing** —
it costs nothing and it is the only way to get a current list.

Interesting corpus note, **MEASURED**: `ja-JP-DaichiNeural` (male) already appears on 13
clips, all from the 文法 template, whose `Output` field is configured
`{"lang":"ja-JP","voice":"ja-JP-DaichiNeural"}`. So he *did* set a male voice once,
per-template, on 12 cards. That is the workaround the memory note predicts he
under-reports — worth asking him whether he preferred it.

### The corpus, for scale

**MEASURED**, `blobs` where `kind='speech'`:

| lang | voice | clips | chars |
|---|---|--:|--:|
| ja-JP | ja-JP-NanamiNeural | 7,403 | 81,829 |
| ja-JP | *(none recorded)* | 976 | 24,785 |
| ja-JP | ja-JP-DaichiNeural | 13 | 312 |
| en-US | en-US-AIGenerate1Neural | 2,371 | 62,536 |
| en-US | *(none recorded)* | 1 | 9 |
| *(none)* | *(none recorded)* | 27 | 741 |

**ja-JP total: 8,392 clips / 106,926 characters.** Both figures reproduce the brief's
exactly. Regenerating the entire Japanese library is **107 KB of characters** — inside
Azure's 500K/month F0 tier and inside Google's 1M/month WaveNet tier, with room to do it
several times over while comparing voices. **Cost genuinely cannot decide this.**

Also MEASURED: **3,782 of 3,858** non-empty 単語+言葉 head-words already have a byte-exact
non-empty ja-JP speech blob (98.0%). Note that this is a *different* quantity from SPEC's
"3,788 of 3,860 (98.1%) are bare" — that is about bareness, this is about audio coverage.
They are close enough to be confused for one another, which is worth a sentence in SPEC.

---

## 6. The test harness

**Nothing below has been run.** No API was called during this investigation. The script
refuses to make a network request without `--go`, never prints a key, and defaults to a
dry run that shows you the exact SSML and JSON it would send.

### Experimental design, and why it is shaped this way

**One clip proves nothing.** If you synthesise 橋 with `^はし!` and it sounds right, you
have learned nothing — Azure's and Google's own frontends already predict accent, and the
clip may be right for reasons unrelated to your notation. **The test is the same word with
different notations.** If `^は!し` and `^はし!` produce audibly different audio, the
notation is being honoured. If they are identical, it is being ignored.

**The particle is not optional.** 花 and 鼻 bare are acoustically identical — SPEC says so,
and §3 measured the analyser agreeing (both `2_2`). A 平板/尾高 test on bare words is
**unfalsifiable by construction**. Every 平板/尾高 probe below carries `が`.

**Test 平板 first.** 55.2% of his vocabulary is 平板 (MEASURED, §3). The notation's most
important job is to *not* add a downstep. A provider that faithfully honours `!` but also
inserts one when you omit it is useless here.

### What each case decides

| Case | Text | Notation | Decides |
|---|---|---|---|
| `baseline-*` | 箸 / 橋 / 花 / 鼻 + が | none | **Are the existing 7,403 Nanami clips right?** Asset or liability. |
| `hashi-1` | はしが | accent 1 (箸) | Does the notation move the drop at all? |
| `hashi-2` | はしが | accent 2 (橋) | Compare against `hashi-1`: same input, different notation. |
| `hashi-0` | はしが | 平板 (端) | **Does 平板 stay flat?** The 55.2% question. |
| `hana-2` / `hana-0` | はなが | accent 2 / 平板 | The pair that is *only* distinguishable with the particle. |
| `scope-in` / `scope-out` | 橋が | `!` inside vs outside the tag | **UNVERIFIED and untested by anyone:** does a word-final `!` reach a particle outside the `<phoneme>` element? |
| `long-phonetic` / `long-ortho` | 使命が | `^し!めー` vs `^し!めい` | **Which kana spelling do they want?** See below. |
| `tilde-*` | なり / ～なり | none | The controlled duration test §3 could not do: is the placeholder voiced? |

That is **13 calls per provider**, ~50 characters. Free on both.

### One thing `cards` mode exposed, and it affects most of the deck

Running `cards --limit 20` in dry-run against the real database (**MEASURED**) shows that
`pyopenjtalk.g2p(word, kana=True)` returns the **phonetic** kana, not the orthographic
reading: 係数 → `ケースー`, 使命 → `シメー`, 気遣い → `キズカイ` (づ → ず). So the notation
comes out as `^けーす!ー`, `^し!めー`, `^きず!かい`.

**This is probably what Google wants** — their own page gives 女王 → `じょおー`, *not*
`じょーう`, i.e. the phonetic form with the elongation mark. **But Azure's own ja-JP
example writes 合成 as `ゴ'ウセ`, using ウ rather than ー**, which suggests the sapi set
wants the orthographic spelling. **UNVERIFIED, and it is not a corner case:** every
long-vowel word in the deck is affected, which is a large fraction of Sino-Japanese
vocabulary. The `long-phonetic` / `long-ortho` pair above tests it directly on one word,
for two calls, before anything is generated in bulk.

The mora arithmetic is right either way — `ー` and `っ` are moras and `split_moras` keeps
`きゅ` together, so `欲求` correctly comes out `^よっきゅー` (4 moras, 平板, no `!`). It is
only the *spelling* that is in question.

### Then, and only then, 20 real cards

`--cards 20` pulls 20 real head-words from `build/hashigo.db`, derives each with the §3
module, and synthesises them. It **hard-refuses more than 20**. He asked to start small;
the flag enforces it rather than trusting anyone to remember.

### The script

Save it as `tools/accent_probe.py`. I did not create the file: the brief restricted writes
to this document. One command extracts it:

```bash
python - <<'EXTRACT'
import re, pathlib
doc = pathlib.Path("notes/pitch-accent-pipeline.md").read_text(encoding="utf-8")
for name in ("accent.py", "accent_probe.py"):
    body = re.search(r"<!--BEGIN %s-->\n```python\n(.*?)```" % re.escape(name), doc, re.S).group(1)
    pathlib.Path("tools", name).write_text(body, encoding="utf-8", newline="\n")
    print("wrote tools/" + name)
EXTRACT
```

<!--BEGIN accent_probe.py-->
```python
#!/usr/bin/env python
"""Pitch-accent notation probe. Decides, by ear, whether Azure's sapi apostrophe
and Google's yomigana ^/! actually move the downstep in a ja-JP neural voice.

NOTHING IS SENT WITHOUT --go.  Without it this prints the exact request bodies
and exits.  Keys are read from the environment (or a .env file) by NAME ONLY and
are never printed, logged, or written to disk.

    # see what would be sent -- no network, no cost
    python tools/accent_probe.py probe --provider both

    # free, unmetered: which ja-JP voices exist, and which are male
    python tools/accent_probe.py voices --provider both --go

    # the real thing: 11 calls per provider, ~40 characters
    python tools/accent_probe.py probe --provider both --go --out build/accent-probe

    # 20 real cards from the deck.  Refuses more than 20.
    python tools/accent_probe.py cards --provider google --limit 20 --go \
        --db build/hashigo.db --out build/accent-cards

Env var names are yours; override them if .env spells them differently:
    --azure-key-env    default AZURE_SPEECH_KEY
    --azure-region-env default AZURE_SPEECH_REGION
    --google-key-env   default GOOGLE_TTS_API_KEY
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # cp932 console

HARD_CARD_CAP = 20          # he asked to start small; this enforces it


# --------------------------------------------------------------------------
# secrets: by name, never by value
# --------------------------------------------------------------------------
def load_dotenv(path: pathlib.Path) -> None:
    """Populate os.environ from .env without printing anything from it."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def secret(var: str) -> str:
    value = os.environ.get(var, "")
    if not value:
        sys.exit(
            f"missing {var}.\n"
            f"  Set it in the environment or in .env, or point at the right name with\n"
            f"  --azure-key-env / --azure-region-env / --google-key-env.\n"
            f"  This script never prints the value."
        )
    return value


# --------------------------------------------------------------------------
# notation.  Both helpers duplicated from tools/accent.py so this file runs
# standalone -- keep them in sync if you change the rule.
# --------------------------------------------------------------------------
SMALL = "ゃゅょぁぃぅぇぉャュョァィゥェォ"


def split_moras(kana: str) -> list[str]:
    out: list[str] = []
    for ch in kana:
        if ch in SMALL and out:
            out[-1] += ch
        else:
            out.append(ch)
    return out


def yomigana(reading: str, accent: int) -> str:
    """Google: ^ opens the pitch phrase, ! follows the mora carrying the drop."""
    m = split_moras(reading)
    if accent <= 0 or accent > len(m):
        return "^" + "".join(m)
    return "^" + "".join(m[:accent]) + "!" + "".join(m[accent:])


def sapi_kana(reading: str, accent: int) -> str:
    """Azure: ' = "Accent position", placed AFTER the affected syllable.
    Trailing + = "Accent boundary", reported to read the word 平板."""
    m = split_moras(reading)
    if accent <= 0 or accent > len(m):
        return "".join(m) + "+"
    return "".join(m[:accent]) + "'" + "".join(m[accent:])


# --------------------------------------------------------------------------
# the cases
# --------------------------------------------------------------------------
class Case:
    """text = what the listener should hear; word/reading/accent = the notation.
    scope 'word' wraps the word only and leaves the particle outside the tag;
    scope 'all' wraps word+particle together."""

    def __init__(self, name, text, word=None, reading=None, kata=None,
                 accent=None, scope="word", why=""):
        self.name, self.text, self.word = name, text, word
        self.reading, self.kata, self.accent = reading, kata, accent
        self.scope, self.why = scope, why

    @property
    def plain(self) -> bool:
        return self.word is None


PROBE_CASES = [
    # 1. What do the providers do UNAIDED?  Answers "asset or liability" for
    #    the 7,403 existing Nanami clips.
    Case("baseline-hashi1", "箸が", why="unaided: 箸 is 頭高(1)"),
    Case("baseline-hashi2", "橋が", why="unaided: 橋 is 尾高(2)"),
    Case("baseline-hana2",  "花が", why="unaided: 花 is 尾高(2)"),
    Case("baseline-hana0",  "鼻が", why="unaided: 鼻 is 平板(0)"),

    # 2. Same input, three notations.  THIS is the test.
    Case("hashi-1", "はしが", "はし", "はし", "ハシ", 1,
         why="drop after は -- 箸"),
    Case("hashi-2", "はしが", "はし", "はし", "ハシ", 2,
         why="drop after し, onto が -- 橋"),
    Case("hashi-0", "はしが", "はし", "はし", "ハシ", 0,
         why="NO drop -- 端.  55.2% of the deck is this case."),

    # 3. The pair that needs the particle to be audible at all.
    Case("hana-2", "はなが", "はな", "はな", "ハナ", 2, why="花"),
    Case("hana-0", "はなが", "はな", "はな", "ハナ", 0, why="鼻"),

    # 4. Does a word-final ! reach a particle OUTSIDE the tag?  Nobody has
    #    published an answer.
    Case("scope-out", "橋が", "橋", "はし", "ハシ", 2, scope="word",
         why="notation covers 橋 only; が is outside the element"),
    Case("scope-in",  "橋が", "橋が", "はしが", "ハシガ", 2, scope="all",
         why="notation covers 橋が together"),

    # 5. PHONETIC vs ORTHOGRAPHIC reading.  OpenJTalk hands back ー for long
    #    vowels (使命 -> シメー, not シメイ).  Google's 女王 -> じょおー example
    #    says they want the phonetic form; Azure's own ゴ'ウセ uses ウ, not ー.
    #    They may disagree.  UNVERIFIED, and it affects every long-vowel word.
    Case("long-phonetic", "使命が", "使命", "しめー", "シメー", 1,
         why="OpenJTalk's phonetic kana: long vowel as ー"),
    Case("long-ortho",    "使命が", "使命", "しめい", "シメイ", 1,
         why="orthographic kana: same word spelled しめい"),
]

TILDE_CASES = [
    Case("tilde-none", "なり",  why="control for the placeholder duration test"),
    Case("tilde-lead", "～なり", why="if this is longer, the ～ is being voiced"),
]


# --------------------------------------------------------------------------
# Azure
# --------------------------------------------------------------------------
AZURE_SSML = (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
    'xml:lang="ja-JP"><voice name="{voice}">{body}</voice></speak>'
)


def azure_body(case: Case, voice: str) -> str:
    if case.plain:
        body = case.text
    else:
        ph = sapi_kana(case.kata, case.accent)
        tag = f'<phoneme alphabet="sapi" ph="{ph}">{case.word}</phoneme>'
        tail = case.text[len(case.word):] if case.scope == "word" else ""
        body = tag + tail
    return AZURE_SSML.format(voice=voice, body=body)


def azure_call(ssml: str, key: str, region: str) -> bytes:
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            # 160 kbit mono mp3: what the existing corpus appears to be, so
            # byte sizes stay comparable with blobs.byte_size.
            "X-Microsoft-OutputFormat": "audio-24khz-160kbitrate-mono-mp3",
            "User-Agent": "hashigo-accent-probe",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def azure_voices(key: str, region: str) -> list[dict]:
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list",
        headers={"Ocp-Apim-Subscription-Key": key},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# --------------------------------------------------------------------------
# Google.  Path (a): SSML <phoneme alphabet="yomigana">.  Better documented
# than custom_pronunciations and where the 端/箸/橋 examples actually live.
# --------------------------------------------------------------------------
def google_payload(case: Case, voice: str) -> dict:
    if case.plain:
        inp = {"text": case.text}
    else:
        ph = yomigana(case.reading, case.accent)
        tail = case.text[len(case.word):] if case.scope == "word" else ""
        inp = {"ssml": f'<speak><phoneme alphabet="yomigana" ph="{ph}">'
                       f'{case.word}</phoneme>{tail}</speak>'}
    return {
        "input": inp,
        "voice": {"languageCode": "ja-JP", "name": voice},
        "audioConfig": {"audioEncoding": "MP3"},
    }


def google_payload_field(case: Case, voice: str) -> dict:
    """Path (b): the custom_pronunciations FIELD, for comparison.  Note the
    `pronunciations` ARRAY -- Google's own Chirp 3 HD example omits it and is
    malformed."""
    return {
        "input": {
            "text": case.text,
            "customPronunciations": {
                "pronunciations": [{
                    "phrase": case.word,
                    "phoneticEncoding": "PHONETIC_ENCODING_JAPANESE_YOMIGANA",
                    "pronunciation": yomigana(case.reading, case.accent),
                }]
            },
        },
        "voice": {"languageCode": "ja-JP", "name": voice},
        "audioConfig": {"audioEncoding": "MP3"},
    }


def google_call(payload: dict, key: str) -> bytes:
    import base64
    req = urllib.request.Request(
        f"https://texttospeech.googleapis.com/v1/text:synthesize?key={key}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return base64.b64decode(json.load(r)["audioContent"])


def google_voices(key: str) -> list[dict]:
    url = f"https://texttospeech.googleapis.com/v1/voices?languageCode=ja-JP&key={key}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)["voices"]


# --------------------------------------------------------------------------
# cards: 20 real head-words, derived with tools/accent.py
# --------------------------------------------------------------------------
def load_cards(db_path: str, limit: int) -> list[Case]:
    if limit > HARD_CARD_CAP:
        sys.exit(f"refusing --limit {limit}: the cap is {HARD_CARD_CAP}. Start small.")
    try:
        sys.path.insert(0, str(pathlib.Path(__file__).parent))
        from accent import derive          # noqa: PLC0415
        import pyopenjtalk                 # noqa: F401,PLC0415
    except ImportError as exc:
        sys.exit(f"cards mode needs tools/accent.py and pyopenjtalk(-plus): {exc}")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """SELECT v.value AS val FROM card_field_values v
             JOIN cards c ON c.id = v.card_id
             JOIN templates t ON t.id = c.template_id
            WHERE v.field_id = 'name' AND t.name = '単語'
            ORDER BY c.id"""
    ).fetchall()

    out: list[Case] = []
    for row in rows:
        word = row["val"].strip()
        if not word:
            continue
        d = derive(word)
        if not d.get("ok"):
            continue                       # guarded / multi-phrase: review by hand
        kana = pyopenjtalk.g2p(word, kana=True)
        hira = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in kana)
        out.append(Case(f"card-{len(out):02d}-{word}", word + "が", word, hira, kana,
                        d["accent_type"],
                        why=f"{d['type']}({d['accent_type']}) / {d['bare_moras']} morae"))
        if len(out) >= limit:
            break
    return out


# --------------------------------------------------------------------------
def run(cases, provider, args, outdir: pathlib.Path | None):
    azure_key = azure_region = google_key = ""
    if args.go:
        if provider in ("azure", "both"):
            azure_key = secret(args.azure_key_env)
            azure_region = secret(args.azure_region_env)
        if provider in ("google", "both"):
            google_key = secret(args.google_key_env)

    for case in cases:
        print(f"\n=== {case.name}   {case.text!r}   {case.why}")
        jobs = []
        if provider in ("azure", "both"):
            ssml = azure_body(case, args.azure_voice)
            print(f"  azure  ssml: {ssml}")
            jobs.append(("azure", ssml,
                         lambda s=ssml: azure_call(s, azure_key, azure_region)))
        if provider in ("google", "both"):
            payload = google_payload(case, args.google_voice)
            print(f"  google json: {json.dumps(payload, ensure_ascii=False)}")
            jobs.append(("google", payload,
                         lambda p=payload: google_call(p, google_key)))
            if args.google_field and not case.plain:
                pf = google_payload_field(case, args.google_voice)
                print(f"  google json (custom_pronunciations field): "
                      f"{json.dumps(pf, ensure_ascii=False)}")
                jobs.append(("google-field", pf,
                             lambda p=pf: google_call(p, google_key)))

        if not args.go:
            continue
        for tag, _, call in jobs:
            try:
                audio = call()
            except urllib.error.HTTPError as exc:
                # Read the body: both providers put the real reason there, and
                # neither body contains the key.
                print(f"  {tag}: HTTP {exc.code} {exc.read()[:400].decode('utf-8', 'replace')}")
                continue
            except Exception as exc:                       # noqa: BLE001
                print(f"  {tag}: {type(exc).__name__}: {exc}")
                continue
            path = outdir / f"{case.name}.{tag}.mp3"
            path.write_bytes(audio)
            print(f"  {tag}: {len(audio):,} bytes -> {path}")


def listen_checklist() -> None:
    print("""
LISTEN FOR, in this order:

 1. hashi-0 vs hashi-1 vs hashi-2 -- SAME input text, three notations.
    All three identical            -> the notation is IGNORED. Provider fails.
    All three different            -> honoured. Note WHICH mora drops in each.
 2. hashi-0 and hana-0 (平板).  Is there any drop at all?  There must not be.
    This is 55.2% of the deck and the single most important clip here.
 3. hana-2 vs hana-0.  Bare 花/鼻 are identical by construction, so if these
    differ, it is the particle carrying 花's drop -- which is the point.
 4. scope-out vs scope-in.  If scope-out has no drop on が, the notation must
    cover the particle, and every 尾高 request needs the particle inside it.
 5. baseline-*.  Are the UNAIDED clips right?  This is the asset-or-liability
    question for 7,403 existing Nanami clips, and four clips answer it.
 6. long-phonetic vs long-ortho.  OpenJTalk gives 使命 as シメー; the deck will
    be full of ー.  If only one of these is right, the derivation must convert.
 7. tilde-none vs tilde-lead.  Compare BYTE SIZES printed above, then listen.
    Near-equal -> the placeholder is silent.  Longer -> it is being voiced,
    and stripping it changes the audio on 21 cards.

Then, and only then, `cards --limit 20`.""")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("mode", choices=["probe", "cards", "voices"])
    p.add_argument("--provider", choices=["azure", "google", "both"], default="both")
    p.add_argument("--go", action="store_true",
                   help="actually call the API. Without this, nothing is sent.")
    p.add_argument("--out", default="build/accent-probe")
    p.add_argument("--db", default="build/hashigo.db")
    p.add_argument("--limit", type=int, default=HARD_CARD_CAP)
    p.add_argument("--azure-voice", default="ja-JP-NanamiNeural")
    p.add_argument("--google-voice", default="ja-JP-Neural2-B")
    p.add_argument("--google-field", action="store_true",
                   help="also try the custom_pronunciations FIELD, not just SSML")
    p.add_argument("--azure-key-env", default="AZURE_SPEECH_KEY")
    p.add_argument("--azure-region-env", default="AZURE_SPEECH_REGION")
    p.add_argument("--google-key-env", default="GOOGLE_TTS_API_KEY")
    p.add_argument("--env-file", default=".env")
    args = p.parse_args()

    load_dotenv(pathlib.Path(args.env_file))

    if args.mode == "voices":
        if not args.go:
            sys.exit("voices needs --go. The list endpoints are free and unmetered.")
        if args.provider in ("azure", "both"):
            print("== Azure ja-JP ==")
            for v in azure_voices(secret(args.azure_key_env),
                                  secret(args.azure_region_env)):
                if v.get("Locale") == "ja-JP":
                    print(f"  {v['ShortName']:<40} {v.get('Gender'):<8} {v.get('VoiceType')}")
        if args.provider in ("google", "both"):
            print("== Google ja-JP ==")
            for v in google_voices(secret(args.google_key_env)):
                print(f"  {v['name']:<40} {v.get('ssmlGender')}")
        return

    outdir = pathlib.Path(args.out)
    if args.go:
        outdir.mkdir(parents=True, exist_ok=True)

    if args.mode == "probe":
        cases = PROBE_CASES + TILDE_CASES
    else:
        cases = load_cards(args.db, args.limit)
        print(f"{len(cases)} cards (cap {HARD_CARD_CAP})")

    if not args.go:
        print("\nDRY RUN -- nothing sent. Add --go when you are ready.\n")

    run(cases, args.provider, args, outdir if args.go else None)

    if args.mode == "probe":
        listen_checklist()


if __name__ == "__main__":
    main()
```
<!--END accent_probe.py-->

### Reproducing §3 on this machine

```bash
python -m venv .venv-accent
.venv-accent/Scripts/python -m pip install pyopenjtalk-plus   # prebuilt wheel; no cmake
PYTHONIOENCODING=utf-8 .venv-accent/Scripts/python tools/accent.py
```

`pip install pyopenjtalk` (upstream) needs cmake and a C++ toolchain and **fails here**.

---

## §7. The long-vowel question, ANSWERED (2026-08-20, later the same day)

**The earlier attempt was an INVALID INSTRUMENT, not a null result**, and the two
are easy to confuse in a report. Both arms used `使命` — kanji — as the element
content, and Google silently ignores yomigana whenever the element contains
kanji, so both came back byte-identical. That measured the harness.

Re-run with **kana content**, `ja-JP-Neural2-C`, 4 calls, F0 by
`tools/f0.py` (which is now a committed file — the 22-call comparison that
settled Google-vs-Azure measured F0 with an ad-hoc script that was never saved,
so the most decision-changing measurement in the project was not reproducible):

| case | ssml `ph` | content | F0 thirds (Hz) | shape |
|---|---|---|--:|---|
| `long-control-0` | `^しめー` | しめー | 141.2 / 162.2 / 138.7 | no early fall — correct 平板 |
| `long-control-1` | `^し!めー` | しめー | 205.1 / 164.4 / 100.2 | steep fall — correct 頭高 |
| `long-phonetic-kana` | `^し!めー` | しめー | 205.1 / 164.4 / 100.2 | identical to the control |
| `long-ortho-kana` | `^し!めい` | しめい | 199.2 / 166.7 / 102.6 | same shape, ~3% apart |

**Three findings.**

1. **The notation IS honoured with kana content.** 205 Hz vs 141 Hz in the first
   third, same input text, notation the only difference. This also re-confirms
   the kanji trap from the other side: it is the CONTENT that disables the
   notation, not the notation itself.
2. **`ー` and `い` behave the same.** 205/164/100 against 199/167/103 — a 3%
   spread, well under the 8% threshold `tools/f0.py` uses for a downstep, and
   the durations agree to 1.3% (41,956 vs 41,394 bytes). So **the derivation does
   not need to convert OpenJTalk's phonetic ー into orthographic い.** That was
   listed as unresolved and as affecting most Sino-Japanese vocabulary; it does
   not.
3. **The pipeline is deterministic.** `long-phonetic-kana` and `long-control-1`
   are the same request and came back byte-identical, which is the free control
   on everything above.

**Basis, and its limits:** ONE word, ONE voice, 4 calls. It answers "does the
spelling of a long vowel change the contour" and nothing wider.

## §8. A SECOND dictionary: UniDic 2.3.0

The step-3 derivation rested on one analyser plus my recall, and "5 of 15
mismatched against what I remembered" is not a citation. UniDic 2.3.0 carries
`aType` — the accent nucleus, looked up rather than derived — and is
independently licensed. (UniDic 3.1.0a1's download URL is dead; 2.3.0's is live
and has the same field. `python -m unidic download` fails on Windows because it
calls `fork`, so the zip has to be fetched directly.)

It agrees on all five reference words: 橋 2 · 箸 1 · 端 0 · 花 2 · 鼻 0.

**MEASURED over 3,850 distinct normalised head-word keys:**

```
agree/exact                       2921   75.9%
agree/type-only                      5    0.1%   same label, different mora count
DISAGREE                            81    2.1%
not-comparable/multi-token         394   10.2%   aType is per-MORPHEME
not-comparable/no-atype            441   11.5%   dictionary declines to commit
ours-refused/unidic-has-answer       8    0.2%
-> of 3,007 COMPARABLE words, 2,926 agree (97.31%)
```

**Multi-token words are NOT COMPARABLE, and are counted as such rather than as
agreement.** `aType` describes a morpheme; a compound's accent comes from
`aConType` / `aModType`, and combining those correctly is its own project.
Counting 394 words as either agreeing or disagreeing would be a number without a
basis.

**UNIDIC IS STORED BUT DOES NOT RESOLVE, and that is the important design
decision here.** It would be tempting to let it answer the 8 words the probe rule
refused — but it is measurably wrong on some of exactly those: it reads **正義 as
the personal name マサヨシ**, not セイギ, and **近々 as キンキン**, not チカジカ.
A wrong accent drilled through spaced repetition is worse than none, so a
cross-check answer is a CANDIDATE for adjudication, never the resolved answer.
`accent_resolved` names its analyser priority (manual, then `openjtalk`);
`accent_disagreements` is the queue.

**The adjudication queue is 90 words** — 9 the rule refused, 81 where the two
dictionaries differ. 31 of the 81 are written in kana only (`いか`, `まく`,
`ばら`, `ぶり`, `どく`, `はえ`), where both analysers are guessing which lemma was
meant; that is genuine ambiguity rather than one of them being wrong. This is the
set for OJAD, through its own interface, driven as a person would.

## §9. The 20-card listening test measured Google, not us (2026-08-21)

Zach ran `accent_probe.py cards --limit 20 --go`, listened to all twenty, checked them
against OJAD and reported: *"it's amazing, very accurate."*

**That is a real result about a different thing.** `load_cards` built the SSML with the
KANJI headword as the element content:

```
<phoneme alphabet="yomigana" ph="^きず!かい">気遣い</phoneme>が
```

and §2 already established that **Google silently ignores yomigana whenever the element
contains kanji.** So the notation never applied, and those twenty clips were Google's
own unaided ja-JP frontend.

**What the test therefore established** — and it is worth having, it is twenty more data
points on the question §1 opened: Google's unaided frontend is accurate on twenty of his
real words. His 7,403 existing Nanami clips were never broken, and regeneration is about
the male voice and per-card override control. That was already the conclusion; this
strengthens it.

**What it did NOT establish:** that the derivation in §3 is right. And the derivation is
what feeds `<<型>>`, so the label remains unvalidated against audio.

### The inference to avoid, because it is backwards

Zach then asked whether the ~51 words OJAD does not carry are *"likely to be correct
from google tts."* When a request carries notation, **Google does not know the accent —
the notation IS the answer**, and Google renders whatever it is handed. A wrong
derivation produces a faithfully wrong contour. The unaided frontend knows; the annotated
path does not.

So there are two separate facts and only one of them is measured:

| claim | status |
|---|---|
| unaided Google is accurate on kanji-written words | **measured**, 20 words |
| our derivation is accurate | **unvalidated against audio** |

### Where this points

For a kanji-written word, Google's frontend already has the information that
disambiguates it — that is why the unaided clips are right. Annotating those may buy
little. **The notation earns its place on kana-written words and homographs**, which is
exactly the set `notes/kana-primary-words.md` is about. Worth testing on that set before
annotating 8,392 clips.

### Fixed

`--card-content` now defaults to `kana`, so the notation applies. `kanji` is kept as the
**negative control** — the honest way to hear the unaided frontend deliberately rather
than by accident. `load_cards` also normalises the head word the way `accentKey` does;
it previously fed raw values to the analyser, the same defect §3 describes.

## §10. Blind A/B, and the first validation of the derivation against audio

### The "fuzzy" impression did not survive a blind test

Zach compared the kanji-content and kana-content clip sets knowing which was which and
reported the notated arm sounded "more fuzzy", the kanji arm "more concise" — then added
*"maybe it's just me"*.

**Four gross acoustic measures over 20 paired words** (`tools/ab_clips.py`): duration
+1.5%, loudness −0.2%, voiced fraction −0.5%, robust F0 range +6.1%. Not loudness, not
length, not breathiness. Also **not** the long-vowel notation: 8 of the 20 contain `ー`
and those changed *less* than the rest (+0.25 vs +0.68 st).

**A first pass overstated the pitch figure and it was caught.** With a max/min range it
read +19.0%, with individual clips at 22–28 semitones. 12 st is exactly an octave, so
those were the tracker halving or doubling single frames; the giveaway was that the same
words showed large values in *both* arms. p10–p90 took it to +6.1%.

**Blind, 40 clips, opaque names, verdict recorded as `crisp` / `fuzzy` / `same`:**

```
           crisp   fuzzy    same
kanji         11       7       2
notated       13       6       1

of 13 clips marked FUZZY, 6 were the notated arm — 46%
one-sided binomial p = 0.709   (not distinguishable from chance)
```

Of the 12 words where the two versions got different verdicts, 5 went kanji=fuzzy and 4
went notated=fuzzy, the rest involving `same` — symmetric, which is what noise looks
like. **The impression was framing.** Which is the useful answer: the notation carries no
audible quality penalty, so it is safe to use at scale.

**But it settles the wrong half.** "Does not sound worse" is not "is correct".

### Does the audio put the downstep where the derivation said?

`tools/accent_verify.py`. For each word the derivation claims a downstep after mora N
(or none, for 平板); the clip is sliced into (moras + 1) equal parts over its voiced
frames and the largest fall between adjacent slice medians is located.

**A SYSTEMATIC +1 OFFSET, measured not assumed.** Every matching nucleus word came back
at exactly `accent + 1`: 係数 4 vs 3, 捜査 2 vs 1, 取り戻す 5 vs 4, 使命 2 vs 1, 覚える
4 vs 3, タンパク質 5 vs 4. Six for six is not noise. Two real causes: the F0 fall in
Japanese is realised late, over the transition into the following mora rather than at the
boundary; and slices are cut over VOICED frames, which excludes unvoiced consonants and
shifts every boundary rightward. The comparison now subtracts the offset and demands an
EXACT hit, rather than keeping a ±1 tolerance that silently absorbed it.

| | matched | |
|---|---|---|
| nucleus (頭高 / 中高 / 尾高) | **6 / 8** | exact, after the offset |
| 平板 | 5 / 12 | see below — this is the method, not the accent |

**The 平板 failures are the instrument.** Split by whether the reading contains a special
mora — long vowel `ー`, geminate `っ`, or moraic `ん`:

```
with a special mora   7/9 missed
all light moras       0/3 missed
```

Zero misses among all-light-mora words. Equal-width slicing assumes equal-duration
moras, and a long vowel is a single continuous F0 glide cut in half — which reads as a
fall that is really within-vowel declination. 欲求 (よっきゅー), 精巧 (せーこー), 発注
(はっちゅー), 乾燥 (かんそー), 平静 (へーせー) are all of that shape. **So this is not
evidence of wrong accents; it is a known limit of the method, and the split is clean
enough to say so.**

### What this establishes, and what is still open

**Established, for the first time:** the notation demonstrably moves the downstep to
where the derivation asks, on 6 of 8 words that have one. Combined with §7 (the notation
is honoured with kana content) and §9 (the unaided frontend is good on kanji-written
words), the annotated path is now known to work rather than assumed to.

**Two words to actually listen to:** 気遣い (derivation 中高 2, observed 3) and 覚悟
(derivation 頭高 1, observed 2). Both are all-light-mora, so the slicing should be
reliable — but both also begin with unvoiced consonants, which is exactly what perturbs
voiced-frame slicing. Too coarse to call them wrong; worth an ear.

**Still open:** 20 words, coarse slicing, and no independent ground truth for the
accents themselves beyond §8's dictionary agreement and the 33 OJAD adjudications.

## What is settled, and what is not

**Settled by this investigation**

* Azure's ja-JP `'` is documented by Microsoft as **"Accent position"**, with `+` as
  "Accent boundary", `|` as "Phrase boundary" and `_` as "one mora pause". SPEC's
  "documented as stress" is true of the *current* page and false of Microsoft's own
  Japanese reference. **SPEC draft 8 should carry this.**
* Google's `^`/`!` semantics, the 端/箸/橋 examples, the "at most one per phrase" rule, and
  the exact request shape — and that **SSML `<phoneme alphabet="yomigana">` is the better
  path** than `custom_pronunciations`.
* The bare-word problem is **solved**: probe with `が`, classify off the probed mora count,
  guard on `probed_moras != bare_moras + 1`. Validated on 箸/橋/端/花/鼻, and it reproduces
  Google's documented notation for those words exactly.
* The naive rule would emit **2,065 phantom downsteps** — 55.2% of his vocabulary.
  OpenJTalk returned 0 for **no** bare word in this corpus.
* The distribution: **平板 55.2% · 中高 23.7% · 頭高 19.7% · 尾高 1.4%**, plus 117
  multi-phrase and 5 guarded.
* The placeholders: **21** values carry one (three tilde codepoints, two ellipsis
  spellings), **all 21 were sent to Azure verbatim**, and a leading `～` changes the
  analyser's answer even though it produces no phoneme. Strip them from the analyser and
  the synthesis input; keep them in the display.
* The blob store already keys the cache on voice, so per-card voice regeneration is
  idempotent by construction. **Four concrete gaps** block it: no card/deck voice column,
  no ref drop-or-retarget API, no sweep grace period, and a synchronous
  `resolveGeneration` that cannot take an HTTP call.

**Not settled, and only a listening test settles it**

* Whether the *current* ja-JP neural voices honour the sapi apostrophe. The legend is from
  2012 and documents the concatenative engines; the total public empirical record is one
  blog post.
* Whether Azure's `+` really reads a word 平板.
* Whether Google's yomigana works on Neural2/WaveNet (path (a) is documented for SSML but
  no doc confirms yomigana per tier) and whether it works on Chirp 3 HD at all.
* Whether a word-final `!` reaches a particle outside the `<phoneme>` element.
* Whether the placeholders are audible.
* Whether the 7,403 existing Nanami clips have correct accents.
* **Which kana spelling each provider wants for long vowels** — OpenJTalk's phonetic
  `シメー` or the orthographic `シメイ`. Google's 女王 → `じょおー` example points one way,
  Azure's 合成 → `ゴ'ウセ` the other. Affects most Sino-Japanese vocabulary in the deck.

**Could not verify**

* **`pyopenjtalk-plus` is a fork** and its dictionary may differ from upstream's naist-jdic.
  Every content figure in §3 inherits that caveat. The mechanism does not.
* **The dictionary's accuracy.** 10 of 15 common words matched my recall; 5 did not
  (紙, 髪, 心, 友達, 水). My recall is not a citation and I cannot adjudicate. **Spot-check
  ~30 words against OJAD by hand before regenerating anything** — OJAD's terms permit that
  and forbid the bulk scraping that would settle it at scale.
* **Whether Google's `custom_pronunciations` field supports ja-JP at all.** Three official
  pages contradict each other; the proto still says "initial support is for en-us".
* **Google's per-1M pricing.** The official table is JS-rendered and unreadable. Only the
  free tiers (4M Standard, 1M WaveNet) are confirmed — and they swallow 106,926 characters
  whole, so it does not matter.
* **Azure's `|` and `_`.** Undocumented in current Azure material, untested by anyone.
  Potentially the highest-value find, since accent-*phrase* splitting is what broke
  TrainLCD and 117 of his own entries are multi-phrase.
* **Male voice availability.** Recalled, not measured. `accent_probe.py voices --go` is
  free and answers it.

**Two things SPEC should be corrected on**

1. Azure *does* document the accent nucleus for Japanese — §1 (this is the big one).
2. The placeholder count is basis-dependent: **21** on the basis stated in §3, against
   SPEC's 23 on an unstated basis. Three tilde codepoints are in use, including one ASCII
   `~`, and a regex written for `～` alone silently misses it. Exactly the decision-6 trap.

**One correction to this document's own brief:** blobs are addressed by
`sha256(payload bytes)`, not `sha256(normalised_text, voice, lang)`. The identity tuple is
stored *on* the row and is what `lookupGeneration` queries. `schema.sql`'s comment on
`blobs.hash` still says "identity tuple" and contradicts `src/import/blobs.ts`, which
explains at length why the bytes had to win.

---

## MEASURED — the probe was run, 2026-08-20

22 synthesis calls (11 per provider), ~40 characters, both inside free tier. Output was
switched from MP3 to 24 kHz 16-bit PCM so the F0 contour could be measured with stdlib
`wave` + numpy — this machine has no ffmpeg, and a measurable contour beats a subjective
listen. Voices: `ja-JP-NanamiNeural` (Azure), `ja-JP-Neural2-B` (Google).

### Test 1 — is the notation honoured at all? (sha256 over the returned bytes)

| Provider | Distinct clips | Collisions |
|---|--:|---|
| Azure | **15 of 15** | none |
| Google | 11 of 15 | `baseline-hashi2` == `scope-in` == `scope-out`; `long-ortho` == `long-phonetic`; `tilde-lead` == `tilde-none` |

Azure changes the audio for every notation. Google's collisions are themselves findings —
see test 3.

### Test 2 — does the drop land where the notation says? (F0, voiced span, thirds)

Same input text `はしが`, three notations. This is the decisive test.

| Case | Notation | Wanted | Azure Hz | Google Hz |
|---|---|---|--:|--:|
| `hashi-1` | `ハ'シ` / `^は!し` | 頭高 **H**-L-L | 165 → 258 → 222 | **280 → 254 → 184** |
| `hashi-2` | `ハシ'` / `^はし!` | 尾高 L-**H**-L | 175 → 262 → 252 | 203 → **307** → 216 |
| `hashi-0` | `ハシ+` / `^はし` | 平板 L-H-**H** | 172 → 250 → 255 | 197 → 269 → **256** |

**Google is correct on all three.** 頭高 starts highest of the three (280 against
197/203) and falls throughout; 尾高 rises to a 307 Hz peak then drops 91 Hz; 平板 rises
and holds, falling only 13 Hz, which is ordinary declination rather than a downstep. The
three contours separate in the *first* third — exactly where 頭高 must differ.

**Azure changes the bytes but not the accent.** Its three contours are nearly the same
shape (rise to ~250-262, then hold or fall slightly), and `hashi-1` — which must start
HIGH for 頭高 — starts at **165 Hz, the lowest of its three**. That is the opposite of the
requested pattern. The `'` does *something* (all 15 hashes differ) but it is not placing a
Japanese accent nucleus on this voice.

### Test 3 — Google's collisions, and a constraint nobody had

`scope-in` and `scope-out` came back **byte-identical to the unaided baseline**. Both put
**kanji** inside the element (`<phoneme ph="^はし!">橋</phoneme>`), where `hashi-0/1/2` put
**kana** (`はし`). So:

> **Google honours `yomigana` when the element's content is kana, and silently ignores it
> when the content is kanji.** Every request must carry the reading as content, not the
> headword.

Two consequences:

- `tilde-lead` == `tilde-none` byte-for-byte: on Google the `～` placeholder is
  **silent**. On Azure the same pair is 1.34 s against 1.72 s — **Azure voices it.**
  Affects 21 cards.
- The long-vowel question is **NOT answered**: `long-ortho` and `long-phonetic` came out
  identical because both used kanji content, so both were ignored. That test was
  invalidated, not passed. Re-run with kana content.

### Verdict

**Ship Google, SSML `<phoneme alphabet="yomigana">` on Neural2, reading as element
content.** Azure's documentation is right that `'` means "Accent position", and the
earlier SPEC correction stands — but on a current neural voice it does not produce the
pattern, which is exactly what a 2012-vintage reference could not tell us.

### Limits of this measurement, stated plainly

One voice per provider, one utterance each. The F0 tracker is my own autocorrelation
estimator, not Praat — absolute Hz may be off, though the shape *within* a clip is what
carries the argument. Azure's clips run 1.72 s for three mora with sizeable unvoiced gaps,
so its tracking is less reliable than Google's. And **nothing here has been heard by a
human**: Zach should listen to `hashi-0/1/2` for both providers and confirm the
measurement agrees with his ear before 8,392 clips are regenerated.

### MEASURED — Azure's own frontend was right all along

The probe tested whether Azure honours OUR notation. It does not. But its unaided
predictions are correct on all four minimal-pair baselines, so the 7,403 existing Nanami
clips are most likely **fine**, not a liability:

| unaided | Azure Hz | wanted |
|---|--:|---|
| 箸が 頭高 | 279 → 282 → 189 | start high, drop ✓ |
| 橋が 尾高 | 172 → 273 → 233 | rise, drop on が ✓ |
| 花が 尾高 | 185 → 259 → 217 | ✓ |
| 鼻が 平板 | 186 → 242 → 250 | rise and hold ✓ |

Zach's ear agrees with the measurement ("google sounds correct, azure's all sound the
same"). So the case for moving is **override control and the male voice**, not broken
audio. Azure's dictionary will still be wrong on rare words, proper nouns and novel
compounds — it just cannot be told so.

### MEASURED — notation fidelity varies BY VOICE inside Google

Same three notations, four voices. All four produce distinct output; only some produce
the right contours.

| Voice | 頭高 want start-high | 尾高 want rise-drop | 平板 want rise-hold | Verdict |
|---|--:|--:|--:|---|
| `ja-JP-Neural2-B` ♀ | **280** → 254 → 184 | 203 → 307 → 216 | 197 → 269 → 256 | correct |
| **`ja-JP-Neural2-C` ♂** | **174** → 154 → 104 | 118 → 177 → 114 | 117 → 152 → 139 | **correct, cleanest** |
| `ja-JP-Neural2-D` ♂ | 156 → 168 → 99 | 114 → 197 → 116 | 111 → 169 → 155 | 頭高 rises before falling |
| `ja-JP-Chirp3-HD-Charon` ♂ | 119 → 152 → 130 | **149** → 188 → 112 | 88 → 146 → 156 | **muddled — do not use** |

**Recommend `ja-JP-Neural2-C`** (Zach wants a male voice; he has been shadowing Nanami for
four years because Mochi locked the voice at template level). Its contours separate in the
first third exactly as the female reference does, and its 104-177 Hz range is a natural
male register for shadowing.

**Chirp3-HD is a trap:** newer and better-sounding, honours the notation in the weak sense
that output changes, but its 頭高 does not start high and its 尾高 starts too high. "Use
the newest tier" would have been the wrong default. Voice selection is therefore a
CORRECTNESS decision for this app, not only an aesthetic one — which is one more argument
for the per-card voice override.

### SETTLED 2026-08-20 — voice, and where annotation applies

**Voice: `ja-JP-Neural2-C`** (male). Chosen by Zach by ear after the four-voice probe,
agreeing with the F0 measurement. Chirp3-HD rejected — better-sounding, unfaithful
contours.

**Three particles, kept separate, because they are easy to conflate:**

1. **In the probe** — a measurement instrument only. Bare 尾高 and bare 平板 are
   acoustically identical (the drop lands on the following particle), so a bare-word test
   cannot discriminate. `はしが` exists so the experiment can tell honoured from ignored.
2. **In the derivation** — internal, never spoken. OpenJTalk returns mora count rather
   than `0` for 平板, so the probe particle `が` is appended to read the accent type, then
   discarded before emitting notation for the bare word. Required.
3. **In the audio** — **NO.** Zach's decision, and it holds. 単語 clips speak the bare
   word; the 51 尾高 words that bare audio cannot distinguish are carried by `<<型>>`.

**Annotate the isolated word, NOT the example sentence.** Isolated words are the hard
case — no context to disambiguate 箸 from 橋 — which is exactly why `<<Speech>>` needs the
notation. `例文` gives the engine a full sentence of context and its frontend handles that
well. Annotating sentences would mean segmenting each into accent phrases and getting
every boundary right, and the phrase-boundary heuristic was measured to fail *silently* on
`に引き換え`; 117 entries are already multi-phrase. Bad trade.

**What the notation actually buys**, stated honestly now that Azure's frontend has been
shown correct on common words: override for the cases a dictionary gets wrong (rare words,
proper nouns, novel compounds — plentiful at N1), inspectability so `<<型>>` and the audio
derive from one source and cannot silently disagree, and the male voice. It is NOT buying
correctness on common vocabulary; both frontends already had that.
