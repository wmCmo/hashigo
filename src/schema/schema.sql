-- Hashigo schema, stage 1.  Authority: SPEC.html (build spec, draft 3).
--
-- SPEC.html "Feature requests" states that six requests each have a schema half
-- that must land now, because a feature whose storage is retrofitted later is a
-- migration over 7,716 cards and 102,020 reviews.  Those halves are:
--
--   review timestamps  -> reviews.reviewed_at + tz_offset_minutes + time_unknown
--   hierarchical tags  -> tags, materialised paths with every prefix present
--   @ card reference   -> card_links, unresolved targets representable
--   Ctrl+K search      -> card_fts, FTS5 with the *trigram* tokeniser
--   live analytics     -> views.sql (the aggregate shape)
--   dashboard          -> none; read-only over the above
--
-- Conventions
--   * ids are TEXT and are Mochi's own ids where one exists.  cards additionally
--     carry an INTEGER PRIMARY KEY seq, because FTS5 needs a rowid that VACUUM
--     will not renumber.
--   * instants are TEXT, RFC 3339.  created_at/updated_at are UTC (...Z);
--     reviews.reviewed_at keeps the authoring offset (see below).
--   * booleans are INTEGER 0/1 with a CHECK.  SQLite has no BOOLEAN.
--   * Japanese deck / template / field names are identifiers, never translated.
--     See CLAUDE.md.
--   * updated_at is written by the caller, not by a trigger: sync is field-level
--     last-write-wins, so the writer owns the clock.

-- ---------------------------------------------------------------------------
-- settings -- workspace scope.  Holds the defaults that the three-state
-- inherit/on/off resolution bottoms out in.  SPEC: "workspace default off".
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO settings (key, value) VALUES
  ('reverse.default',          'off'),   -- SPEC: reverse-review resolution table
  ('target_retention.default', '0.90'),  -- SPEC: FSRS default; per-deck override
  ('timezone.default',         'Asia/Tokyo');

-- ---------------------------------------------------------------------------
-- decks -- nested via parent_id.  Three-state reverse, and per-deck target
-- retention, "since 漢字 and 基本情報 have different stakes".
-- ---------------------------------------------------------------------------
CREATE TABLE decks (
  id                  TEXT PRIMARY KEY,
  parent_id           TEXT REFERENCES decks (id) ON DELETE RESTRICT,
  name                TEXT NOT NULL,
  -- inherit resolves up the tree, bottoming out at settings 'reverse.default'.
  reverse             TEXT NOT NULL DEFAULT 'inherit'
                        CHECK (reverse IN ('inherit', 'on', 'off')),
  target_retention    REAL CHECK (target_retention IS NULL
                        OR (target_retention > 0.5 AND target_retention < 1.0)),
  default_template_id TEXT REFERENCES templates (id) ON DELETE SET NULL,
  archived            INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  pos                 TEXT NOT NULL DEFAULT '',   -- lexicographic sort key
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX decks_parent ON decks (parent_id, pos);

-- ---------------------------------------------------------------------------
-- templates -- an ordered list of sides, not a front/back pair.  単語 and 漢字
-- run to four sides.  Forward is the authored order; reverse is a declared
-- permutation, NULL meaning "the authored order reversed", which reproduces
-- Mochi's behaviour exactly while leaving any one template an escape hatch.
-- ---------------------------------------------------------------------------
CREATE TABLE templates (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  content             TEXT NOT NULL DEFAULT '',  -- body; '---' separates sides
  -- JSON array of 0-based side indices, e.g. '[3,0,1,2]'.  NULL = reversed.
  reverse_permutation TEXT,
  pos                 TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- template_fields -- typed fields with a source pointer, options and position.
--
-- source_field_id is Mochi's `source` pointer and is nullable on purpose: 例文
-- is an ai field whose source is null because its dependency is named only
-- inside its prompt text ("Example sentence using <<単語>>").  The generation
-- DAG resolver must therefore also parse <<field>> out of options.prompt, or it
-- builds an incomplete graph and generates in the wrong order.
-- ---------------------------------------------------------------------------
CREATE TABLE template_fields (
  template_id     TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  id              TEXT NOT NULL,              -- Mochi field id, unique per template
  name            TEXT NOT NULL,              -- 単語, 例文, Kanji ... an identifier
  -- Mochi omits `type` on plain fields entirely: only 27 of the 49 fields across
  -- the 11 templates carry one.  The importer defaults the absent case to
  -- 'plain' rather than letting NULL mean two different things.
  type            TEXT NOT NULL CHECK (type IN (
                    'plain', 'text', 'boolean', 'number',
                    'speech', 'ai', 'translate', 'furigana',
                    'dictionary', 'image-search')),
  source_field_id TEXT,                       -- input field; NULL is legitimate
  options         TEXT NOT NULL DEFAULT '{}', -- JSON: voice, lang (BCP-47), prompt, from, to
  pos             TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (template_id, id),
  FOREIGN KEY (template_id, source_field_id)
    REFERENCES template_fields (template_id, id) ON DELETE SET NULL,
  CHECK (source_field_id IS NULL OR source_field_id <> id)
);

CREATE INDEX template_fields_pos    ON template_fields (template_id, pos);
CREATE INDEX template_fields_source ON template_fields (template_id, source_field_id);

-- ---------------------------------------------------------------------------
-- cards.  content is '' on templated cards (the real text lives in
-- card_field_values) and non-empty on the 1,140 template-less cards that define
-- their own sides with '---'.  Any scan that reads only content sees nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE cards (
  seq            INTEGER PRIMARY KEY,         -- FTS5 docid; stable across VACUUM
  id             TEXT NOT NULL UNIQUE,        -- Mochi card id; the sync identity
  deck_id        TEXT NOT NULL REFERENCES decks (id) ON DELETE RESTRICT,
  template_id    TEXT REFERENCES templates (id) ON DELETE SET NULL,
  name           TEXT NOT NULL DEFAULT '',    -- display title; indexed for Ctrl+K and @
  content        TEXT NOT NULL DEFAULT '',
  reverse        TEXT NOT NULL DEFAULT 'inherit'
                   CHECK (reverse IN ('inherit', 'on', 'off')),
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived       INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  needs_rereview INTEGER NOT NULL DEFAULT 0 CHECK (needs_rereview IN (0, 1)),
  pos            TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX cards_deck     ON cards (deck_id, pos);
CREATE INDEX cards_template ON cards (template_id);
CREATE INDEX cards_updated  ON cards (updated_at);
CREATE INDEX cards_pinned   ON cards (deck_id) WHERE pinned = 1;
CREATE INDEX cards_rereview ON cards (deck_id) WHERE needs_rereview = 1;

-- card_field_values -- kept verbatim, and deliberately NOT foreign-keyed to
-- template_fields: a value must survive its field being deleted from the
-- template or the card being moved to another template.  Losing four years of
-- authored text is worse than an orphan row.  Resolve display through
-- template_fields at read time.
CREATE TABLE card_field_values (
  card_id  TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  field_id TEXT NOT NULL,
  value    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (card_id, field_id)
);

CREATE INDEX card_field_values_field ON card_field_values (field_id);

-- ---------------------------------------------------------------------------
-- REVIEW TRACKS, not review lists.  SPEC's "single most important structural
-- finding": Mochi's reverse-reviews is a fully independent schedule with its
-- own intervals and durations.  A card therefore has N tracks, each separately
-- scheduled, and Mochi's three parallel arrays (reviews / reverse-reviews /
-- cloze/reviews) all map onto this one concept.
--
-- dormant = retained, not scheduled.  Setting a card's reverse to 'off' must
-- never destroy history, so the track stays and merely stops being scheduled.
-- SPEC: "No scheduling toggle should ever destroy four years of history."
-- ---------------------------------------------------------------------------
CREATE TABLE card_tracks (
  id               INTEGER PRIMARY KEY,
  card_id          TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  -- 'forward' | 'reverse' | 'cloze:<n>'
  kind             TEXT NOT NULL CHECK (kind IN ('forward', 'reverse')
                     OR kind GLOB 'cloze:[0-9]*'),
  dormant          INTEGER NOT NULL DEFAULT 0 CHECK (dormant IN (0, 1)),
  -- Leech flag, per track and not per card, because that is where the export
  -- actually keeps it: needs-rereview? (8 cards), reverse/needs-rereview? (24)
  -- and cloze/needs-rereview? (24) are three parallel flags mirroring the three
  -- review arrays.  cards.needs_rereview stays as the card-level UI flag.
  needs_rereview   INTEGER NOT NULL DEFAULT 0 CHECK (needs_rereview IN (0, 1)),
  -- Scheduler state.  The algorithm is chosen by backtest at stage 5, so only
  -- the algorithm-independent columns are named here; anything specific lives
  -- in scheduler_state as JSON.  SPEC derives `new?` from an empty track rather
  -- than storing it, so due_at IS NULL AND reps = 0 means new.
  due_at           TEXT,
  interval_days    REAL,
  reps             INTEGER NOT NULL DEFAULT 0,
  lapses           INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  scheduler        TEXT,                       -- 'fsrs6' | 'sm2' | ...
  scheduler_state  TEXT,                       -- JSON: stability, difficulty, ...
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (card_id, kind)
);

CREATE INDEX card_tracks_due ON card_tracks (due_at) WHERE dormant = 0;

-- ---------------------------------------------------------------------------
-- reviews -- append-only, per track.  Merges by set union, so sync can never
-- conflict.  Append-only is enforced by the trigger below.
--
-- THE TIMESTAMP DECISION (SPEC: "the one that cannot wait").  All 102,020
-- imported reviews carry 15:00:00Z, exactly midnight JST, because Mochi
-- truncates to the date.  There is not one genuine time-of-day value in four
-- years of history and it is unrecoverable.  So:
--   reviewed_at        full instant, RFC 3339 WITH offset
--                      ('2026-08-19T23:14:05+09:00').  A 23:00 review in Tokyo
--                      and a 23:00 review abroad are different facts.
--   tz_offset_minutes  that offset in minutes east of UTC (+540 = JST), so
--                      local wall-clock time is queryable without re-parsing.
--   time_unknown       1 on every imported row.  Without it every time-of-day
--                      chart grows a false spike at 00:00 and the analysis is
--                      poisoned by its own migration.  views.sql returns NULL
--                      for local_hour whenever this flag is set.
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id                 INTEGER PRIMARY KEY,
  track_id           INTEGER NOT NULL REFERENCES card_tracks (id) ON DELETE CASCADE,
  reviewed_at        TEXT NOT NULL,
  tz_offset_minutes  INTEGER NOT NULL DEFAULT 0
                       CHECK (tz_offset_minutes BETWEEN -1080 AND 1080),
  time_unknown       INTEGER NOT NULL DEFAULT 0 CHECK (time_unknown IN (0, 1)),
  remembered         INTEGER NOT NULL CHECK (remembered IN (0, 1)),
  -- Mochi records only remembered?.  grade is for schedulers that want the 1-4
  -- scale; NULL means "only the boolean is known", which is all of history.
  grade              INTEGER CHECK (grade IS NULL OR grade BETWEEN 1 AND 4),
  -- interval_days is the interval that PRECEDED this review, which is what the
  -- backtest scores predicted recall against.  Mochi does NOT store it: its
  -- `interval` field (93,076 of 102,020 rows, in days) equals due - date, i.e.
  -- the interval chosen AFTER the review -- verified against the export, 2,214
  -- of 2,233 in 基本情報 match due-date exactly and none match the preceding
  -- gap.  So the importer carries Mochi's value into next_interval_days and
  -- derives interval_days from the previous review of the same track.  Reading
  -- Mochi's `interval` as the preceding one shifts the whole backtest by one
  -- review.  Measured consequence, loaded from the real corpus: next intervals
  -- reach 2,707 days but no review in four years FOLLOWS an interval longer
  -- than 365 days -- all 1,356 of those were scheduled after 2026-02 and fall
  -- due 2027-2033, so they are pending, not capped.  The backtest therefore has
  -- zero observations of recall beyond one year, which is the sharp edge of
  -- SPEC's selection-bias caveat.
  interval_days      REAL,
  next_interval_days REAL,                     -- Mochi `interval` == due - date, in days
  due_at             TEXT,                     -- Mochi `due`: when this review scheduled the next
  duration_ms        INTEGER,                  -- Mochi `duration` is SECONDS; x1000 on import
                                               -- (present on 92,106 of 102,020)
  rereview           INTEGER NOT NULL DEFAULT 0 CHECK (rereview IN (0, 1)),
  source             TEXT NOT NULL DEFAULT 'local'
                       CHECK (source IN ('mochi', 'local')),
  -- Stable key derived from the export position (card id + track + array index)
  -- so re-importing is idempotent.  Date-only timestamps mean two reviews of
  -- one track can share reviewed_at exactly, so this cannot be a natural key.
  import_key         TEXT UNIQUE,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX reviews_track ON reviews (track_id, reviewed_at);
CREATE INDEX reviews_when  ON reviews (reviewed_at);

CREATE TRIGGER reviews_append_only BEFORE UPDATE ON reviews
BEGIN
  SELECT RAISE(ABORT,
    'reviews is append-only: insert a correcting row, never rewrite history');
END;

-- ---------------------------------------------------------------------------
-- tags -- MATERIALISED PATHS.  Store the full 'Dialect/Kansai' string; every
-- prefix must exist as its own row, which the parent_path foreign key enforces.
-- The sidebar tree is then one indexed query on parent_path, and the subtree of
-- a tag is `path = ? OR path GLOB ? || '/*'`, which the primary key serves as a
-- range scan.  Dialect/Kansai/Osaka works the day it is typed: no migration.
--
-- The CHECK makes the path/parent/name triple impossible to corrupt.
-- Normalisation is the importer's job (NFKC, strip zero-width and format
-- characters, trim, then merge collisions): five tags in the export carry a
-- leading U+200B and split four tags into invisible duplicate pairs, so 23 raw
-- tags become 19 real ones.
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  path        TEXT PRIMARY KEY,
  parent_path TEXT REFERENCES tags (path) ON DELETE RESTRICT,
  name        TEXT NOT NULL,                   -- last segment
  depth       INTEGER GENERATED ALWAYS AS
                (length(path) - length(replace(path, '/', ''))) STORED,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (path = COALESCE(parent_path || '/', '') || name),
  CHECK (name <> '' AND instr(name, '/') = 0)
);

CREATE INDEX tags_parent ON tags (parent_path, name);

CREATE TABLE card_tags (
  card_id  TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  tag_path TEXT NOT NULL REFERENCES tags (path) ON DELETE CASCADE,
  -- Mochi keeps `tags` (derived) and `manual-tags` in separate arrays.
  manual   INTEGER NOT NULL DEFAULT 1 CHECK (manual IN (0, 1)),
  PRIMARY KEY (card_id, tag_path)
);

CREATE INDEX card_tags_tag ON card_tags (tag_path, card_id);

-- ---------------------------------------------------------------------------
-- card_links -- [[display|card-id]].  8,690 links across 4,323 cards, 56% of
-- the corpus: morphological decomposition, a compound pointing at its
-- components.  Stored the rename-safe way, stable id plus cached display text.
--
-- to_card_id has NO foreign key, on purpose.  7,763 of 7,771 targets resolve
-- inside the three exports; the other 8 point at decks that were never
-- exported.  An unresolved target must be representable and must render as
-- plain text rather than being dropped.  Read through card_links_resolved.
-- ---------------------------------------------------------------------------
CREATE TABLE card_links (
  from_card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  to_card_id   TEXT NOT NULL,
  display_text TEXT NOT NULL,
  field_id     TEXT,                        -- NULL = the link is in card content
  ordinal      INTEGER NOT NULL DEFAULT 0   -- nth link within that scope
);

CREATE UNIQUE INDEX card_links_source ON card_links
  (from_card_id, COALESCE(field_id, ''), ordinal);
CREATE INDEX card_links_target ON card_links (to_card_id);

-- ---------------------------------------------------------------------------
-- blobs -- CONTENT-ADDRESSED and REFCOUNTED.  This is the fix for the
-- regeneration churn diagnosed in SPEC: Mochi keys its cache on the whole
-- concatenated card text, so a one-character typo fix bills a fresh Azure call,
-- writes a new mp3 and tombstones the old one -- 8,958 dead attachment records,
-- a 2.18x overspend, one card (領域) regenerated 33 times.
--
-- Three rules, each removing one failure mode:
--   1. Address by hash.  hash = sha256 over the identity tuple below
--      (kind, normalised source_text, voice, lang, canonical options).
--      Regenerating identical input is a cache hit, so a typo that is then
--      undone costs nothing and creates nothing.
--   2. Key per field, not per card: source_text is one field's resolved text,
--      so editing line 3 cannot invalidate the audio for lines 1-2.
--   3. Refcount, never tombstone.  Blobs are immutable and shared; deletion
--      happens only when the last reference drops.  There is deliberately no
--      deleted? flag anywhere in this schema.
--
-- mime is sniffed from the bytes, never trusted: several mp3s in the export
-- claim "text/xml" because Azure's SSML content-type leaked into Mochi's
-- attachment metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE blobs (
  hash        TEXT PRIMARY KEY,              -- lowercase hex sha256 of the identity tuple
  kind        TEXT NOT NULL CHECK (kind IN (
                'speech', 'ai', 'translate', 'furigana',
                'dictionary', 'image', 'file')),
  mime        TEXT NOT NULL,
  byte_size   INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  source_text TEXT,                          -- normalised generator input; NULL for uploads
  voice       TEXT,                          -- ja-JP-NanamiNeural, en-US-AIGenerate1Neural
  lang        TEXT,                          -- BCP-47 only; never Mochi's inline "jp"
  options     TEXT NOT NULL DEFAULT '{}',    -- canonical JSON; part of the hash
  bytes       BLOB,                          -- inline payload, or NULL when...
  path        TEXT,                          -- ...stored outside the DB (OPFS / disk)
  refcount    INTEGER NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX blobs_unreferenced ON blobs (created_at) WHERE refcount = 0;
CREATE INDEX blobs_kind_text    ON blobs (kind, source_text);

-- Every reference to a blob.  refcount is maintained by trigger so it cannot
-- drift from reality, and ON DELETE RESTRICT means a referenced blob cannot be
-- removed even if the triggers were dropped.
CREATE TABLE blob_refs (
  id         INTEGER PRIMARY KEY,
  blob_hash  TEXT NOT NULL REFERENCES blobs (hash) ON DELETE RESTRICT,
  card_id    TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  field_id   TEXT,                           -- NULL = inline generator in card content
  -- Which reference within that scope: the attachment filename for imported
  -- media, or the inline generator's ordinal for <speech>/<ai>/<translate>.
  ref_key    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX blob_refs_scope ON blob_refs
  (card_id, COALESCE(field_id, ''), ref_key);
CREATE INDEX blob_refs_blob ON blob_refs (blob_hash);

CREATE TRIGGER blob_refs_ai AFTER INSERT ON blob_refs
BEGIN
  UPDATE blobs SET refcount = refcount + 1 WHERE hash = NEW.blob_hash;
END;

CREATE TRIGGER blob_refs_ad AFTER DELETE ON blob_refs
BEGIN
  UPDATE blobs SET refcount = refcount - 1 WHERE hash = OLD.blob_hash;
END;

CREATE TRIGGER blob_refs_au AFTER UPDATE OF blob_hash ON blob_refs
WHEN NEW.blob_hash <> OLD.blob_hash
BEGIN
  UPDATE blobs SET refcount = refcount - 1 WHERE hash = OLD.blob_hash;
  UPDATE blobs SET refcount = refcount + 1 WHERE hash = NEW.blob_hash;
END;

-- Immutable: content-addressing is a lie the moment a blob's bytes or identity
-- tuple can change under a fixed hash.  refcount and path are the only mutable
-- parts (path so a blob can migrate between inline and external storage).
CREATE TRIGGER blobs_immutable BEFORE UPDATE ON blobs
WHEN NEW.hash <> OLD.hash
  OR NEW.kind <> OLD.kind
  OR NEW.mime <> OLD.mime
  OR NEW.byte_size <> OLD.byte_size
  OR COALESCE(NEW.source_text, '') <> COALESCE(OLD.source_text, '')
  OR COALESCE(NEW.voice, '')       <> COALESCE(OLD.voice, '')
  OR COALESCE(NEW.lang, '')        <> COALESCE(OLD.lang, '')
  OR NEW.options <> OLD.options
  OR COALESCE(NEW.bytes, x'') <> COALESCE(OLD.bytes, x'')
BEGIN
  SELECT RAISE(ABORT, 'blobs are immutable: insert a new hash instead');
END;

CREATE TRIGGER blobs_no_delete_while_referenced BEFORE DELETE ON blobs
WHEN OLD.refcount > 0
BEGIN
  SELECT RAISE(ABORT, 'blob is still referenced: delete only at refcount 0');
END;

-- ---------------------------------------------------------------------------
-- card_fts -- Ctrl+K search, and the index the @ picker reuses.
--
-- THE TOKENISER IS THE DECISION.  FTS5's default (unicode61) tokeniser splits
-- on whitespace and punctuation, so on Japanese it emits roughly one token per
-- run of kana/kanji and cannot match anything a user would actually type.  The
-- trigram tokeniser indexes every 3-character window instead, which gives real
-- CJK substring matching: 語の意 finds 単語の意味.  The cost is that queries
-- shorter than 3 characters cannot use the index at all -- that is a UI
-- constraint (fall back to a name LIKE scan for 1-2 character queries), not a
-- schema one.
--
-- Indexed: card name, all field values, and tag paths.  Field values rather
-- than rendered output, so a word is findable by its reading even when the card
-- displays only kanji.  rowid = cards.seq; kept in sync by the triggers below.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE card_fts USING fts5 (
  card_id UNINDEXED,
  name,
  body,
  tags,
  tokenize = 'trigram'
);

-- Each trigger reindexes exactly one card, delete-then-insert.  The body is
-- content plus every field value; tags are the materialised paths.  Written out
-- longhand per trigger because SQLite has no way to share a statement between
-- them.
CREATE TRIGGER cards_fts_ai AFTER INSERT ON cards BEGIN
  DELETE FROM card_fts WHERE rowid = NEW.seq;
  INSERT INTO card_fts (rowid, card_id, name, body, tags)
    SELECT c.seq, c.id, c.name,
           c.content || char(10) || COALESCE((SELECT group_concat(v.value, char(10))
             FROM card_field_values v WHERE v.card_id = c.id), ''),
           COALESCE((SELECT group_concat(t.tag_path, char(10))
             FROM card_tags t WHERE t.card_id = c.id), '')
      FROM cards c WHERE c.id = NEW.id;
END;

CREATE TRIGGER cards_fts_au AFTER UPDATE OF name, content ON cards BEGIN
  DELETE FROM card_fts WHERE rowid = NEW.seq;
  INSERT INTO card_fts (rowid, card_id, name, body, tags)
    SELECT c.seq, c.id, c.name,
           c.content || char(10) || COALESCE((SELECT group_concat(v.value, char(10))
             FROM card_field_values v WHERE v.card_id = c.id), ''),
           COALESCE((SELECT group_concat(t.tag_path, char(10))
             FROM card_tags t WHERE t.card_id = c.id), '')
      FROM cards c WHERE c.id = NEW.id;
END;

CREATE TRIGGER cards_fts_ad AFTER DELETE ON cards BEGIN
  DELETE FROM card_fts WHERE rowid = OLD.seq;
END;

CREATE TRIGGER card_field_values_fts_ai AFTER INSERT ON card_field_values BEGIN
  DELETE FROM card_fts WHERE rowid = (SELECT seq FROM cards WHERE id = NEW.card_id);
  INSERT INTO card_fts (rowid, card_id, name, body, tags)
    SELECT c.seq, c.id, c.name,
           c.content || char(10) || COALESCE((SELECT group_concat(v.value, char(10))
             FROM card_field_values v WHERE v.card_id = c.id), ''),
           COALESCE((SELECT group_concat(t.tag_path, char(10))
             FROM card_tags t WHERE t.card_id = c.id), '')
      FROM cards c WHERE c.id = NEW.card_id;
END;

CREATE TRIGGER card_field_values_fts_au AFTER UPDATE ON card_field_values BEGIN
  DELETE FROM card_fts WHERE rowid = (SELECT seq FROM cards WHERE id = NEW.card_id);
  INSERT INTO card_fts (rowid, card_id, name, body, tags)
    SELECT c.seq, c.id, c.name,
           c.content || char(10) || COALESCE((SELECT group_concat(v.value, char(10))
             FROM card_field_values v WHERE v.card_id = c.id), ''),
           COALESCE((SELECT group_concat(t.tag_path, char(10))
             FROM card_tags t WHERE t.card_id = c.id), '')
      FROM cards c WHERE c.id = NEW.card_id;
END;

CREATE TRIGGER card_field_values_fts_ad AFTER DELETE ON card_field_values BEGIN
  DELETE FROM card_fts WHERE rowid = (SELECT seq FROM cards WHERE id = OLD.card_id);
  INSERT INTO card_fts (rowid, card_id, name, body, tags)
    SELECT c.seq, c.id, c.name,
           c.content || char(10) || COALESCE((SELECT group_concat(v.value, char(10))
             FROM card_field_values v WHERE v.card_id = c.id), ''),
           COALESCE((SELECT group_concat(t.tag_path, char(10))
             FROM card_tags t WHERE t.card_id = c.id), '')
      FROM cards c WHERE c.id = OLD.card_id;
END;

CREATE TRIGGER card_tags_fts_ai AFTER INSERT ON card_tags BEGIN
  DELETE FROM card_fts WHERE rowid = (SELECT seq FROM cards WHERE id = NEW.card_id);
  INSERT INTO card_fts (rowid, card_id, name, body, tags)
    SELECT c.seq, c.id, c.name,
           c.content || char(10) || COALESCE((SELECT group_concat(v.value, char(10))
             FROM card_field_values v WHERE v.card_id = c.id), ''),
           COALESCE((SELECT group_concat(t.tag_path, char(10))
             FROM card_tags t WHERE t.card_id = c.id), '')
      FROM cards c WHERE c.id = NEW.card_id;
END;

CREATE TRIGGER card_tags_fts_ad AFTER DELETE ON card_tags BEGIN
  DELETE FROM card_fts WHERE rowid = (SELECT seq FROM cards WHERE id = OLD.card_id);
  INSERT INTO card_fts (rowid, card_id, name, body, tags)
    SELECT c.seq, c.id, c.name,
           c.content || char(10) || COALESCE((SELECT group_concat(v.value, char(10))
             FROM card_field_values v WHERE v.card_id = c.id), ''),
           COALESCE((SELECT group_concat(t.tag_path, char(10))
             FROM card_tags t WHERE t.card_id = c.id), '')
      FROM cards c WHERE c.id = OLD.card_id;
END;
