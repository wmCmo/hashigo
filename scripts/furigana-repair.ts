import { arg, flag } from "../src/cli/args.js";
import { openDatabase } from "../src/db/index.js";
import { sha256Hex } from "../src/blobs/index.js";

const INVISIBLE = /[​‌‍‎‏﻿]/gu;

const CORRECTED: ReadonlyMap<string, string> = new Map([
  ["準備", "準(じゅん)備(び)"],
  ["範疇", "範(はん)疇(ちゅう)"],
  ["面倒", "面(めん)倒(どう)"],

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
  ["着包み", "着包み(きぐるみ)"],

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

  const defective = (annotated: string): boolean =>
    INVISIBLE.test(annotated) || /([一-龯々]+)[（(]\1[）)]/u.test(annotated);

  for (const row of rows) {
    const before = new TextDecoder().decode(row.bytes);
    const supplied = CORRECTED.get(row.source_text ?? "");
    INVISIBLE.lastIndex = 0;
    if (supplied === undefined && !defective(before)) continue;
    INVISIBLE.lastIndex = 0;
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
