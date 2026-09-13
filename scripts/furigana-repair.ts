/**
 * Repair the furigana generations Mochi wrote wrong.
 *
 *     npx vite-node scripts/furigana-repair.ts -- --db build/hashigo.db [--apply]
 *
 * ─── WHAT IS WRONG, AND HOW IT WAS FOUND ────────────────────────────────────
 *
 * Zach, 2026-09-13, reading his own preview: *"wait... how is 至れり尽くせり read
 * actually...?"*. Auditing all 3,242 stored furigana readings against OpenJTalk
 * turned up 72 disagreements, and inside them a defect that is not a matter of
 * opinion at all: **an invisible U+200E inside the head word split it, and the
 * generator then emitted the second kanji as its own reading.**
 *
 *     準(じゅん)‎備(備)      範(はん)‎疇(疇)      面(めん)‎倒(倒)
 *
 * `備(備)` is not a reading. It renders 準備 with `備` written above `備`, which
 * teaches nothing and looks like a glitch. Five more carry the mark without that
 * consequence — `評(ひょう)‎価(か)` is correct apart from the litter.
 *
 * This is the trap `tools/accent_derive.py` documents in its own header
 * (*"準‎備 (U+200E inside) read as ジュン + ソナエ"*), sitting in the furigana data
 * rather than in the accent data.
 *
 * ─── WHY THE READINGS ARE A TABLE AND NOT A DERIVATION ──────────────────────
 *
 * Three words need a real reading supplied. They are not in dispute — じゅんび,
 * はんちゅう, めんどう — so this is an adjudicated table in the shape of the 33
 * OJAD adjudications, not an analyser run. Re-deriving would drag OpenJTalk and
 * `alignFurigana` into a script that has three rows in it.
 *
 * ─── THE BLOB IS REPLACED, NOT EDITED ───────────────────────────────────────
 *
 * Decision 4: blobs are content-addressed. Editing `bytes` under a hash that no
 * longer describes them would break that outright, so the row is REPLACED — new
 * hash, same generation identity (kind, source_text, voice, lang, options), and
 * any `blob_refs` moved across before the old row goes. That is the same shape
 * `src/accent/respeak.ts` uses, and for the same reason.
 *
 * Zach chose this over a render-time strip, 2026-09-13, knowing it edits
 * imported content: decision 9's `local` flag protects a field we ADDED and
 * cannot protect a Mochi-owned generation. A re-import would bring the broken
 * ones back — but decision 16's final import has happened, so there is no
 * re-import coming.
 */
import { arg, flag } from "../src/cli/args.js";
import { openDatabase } from "../src/db/index.js";
import { sha256Hex } from "../src/blobs/index.js";

/** Anything that is invisible and has no business inside a head word. */
const INVISIBLE = /[​‌‍‎‏﻿]/gu;

/**
 * Readings a person supplied, for the runs Mochi could not read.
 *
 * Keyed by `blobs.source_text`. The value is the whole corrected annotation, so
 * what lands in the database is reviewable here rather than assembled by a rule.
 */
const CORRECTED: ReadonlyMap<string, string> = new Map([
  // ── the U+200E casualties, 2026-09-13 ──────────────────────────────────
  ["準備", "準(じゅん)備(び)"],
  ["範疇", "範(はん)疇(ちゅう)"],
  ["面倒", "面(めん)倒(どう)"],

  // ── ADJUDICATED BY ZACH, 2026-09-14 ────────────────────────────────────
  //
  // The furigana audit produced 72 disagreements; I proposed a verdict on each
  // and he approved. These are the 24 where his stored reading was wrong plus
  // the 6 where two readings are both real and he said which the card wants.
  //
  // THE BRACKETS ARE WHOLE-WORD ON PURPOSE and that is not laziness: `readingOf`
  // flattens them to a plain reading and `alignFurigana` re-derives the run
  // split from the BASE, so `熱する(ねっする)` and `熱(ねっ)する` render the same
  // thing. Verified before writing these. The flat form is the one a person can
  // check at a glance.

  // his reading was wrong
  ["一握り", "一握り(ひとにぎり)"],
  ["一晩", "一晩(ひとばん)"],
  ["一泊", "一泊(いっぱく)"],
  ["二つ折り", "二つ折り(ふたつおり)"],
  ["保湿", "保湿(ほしつ)"],
  ["和敬清寂", "和敬清寂(わけいせいじゃく)"],
  ["後を絶たない", "後を絶たない(あとをたたない)"],
  ["敷き物", "敷き物(しきもの)"],
  ["料理人", "料理人(りょうりにん)"],
  ["日中", "日中(にっちゅう)"],
  ["時系列", "時系列(じけいれつ)"],
  ["木綿", "木綿(もめん)"],
  ["洗濯物", "洗濯物(せんたくもの)"],
  ["海の幸", "海の幸(うみのさち)"],
  ["無沙汰", "無沙汰(ぶさた)"],
  ["熱する", "熱する(ねっする)"],
  ["細工", "細工(さいく)"],
  ["至れり尽くせり", "至れり尽くせり(いたれりつくせり)"],
  ["誤答", "誤答(ごとう)"],
  ["豊胸", "豊胸(ほうきょう)"],
  ["軽んじる", "軽んじる(かろんじる)"],
  ["過ぎる", "過ぎる(すぎる)"],
  ["割る", "割る(わる)"],
  // Neither reader had this one: stored ちゃくつつみ, analyser キツツミ.
  ["着包み", "着包み(きぐるみ)"],

  // both readings real; his call on which this card means
  ["値", "値(あたい)"],
  ["大勢", "大勢(おおぜい)"],
  ["白髪", "白髪(しらが)"],
  ["宝物", "宝物(たからもの)"],
  ["腹痛", "腹痛(ふくつう)"],
  ["日本酒", "日本酒(にほんしゅ)"],
]);

interface Row {
  hash: string;
  kind: string;
  mime: string;
  source_text: string | null;
  voice: string | null;
  lang: string | null;
  options: string;
  bytes: Uint8Array;
  refcount: number;
}

const db = openDatabase(arg("db"), { readOnly: !flag("apply") });
try {
  const rows = db
    .prepare(
      `SELECT hash, kind, mime, source_text, voice, lang, options, bytes, refcount
         FROM blobs WHERE kind = 'furigana' AND bytes IS NOT NULL`,
    )
    .all() as Row[];

  const insert = db.prepare(
    `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang, options,
                        bytes, refcount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (hash) DO NOTHING`,
  );
  const retarget = db.prepare("UPDATE blob_refs SET blob_hash = ? WHERE blob_hash = ?");
  const drop = db.prepare("DELETE FROM blobs WHERE hash = ?");

  let repaired = 0;
  let stripped = 0;
  let refsMoved = 0;
  let already = 0;

  /**
   * Is this row actually broken, or merely spelled differently?
   *
   * `範疇` has TWO generations: the defective `範(はん)‎疇(疇)` and a perfectly
   * good `範疇(はんちゅう)` that annotates the whole word at once. Keying the
   * repair on the head word alone rewrote both, which is an edit to imported
   * data for no reason — and this script's whole justification is that it only
   * touches what Mochi got wrong.
   *
   * Broken means one of two things, both observable in the value itself: an
   * invisible mark, or a run whose "reading" is the very characters it annotates
   * (`備(備)`), which is the generator giving up.
   */
  const defective = (annotated: string): boolean =>
    INVISIBLE.test(annotated) || /([一-龯々]+)[（(]\1[）)]/u.test(annotated);

  for (const row of rows) {
    const before = new TextDecoder().decode(row.bytes);
    const supplied = CORRECTED.get(row.source_text ?? "");
    // AN ADJUDICATED WORD ALWAYS APPLIES; everything else is only touched when
    // the value itself shows it is broken. The table is a person's decision and
    // needs no further evidence — but a word NOT in it must not be rewritten
    // just because two analysers disagree about it. That is decision 8.
    INVISIBLE.lastIndex = 0;
    if (supplied === undefined && !defective(before)) continue;
    INVISIBLE.lastIndex = 0;
    // The supplied annotation wins; otherwise the only change is the litter.
    const after = (supplied ?? before).replace(INVISIBLE, "");
    if (after === before) continue;

    if (supplied === undefined) stripped += 1;
    else repaired += 1;
    console.log(`  ${(row.source_text ?? "").padEnd(10)} ${JSON.stringify(before)}`);
    console.log(`  ${" ".repeat(10)} ${JSON.stringify(after)}  ${supplied ? "READING SUPPLIED" : "mark stripped"}`);

    if (!flag("apply")) continue;

    const bytes = new TextEncoder().encode(after);
    const hash = sha256Hex(bytes);
    if (hash === row.hash) {
      already += 1;
      continue;
    }
    // NEW ROW FIRST, then the references, then the old row. A crash between the
    // steps must leave a spare payload rather than a reference to nothing.
    insert.run(
      hash,
      row.kind,
      row.mime,
      bytes.length,
      row.source_text,
      row.voice,
      row.lang,
      row.options,
      bytes,
      row.refcount,
    );
    refsMoved += retarget.run(hash, row.hash).changes;
    drop.run(row.hash);
  }

  console.log(
    `\n${flag("apply") ? "applied" : "would apply"}: ${repaired} reading(s) supplied · ` +
      `${stripped} invisible mark(s) stripped · ${refsMoved} reference(s) moved` +
      (already > 0 ? ` · ${already} already correct` : ""),
  );
  if (!flag("apply")) console.log("  nothing written — pass --apply");
} finally {
  db.close();
}
