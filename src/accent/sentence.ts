/**
 * Stage 12 — the per-mora accent annotation for an EXAMPLE SENTENCE.
 *
 * Zach, 2026-09-13: *"my thought is that it will get feed from whatever we want,
 * and this time we will feed in the example sentence, which will get turned into
 * all ひらがな, and for each hiragana, if it's accented … then 開 would be in our
 * red, and if it's devoiced like しま~し~た, then し would be blue, or gray … so
 * that while reading the example sentence i can see hear how it's pronounced and
 * confirm by looking at the field"*.
 *
 * ─── WHY THIS FILE IS TYPESCRIPT AND THE ANALYSER IS NOT ────────────────────
 *
 * `src/accent/README.md` draws the line and `tools/accent_derive.py` repeats it:
 * Python owns the analyser and NOTHING else, because reading authored values in
 * Python mis-read his vocabulary (`[[参考|UQB66cP2]]`, U+200E inside 準備). The
 * text transform belongs here, next to the schema it has to satisfy. So the
 * cleaning below and the notation below are the two things BOTH sides agree on,
 * and Python is handed strings it never had to interpret.
 *
 * ─── THE NOTATION, AND WHY IT IS A STRING AND NOT A TABLE ───────────────────
 *
 *     わたしわ|かれーを|たべ*るときに|い*つも|おなかが|おどりま*す_
 *
 *   `|`  accent-phrase boundary
 *   `*`  the pitch DROPS AFTER this mora — the accent head, OJAD's convention
 *   `_`  this mora is devoiced
 *
 * A table would mean a schema bump, and decision 41 made that expensive: the
 * final import has happened, so `rm` + re-import is no longer a lossless reset.
 * `型` already solved this shape — a `local = 1` field whose value is
 * MATERIALISED — and the schema's own comment says why that was chosen in stage
 * 1: *"a feature whose storage is retrofitted later means a migration over 7,716
 * cards"*. One string per card, in a column that already exists.
 *
 * It is also readable in the editor, which a packed binary would not be. He can
 * see that `おなかが` carries no mark and know that means 平板 rather than
 * "nothing was derived" — the same property `型` has.
 *
 * ─── 平板 IS `accent == morae`, NOT `accent == 0` ───────────────────────────
 *
 * Recorded here because it has now bitten this project twice with the same
 * shape. `CLAUDE.md`: *"the naive `if accent > 0` rule fires on 100% of his bare
 * words and would drill 2,065 phantom 尾高"*. Measured again at sentence scale
 * before writing this file:
 *
 *     鼻が  (3, 3)   accent on the LAST mora  -> 平板, no drop, NO MARK
 *     花が  (3, 2)   accent strictly inside   -> 尾高, drops after な
 *     私は  (4, 4)   -> 平板
 *
 * Marking the last mora painted 21.1% of all morae; the correct rule gives
 * 13.9%. The wrong version looks completely plausible on screen, which is the
 * whole danger — and it is `notes/pitch-accent-pipeline.md`'s reason for the
 * probe particle, arriving in a place where no probe is possible.
 *
 * **The upside is real and is the reason this field is worth having.** Decision
 * 27 says 平板 and 尾高 are physically indistinguishable inside a bare word, so
 * `型` is their sole carrier on 2,148 cards. In a SENTENCE the particle is
 * already inside the accent phrase, so the two separate — `花が` marks な and
 * `鼻が` marks nothing. This field shows him something the word audio cannot.
 */

/**
 * The local field the annotation is materialised into. Decision 9 protects it
 * from `pruneFieldValues` at the next import.
 *
 * IT LIVES IN THIS FILE AND NOT IN `./marks.ts` BECAUSE OF THE IMPORT GRAPH.
 * `src/review/mount.ts` needs the id to read the value, and it ships to the
 * browser; `./marks.ts` pulls in `loadCard` and `src/generate`, which would drag
 * the whole card loader into the app bundle. `test/browser-portable.test.ts`
 * walks that graph, so this is enforced rather than remembered.
 */
export const MARKS_FIELD = {
  id: "ojad",
  name: "OJAD",
  type: "plain",
} as const;

/** One mora of the annotation. */
export interface Mora {
  /** The kana, small kana already attached — `きょ` is one mora, not two. */
  readonly kana: string;
  /** The pitch drops AFTER this mora. At most one per accent phrase. */
  readonly head: boolean;
  /** The vowel is devoiced. */
  readonly devoiced: boolean;
}

/** One accent phrase: the unit that carries at most one drop. */
export interface Phrase {
  readonly morae: readonly Mora[];
}

export class AnnotationError extends Error {
  constructor(value: string, why: string) {
    super(`not a usable accent annotation: ${JSON.stringify(value.slice(0, 40))} — ${why}`);
    this.name = "AnnotationError";
  }
}

const PHRASE = "|";
const HEAD = "*";
const DEVOICED = "_";
/** Small kana attach to the mora before them. Same set as `tools/accent.py`. */
const SMALL = "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ";
/** Kana, the long mark, and the sokuon. Anything else is not part of a reading. */
const READING_CHAR = /^[ぁ-ゖァ-ヺー]$/;

/**
 * Katakana to hiragana. He asked for *"all ひらがな"*.
 *
 * `ー` IS LEFT ALONE, and that is not an oversight. It has no hiragana form, and
 * turning `けーき` into `けいき` would need the ORIGINAL spelling — which the
 * analyser does not return, because OpenJTalk gives a reading and not an
 * orthography. It is also the mora-accurate form: `ケー` is two morae and `ー`
 * says so, where a guessed `い` would be one kana pretending to be one mora.
 */
export function toHiragana(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

/**
 * Split a reading into morae, attaching small kana to the mora before them.
 *
 * A leading small kana keeps its own mora rather than being dropped: it is
 * malformed input, and losing a character silently would shift every mark after
 * it — the exact failure this whole module is careful about.
 */
export function splitMorae(reading: string): string[] {
  const out: string[] = [];
  for (const ch of reading) {
    if (SMALL.includes(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/**
 * The Japanese sentence alone, or `null` when there is not one.
 *
 * ─── THE INPUT IS DIRTY, MEASURED ───────────────────────────────────────────
 *
 * Over all 6,503 stored 例文 generations:
 *
 *     5,712  87.8%  clean as authored
 *       556   8.5%  latin still present after this function has done its best
 *       160   2.5%  a latin parenthetical, stripped here
 *        63   1.0%  no Japanese at all
 *
 * The prompt ends *(Don't translate)* and the model translated anyway, in two
 * shapes: a trailing `(Watashi ni wa himitsu ga …)` romaji gloss, and a
 * `(Translation: …)` aside. **OpenJTalk reads latin letters out one at a time**,
 * so an unstripped gloss does not fail — it appends `ティー アール エー エヌ …`
 * to the reading and every mark after the sentence lands on a letter name.
 * Stripping the parenthetical is therefore still right and still happens below.
 *
 * ─── BUT THE BLANKET LATIN REFUSAL WAS BOTH WRONG AND REDUNDANT ─────────────
 *
 * Zach, 2026-09-17, over a 風潮 card on his phone: *"somehow ojad field is not
 * here..."*. It was not there because this returned null, and it returned null
 * because the sentence contains `SNS`.
 *
 * **Every one of the ten sentences this rule was refusing is a legitimate
 * Japanese sentence carrying a loan acronym**, not an English gloss:
 *
 *     主流 K-pop · お揃い Tシャツ · 風潮 SNS · 晒す SNS · 略称「ABC」
 *     輸出 CSV · 発信 SNS · 略語 SNS · 木綿 Tシャツ · 変換 PDF
 *
 * Reading those out one letter at a time is not the failure — **it is the
 * correct reading**. Measured through `tools/accent_sentence.py`: `SNS` ->
 * `えすえぬえ*す`, `PDF` -> `ぴーでぃーえふ`, `ABC` -> `えいびーし*ー`, `Tシャツ`
 * -> `てぃーしゃつ`. All annotate cleanly.
 *
 * **And the case this was guarding is caught by something better.** The analyser
 * counts its own kana morae against the label count and refuses on a mismatch,
 * with the numbers in the message. Fed the woven gloss it says
 * `ok: false, "53 kana morae vs 65 from labels"` — on its own, without this
 * rule. `K-pop` fails there too (`28 vs 30`, the hyphen), which is the right
 * outcome reached by a check that can SEE the problem rather than by a proxy
 * that cannot tell an acronym from a translation.
 *
 * So the refusal moved to where the evidence is. A sentence with latin in it now
 * reaches the analyser, and the analyser decides — decision 8's shape again: a
 * wrong annotation drilled is worse than none, and the mora count is what knows.
 */
export function cleanSentence(generated: string): string | null {
  const line = generated
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => /[぀-ヿ㐀-鿿]/.test(candidate));
  if (line === undefined) return null;

  // A parenthetical holding latin is a gloss, not part of the sentence. Both
  // bracket widths, because the model mixes them within one corpus.
  let text = line.replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/g, "");
  // Quote furniture around the whole line. Only when it wraps the ENTIRE thing —
  // 「」 inside a sentence is dialogue and belongs to the reading.
  const wrapped = /^[「『"'](.*)[」』"']$/s.exec(text.trim());
  if (wrapped?.[1] !== undefined) text = wrapped[1];
  text = text.trim();

  if (text === "") return null;
  // NO BLANKET LATIN REFUSAL — see above. The analyser's own mora-count check is
  // the guard, and it can tell `SNS` from a romaji translation. This one could not.
  return text;
}

/** Render morae and phrases to the stored notation. */
export function formatAnnotation(phrases: readonly Phrase[]): string {
  return phrases
    .map((phrase) =>
      phrase.morae
        .map((mora) => mora.kana + (mora.head ? HEAD : "") + (mora.devoiced ? DEVOICED : ""))
        .join(""),
    )
    .join(PHRASE);
}

/**
 * Parse the stored notation back into phrases.
 *
 * STRICT, because this is read at RENDER time on his phone and a malformed value
 * must not paint a plausible wrong contour. Every refusal names what it saw.
 */
export function parseAnnotation(value: string): Phrase[] {
  if (value === "") return [];
  const phrases: Phrase[] = [];
  for (const chunk of value.split(PHRASE)) {
    const morae: Mora[] = [];
    for (const ch of chunk) {
      if (ch === HEAD || ch === DEVOICED) {
        const last = morae[morae.length - 1];
        if (last === undefined) throw new AnnotationError(value, `${ch} before any mora`);
        if (ch === HEAD) {
          if (last.head) throw new AnnotationError(value, "the same mora marked twice");
          morae[morae.length - 1] = { ...last, head: true };
        } else {
          if (last.devoiced) throw new AnnotationError(value, "devoiced marked twice");
          morae[morae.length - 1] = { ...last, devoiced: true };
        }
        continue;
      }
      if (SMALL.includes(ch) && morae.length > 0) {
        const last = morae[morae.length - 1]!;
        // A small kana after a mark belongs to a mora that is already closed;
        // appending it would move the kana past its own mark in the string.
        if (last.head || last.devoiced) {
          throw new AnnotationError(value, "a small kana follows a mark");
        }
        morae[morae.length - 1] = { ...last, kana: last.kana + ch };
        continue;
      }
      if (!READING_CHAR.test(ch)) throw new AnnotationError(value, `${JSON.stringify(ch)} is not kana`);
      morae.push({ kana: ch, head: false, devoiced: false });
    }
    if (morae.length === 0) throw new AnnotationError(value, "an empty accent phrase");
    // AT MOST ONE DROP PER PHRASE is the definition of an accent phrase, not a
    // style rule — Google's own notation says the same thing about `!`. Two would
    // mean the phrase boundaries were wrong upstream, which is worth a refusal
    // rather than a second red kana.
    if (morae.filter((mora) => mora.head).length > 1) {
      throw new AnnotationError(value, "two drops in one accent phrase");
    }
    phrases.push({ morae });
  }
  return phrases;
}

/** Every mora in order, phrase boundaries dropped. Handy for tests and counts. */
export function flatten(phrases: readonly Phrase[]): Mora[] {
  return phrases.flatMap((phrase) => [...phrase.morae]);
}

/**
 * ─── READING OVERRIDES: WHERE THE ANALYSER READS THE WRONG WORD ─────────────
 *
 * Zach, 2026-09-13, reading his own preview: *"wait... how is 至れり尽くせり read
 * actually...?"* — and he was right to stop. The annotation said
 * いたれり**ことごとく**せり. The correct reading is いたれりつくせり.
 *
 * **THIS IS A WORSE CLASS OF ERROR THAN A WRONG ACCENT**, and it is the reason
 * this table exists at all. A wrong accent teaches the wrong pitch on a word he
 * knows; a wrong reading teaches the wrong word. Decision 8 — *"a wrong accent
 * drilled is worse than no accent"* — applies with more force, not less.
 *
 * ─── WHY AN OVERRIDE LIST AND NOT A CROSS-CHECK GATE ───────────────────────
 *
 * The obvious move was decision 8's own method: run UniDic over the same
 * sentences and show marks only where the two analysers agree. **Measured, and
 * it is the wrong tool here.** Over the 3,684 sentences without digits they
 * disagree on **20.8%** — but the disagreements are dominated by legitimate
 * variants where OpenJTalk is the MORE context-aware of the two:
 *
 *     40  明日   unidic アス     (openjtalk アシタ — both correct)
 *     36  日本   unidic ニッポン  (openjtalk ニホン — both correct)
 *     13  行っ   unidic オコナッ  (openjtalk イッ — openjtalk is right here)
 *
 * Gating on agreement would discard a fifth of the corpus to fix a handful of
 * cards. And the handful really is a handful: 至れり尽くせり appears in **one**
 * sentence of 3,712, 正時 in **one**.
 *
 * So this is the same shape as the 33 hand-entered OJAD adjudications and the 13
 * `読み` rows — a short list of known-wrong cases, adjudicated by a person,
 * beating the derivation. It is expected to grow slowly and by hand.
 *
 * ─── THE SUBSTITUTION IS KANA, AND IT ONLY TOUCHES THE ANALYSER'S INPUT ────
 *
 * Replacing 至れり尽くせり with いたれりつくせり BEFORE analysis fixes both the
 * reading and the accent phrasing, because OpenJTalk reads kana as written:
 *
 *     as authored    …サービスモイタレリコトゴトクセリデ…
 *     with override  …サービスモイタレリツクセリデ…
 *
 * **The card is untouched.** The sentence on screen comes from the `例文` field
 * and still shows its kanji; only the reading line below it changes. That is the
 * same trick decision 10 already uses for head words, where *"an explicit 読み
 * beats the head word as generator input"*.
 *
 * **WHAT AN OVERRIDE DOES NOT FIX: the accent PHRASING.** 至れり尽くせり comes
 * out as three phrases with three drops — `いた*れり|つ*く_|せり*で` — because the
 * analyser does not know the idiom whichever way it is spelled (tested: kana
 * throughout and kanji-plus-kana give byte-identical output). So the override
 * repairs the worse error and leaves the lesser one: the WORD is now right, and
 * its contour is a guess. That is the correct order to fix them in — a wrong
 * reading teaches the wrong word — but it is not a complete repair and should
 * not be described as one.
 */
export const READING_OVERRIDES: ReadonlyMap<string, string> = new Map([
  // 尽くせり alone reads ツクセリ; the trailing で re-splits it into 尽く
  // (ことごとく) + せり. A one-character context flip, reproducible.
  ["至れり尽くせり", "いたれりつくせり"],
  // 正時 alone reads マサトキ. 毎正時 is まいしょうじ.
  ["毎正時", "まいしょうじ"],

  // ─── 2026-09-13: THE KEYS ARE LONGER THAN THE WORD, ON PURPOSE ────────────
  //
  // A furigana audit turned up ~15 words OpenJTalk reads wrong IN ISOLATION,
  // and Zach asked for all of them. Checked in his actual sentences first, and
  // the premise mostly does not hold: given context the analyser is usually
  // right, and a blanket override would have BROKEN correct readings.
  //
  //     種   種類 シュルイ · 人種 ジンシュ · 接種 セッシュ   all correct
  //     値   値段 ネダン · 価値 カチ                        all correct
  //
  // `種 -> たね` would have produced たね類, 人たね, 接たね. Two more (一様, 大勢)
  // were an artifact of the audit's own long-vowel folding — `イチヨー` and
  // `オーゼー` ARE いちよう and おおぜい.
  //
  // **怒り is the case that decided the shape of this table.** Four sentences
  // read オコリ where いかり is right — and `彼女の怒りっぷり` reads オコリップリ,
  // which is CORRECT. A key of `怒り` would have broken it. So a key carries
  // enough of its neighbourhood to be unambiguous, and `applyReadingOverrides`
  // sorts longest-first so a longer key always wins over a shorter one.
  ["怒りは", "いかりは"],
  ["怒りに任せて", "いかりに任せて"],
  // 否 alone is ヒ; か否か is かいなか, and the string is specific enough to be
  // its own key.
  ["か否か", "かいなか"],
  // 2026-10-31, from Zach on 殉職's reading line (`す_けよ*ーとし_て`): OpenJTalk
  // reads the VOLITIONAL 助けよう as すけよう, in every context tried. 助ける
  // (`たす_け*る`) and 助けて (`たす*けて`) read right, so the key is the
  // volitional itself — there is no word in which 助けよう is すけよう.
  ["助けよう", "たすけよう"],
]);

/**
 * Apply the overrides to a sentence on its way to the analyser.
 *
 * LONGEST FIRST, so a table that later holds both 尽くせり and 至れり尽くせり
 * cannot have the shorter one eat the longer one's prefix and leave a fragment.
 */
export function applyReadingOverrides(sentence: string): string {
  let text = sentence;
  const phrases = [...READING_OVERRIDES.keys()].sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    text = text.split(phrase).join(READING_OVERRIDES.get(phrase) ?? phrase);
  }
  return text;
}
