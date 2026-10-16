import { describe, expect, it } from "vitest";

import { MEMORY, openDatabase, type Db } from "../src/db/index.js";
import { audibleTemplateIds, templateSpeaks } from "../src/scheduler/index.js";
import { buildSession, newTracksStartedOn } from "../src/session/index.js";

/**
 * Zach, 2026-10-16: a review he can do where he cannot speak. Every case below is
 * one a shortcut gets wrong on his real corpus — see `src/scheduler/silent.ts`.
 */
describe("templateSpeaks", () => {
  it("finds a speech field however the token is spaced", () => {
    // 単語's body writes `<< Speech >>`; a literal `<<Speech>>` search finds nothing.
    expect(templateSpeaks("<< 単語 >>\n---\n<< Speech >>", ["Speech"])).toBe(true);
    expect(templateSpeaks("<<#Audio>>x<</Audio>>", ["Audio"])).toBe(true);
  });

  it("hears an inline <speech> in a body that declares no speech field", () => {
    // 敬語: no speech FIELD, and every card sounds.
    expect(templateSpeaks('<< 言葉 >>\n___\n<speech lang="jp"><< 言葉 >></speech>', [])).toBe(true);
  });

  it("calls a body silent when its speech field is declared but never used", () => {
    expect(templateSpeaks("<< Kanji >>\n---\n<< Meaning >>", ["Audio"])).toBe(false);
  });
});

function fixture(): Db {
  const db = openDatabase(MEMORY);
  db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'deck')").run();
  const template = db.prepare("INSERT INTO templates (id, name, content) VALUES (?, ?, ?)");
  template.run("loud", "単語", "<< 単語 >>\n---\n<< Speech >>");
  template.run("quiet", "漢字", "<< Kanji >>\n---\n<draw/>");
  db.prepare(
    `INSERT INTO template_fields (template_id, id, name, type, pos, local)
     VALUES ('loud', 'sp', 'Speech', 'speech', 1, 0)`,
  ).run();
  const card = db.prepare(
    "INSERT INTO cards (id, deck_id, template_id, name, content) VALUES (?, 'd', ?, ?, ?)",
  );
  card.run("word", "loud", "word", "");
  card.run("kanji", "quiet", "kanji", "");
  card.run("plain", null, "plain", "just text");
  card.run("inline", null, "inline", '<speech lang="ja-JP">こんにちは</speech>');
  card.run("attached", null, "attached", "![clip.mp3](abc.mp3)");
  db.prepare(
    `INSERT INTO blobs (hash, kind, mime, byte_size) VALUES ('${"a".repeat(64)}', 'file', 'audio/mpeg', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO blob_refs (blob_hash, card_id, ref_key) VALUES ('${"a".repeat(64)}', 'attached', 'clip.mp3')`,
  ).run();
  // One NEW forward track each, so every card is in an unfiltered plan.
  const track = db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward')");
  for (const id of ["word", "kanji", "plain", "inline", "attached"]) track.run(id);
  return db;
}

describe("a silent session", () => {
  it("keeps only the cards nothing on can sound", () => {
    const db = fixture();
    try {
      expect(audibleTemplateIds(db as never)).toEqual(["loud"]);
      const ids = (silent: boolean) =>
        buildSession(db as never, { silent, newLimit: 50 })
          .planned()
          .map((item) => item.cardId)
          .sort();
      expect(ids(false)).toEqual(["attached", "inline", "kanji", "plain", "word"]);
      expect(ids(true)).toEqual(["kanji", "plain"]);
    } finally {
      db.close();
    }
  });
});

describe("the new-card limit is per DAY, not per plan", () => {
  // Zach, 2026-10-16: narrowing to a deck and back dealt ten new cards each time.
  const NOW = "2026-10-16T12:00:00+09:00";

  function many(): Db {
    const db = openDatabase(MEMORY);
    db.prepare("INSERT INTO decks (id, name) VALUES ('d', 'deck')").run();
    const card = db.prepare("INSERT INTO cards (id, deck_id, name) VALUES (?, 'd', ?)");
    const track = db.prepare("INSERT INTO card_tracks (card_id, kind) VALUES (?, 'forward')");
    for (let i = 0; i < 30; i++) {
      card.run(`c${i}`, `c${i}`);
      track.run(`c${i}`);
    }
    return db;
  }

  function review(db: Db, trackId: number, at: string): void {
    db.prepare(
      "INSERT INTO reviews (track_id, reviewed_at, tz_offset_minutes, remembered) VALUES (?, ?, 540, 1)",
    ).run(trackId, at);
    db.prepare("UPDATE card_tracks SET reps = reps + 1, due_at = '2026-10-20T00:00:00+09:00' WHERE id = ?").run(trackId);
  }

  it("pays for the new tracks already started today", () => {
    const db = many();
    try {
      expect(newTracksStartedOn(db as never, "2026-10-16")).toBe(0);
      expect(buildSession(db as never, { now: NOW }).progress().newCount).toBe(10);
      review(db, 1, "2026-10-16T09:00:00+09:00");
      review(db, 2, "2026-10-16T09:01:00+09:00");
      // A track first met YESTERDAY and seen again today is not a new card today.
      review(db, 3, "2026-10-15T09:00:00+09:00");
      review(db, 3, "2026-10-16T09:02:00+09:00");
      expect(newTracksStartedOn(db as never, "2026-10-16")).toBe(2);
      expect(buildSession(db as never, { now: NOW }).progress().newCount).toBe(8);
      // An explicit number is still obeyed as given.
      expect(buildSession(db as never, { now: NOW, newLimit: 10 }).progress().newCount).toBe(10);
    } finally {
      db.close();
    }
  });
});
