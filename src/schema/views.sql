-- Hashigo derived views, stage 1.  Applied straight after schema.sql.
--
-- Two jobs, both of them schema-half obligations from SPEC.html:
--
-- 1. RESOLUTION.  The three-state inherit/on/off reverse flag, the deck tree and
--    the possibly-unresolved card links are all things every later stage would
--    otherwise re-implement slightly differently.  They resolve here, once.
--
-- 2. THE AGGREGATE SHAPE.  SPEC "Live analytics with insights": "The stage-1
--    obligation is small but real: settle the shape of that aggregate now, so
--    the queries feeding it are stable and the dashboard and the insight panel
--    read the same numbers."  review_log is the single base view; every tile in
--    the stage-2 dashboard (活動 / 学習カード数 / 累計 / 復習数 / 定着率 /
--    復習時間 / デッキの進捗) and every phase-2 insight reads one of the
--    aggregates below it.  Nothing else should aggregate reviews directly.
--
-- Views, not materialised tables: 102,020 reviews is a millisecond-scale scan
-- and precomputing invites two sources of truth.

-- ---------------------------------------------------------------------------
-- Deck tree
-- ---------------------------------------------------------------------------

-- Full '日本語/文法' style path and depth for every deck.
CREATE VIEW deck_paths AS
WITH RECURSIVE walk (id, path, depth, root_id) AS (
  SELECT id, name, 0, id FROM decks WHERE parent_id IS NULL
  UNION ALL
  SELECT d.id, walk.path || '/' || d.name, walk.depth + 1, walk.root_id
    FROM decks d JOIN walk ON d.parent_id = walk.id
)
SELECT id AS deck_id, path, depth, root_id FROM walk;

-- Every (deck, ancestor) pair including the deck itself at depth 0, nearest
-- ancestor first.  This is what the three-state resolution walks.
CREATE VIEW deck_ancestry AS
WITH RECURSIVE up (deck_id, ancestor_id, depth) AS (
  SELECT id, id, 0 FROM decks
  UNION ALL
  SELECT up.deck_id, d.parent_id, up.depth + 1
    FROM up JOIN decks d ON d.id = up.ancestor_id
   WHERE d.parent_id IS NOT NULL
)
SELECT deck_id, ancestor_id, depth FROM up;

-- ---------------------------------------------------------------------------
-- Three-state reverse resolution.  SPEC "Reverse-review resolution":
--   inherit -> whatever the deck says, walking up the tree; workspace default off
--   on      -> reverse, regardless of deck
--   off     -> no reverse, even when the deck says on
-- Card explicit beats deck, so 単語's 3,702 cards all reverse by inheritance and
-- flipping one card to off keeps it off.
-- ---------------------------------------------------------------------------
CREATE VIEW deck_reverse_resolved AS
SELECT d.id AS deck_id,
       COALESCE(
         (SELECT a.reverse
            FROM deck_ancestry an JOIN decks a ON a.id = an.ancestor_id
           WHERE an.deck_id = d.id AND a.reverse <> 'inherit'
           ORDER BY an.depth
           LIMIT 1),
         (SELECT value FROM settings WHERE key = 'reverse.default'),
         'off') AS reverse
  FROM decks d;

CREATE VIEW card_reverse_resolved AS
SELECT c.id AS card_id,
       c.deck_id,
       c.reverse AS card_reverse,
       dr.reverse AS deck_reverse,
       CASE WHEN c.reverse <> 'inherit' THEN c.reverse ELSE dr.reverse END AS reverse
  FROM cards c
  JOIN deck_reverse_resolved dr ON dr.deck_id = c.deck_id;

-- Per-card TTS voice, inherited the same way.  NULL here means "nothing
-- overrides it", and the caller then keeps the voice the TEMPLATE FIELD
-- recorded -- which SQL cannot know, because it is per-field, not per-card.
-- That last hop lives in `voiceFor`; everything a card and its decks have to say
-- is decided here, so there is one definition of the inheritance rather than a
-- SQL one and a TypeScript one that drift.
--
-- Why NULL rather than a provider default: every one of the 10,791 speech blobs
-- is addressed by the voice Mochi recorded.  A non-empty default would miss
-- every lookup at once and re-bill the corpus.
CREATE VIEW card_voice_resolved AS
SELECT c.id AS card_id,
       c.deck_id,
       c.voice AS card_voice,
       COALESCE(
         NULLIF(TRIM(c.voice), ''),
         (SELECT NULLIF(TRIM(a.voice), '')
            FROM deck_ancestry an JOIN decks a ON a.id = an.ancestor_id
           WHERE an.deck_id = c.deck_id AND NULLIF(TRIM(a.voice), '') IS NOT NULL
           ORDER BY an.depth
           LIMIT 1),
         NULLIF(TRIM((SELECT value FROM settings WHERE key = 'voice.default')), '')
       ) AS voice,
       CASE
         WHEN NULLIF(TRIM(c.voice), '') IS NOT NULL THEN 'card'
         WHEN (SELECT NULLIF(TRIM(a.voice), '')
                 FROM deck_ancestry an JOIN decks a ON a.id = an.ancestor_id
                WHERE an.deck_id = c.deck_id AND NULLIF(TRIM(a.voice), '') IS NOT NULL
                ORDER BY an.depth LIMIT 1) IS NOT NULL THEN 'deck'
         WHEN NULLIF(TRIM((SELECT value FROM settings WHERE key = 'voice.default')), '')
              IS NOT NULL THEN 'workspace'
         ELSE 'field'
       END AS source
  FROM cards c;

-- The accent for a string, with one definition of "which row wins".
--
--   1. a human override ('manual') beats everything, outright
--   2. then the PRIMARY analyser, 'openjtalk' -- the probe-rule derivation,
--      validated on 箸/橋/端/花/鼻 against Google's own documented notation
--   3. newest version within an analyser
--
-- A SECOND ANALYSER IS STORED BUT DOES NOT RESOLVE, and that is deliberate.
-- UniDic 2.3.0 is loaded as a cross-check: 97.31% agreement over 3,007
-- comparable words, 81 disagreements. It would be tempting to let it answer the
-- words openjtalk refused -- it has an answer for 8 of them -- but it is
-- measurably wrong on some of exactly those: it reads 正義 as the personal name
-- マサヨシ rather than セイギ. A wrong accent drilled through spaced repetition
-- is worse than no accent, so a cross-check answer becomes a CANDIDATE for
-- adjudication, never the resolved answer. `accent_disagreements` below is where
-- it shows up.
--
-- Ordering by version alone was the earlier rule and it was wrong for a second
-- reason: with two analysers, `version DESC` compares 'pyopenjtalk-plus/0.4.1'
-- against 'unidic/2.3.0' as strings, so which one won depended on the letter u
-- sorting after p. That is not a rule, it is an accident.
--
-- `basis = 'guarded'` rows are KEPT and surfaced rather than filtered out. They
-- are the manual-review queue -- 34 of 3,850 words on this corpus -- and a view
-- that hid them would turn "the rule refused" into "no data", which is the same
-- miss-as-silence defect the audio binding was built to fix.
CREATE VIEW accent_resolved AS
SELECT text, analyser, version, probe, phrases, type, accent_type, reading,
       position_basis, basis, note
  FROM accents a
 WHERE a.analyser IN ('manual', 'openjtalk')
   AND a.rowid = (
   SELECT b.rowid FROM accents b
    WHERE b.text = a.text AND b.analyser IN ('manual', 'openjtalk')
    ORDER BY (b.analyser = 'manual') DESC, b.version DESC, b.created_at DESC
    LIMIT 1
 );

-- Where the primary derivation and a cross-check analyser do not agree, plus
-- every word the primary REFUSED that a cross-check can speak to.
--
-- This is the adjudication queue, and it is a view rather than a report file so
-- it cannot go stale. Zach's instruction for settling these: OJAD, through its
-- own interface, driven the way a person would -- not a scraper. Their terms
-- permit educational and research use and ask people to refrain from bulk
-- automated use, and it is publicly funded university infrastructure.
CREATE VIEW accent_disagreements AS
SELECT r.text,
       r.type        AS primary_type,
       r.accent_type AS primary_accent,
       r.basis       AS primary_basis,
       r.reading     AS primary_reading,
       x.analyser    AS other_analyser,
       x.type        AS other_type,
       x.accent_type AS other_accent,
       x.reading     AS other_reading,
       CASE WHEN r.type IS NULL THEN 'primary refused'
            ELSE 'types differ' END AS kind
  FROM accent_resolved r
  JOIN accents x ON x.text = r.text
                AND x.analyser NOT IN ('manual', 'openjtalk')
                AND x.type IS NOT NULL
 WHERE r.type IS NULL OR r.type <> x.type;

-- Per-deck target retention, inherited the same way, defaulting to the
-- workspace setting.  SPEC: "Target retention must be a setting -- per deck."
CREATE VIEW deck_target_retention_resolved AS
SELECT d.id AS deck_id,
       COALESCE(
         (SELECT a.target_retention
            FROM deck_ancestry an JOIN decks a ON a.id = an.ancestor_id
           WHERE an.deck_id = d.id AND a.target_retention IS NOT NULL
           ORDER BY an.depth
           LIMIT 1),
         CAST((SELECT value FROM settings WHERE key = 'target_retention.default') AS REAL)
       ) AS target_retention
  FROM decks d;

-- ---------------------------------------------------------------------------
-- Links and tags
-- ---------------------------------------------------------------------------

-- TWO INDEPENDENT FACTS ABOUT A LINK, AND THEY ARE NOT THE SAME FACT.
--
-- resolved = 0 marks a link whose TARGET is not in `cards`: 18 rows of the
-- corpus's 8,744, pointing at 15 ids in decks that were never exported.  They
-- must render as plain display_text, not disappear.  (SPEC quotes "8 of 7,771"
-- -- that is Mochi's own derived `references` array, a different set entirely.
-- See the header of src/import/links.ts; the parse is what renders.)
--
-- text_present = 0 marks a link whose SOURCE text is no longer in the database:
-- 889 rows on 510 cards, every one of them in `cards.content` that the importer
-- discarded as stale pre-template text (MappingNotes.staleContentCardIds).  The
-- rows are kept deliberately -- 66 of those edges exist nowhere else, and the
-- discard is documented as recoverable rather than destructive -- but a link
-- into text nobody can see is not a link a backlink panel or an @ picker should
-- offer.  Filter on text_present = 1 for anything the user is meant to click;
-- read text_present = 0 when the question is "what did Mochi's old text say".
--
-- Both default to the honest answer rather than the convenient one: a row is
-- never dropped from this view, only labelled.
CREATE VIEW card_links_resolved AS
SELECT l.from_card_id,
       l.to_card_id,
       l.display_text,
       l.field_id,
       l.ordinal,
       CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS resolved,
       CASE
         WHEN l.field_id IS NULL THEN
           CASE WHEN COALESCE(f.content, '') = '' THEN 0 ELSE 1 END
         WHEN EXISTS (SELECT 1 FROM card_field_values v
                       WHERE v.card_id = l.from_card_id
                         AND v.field_id = l.field_id
                         AND COALESCE(v.value, '') <> '') THEN 1
         ELSE 0
       END AS text_present,
       c.name AS to_card_name
  FROM card_links l
  JOIN cards f ON f.id = l.from_card_id
  LEFT JOIN cards c ON c.id = l.to_card_id;

-- Sidebar tree numbers.  cards_subtree uses the materialised-path prefix scan,
-- which is what makes arbitrary nesting free.
CREATE VIEW tag_usage AS
SELECT t.path,
       t.parent_path,
       t.name,
       t.depth,
       (SELECT count(*) FROM card_tags ct WHERE ct.tag_path = t.path) AS cards_direct,
       (SELECT count(*) FROM card_tags ct
         WHERE ct.tag_path = t.path OR ct.tag_path GLOB t.path || '/*') AS cards_subtree
  FROM tags t;

-- ---------------------------------------------------------------------------
-- review_gaps -- the MEASURED interval, derived from nothing but the
-- timestamps.  This is what makes elapsed_days ground truth rather than a
-- column somebody has to remember to fill in.
--
-- reviews.elapsed_days is a stored denormalisation of exactly this number.  The
-- 8,934 rows that carry no planned interval (a track's first review, plus
-- imports where Mochi's `interval` was absent) still have a measurable gap
-- whenever they have a predecessor, so deriving rather than trusting is what
-- makes them scorable.  review_interval_audit below checks the two agree.
--
-- Ordered by (reviewed_at, id): every imported timestamp is date-only, so two
-- reviews of one track can tie exactly, and id breaks the tie in insertion
-- order, which is export order.  A tie yields elapsed_days = 0, which is the
-- honest answer for the 6,996 same-day reviews -- not NULL, and not a guess.
-- ---------------------------------------------------------------------------
CREATE VIEW review_gaps AS
SELECT id       AS review_id,
       track_id,
       julianday(reviewed_at)
         - julianday(lag(reviewed_at) OVER (PARTITION BY track_id
                                            ORDER BY reviewed_at, id))
                AS elapsed_days_measured
  FROM reviews;

-- ---------------------------------------------------------------------------
-- review_log -- the single base view for every aggregate.
--
-- local_date is always meaningful: the date is the one thing Mochi did store.
-- local_hour is NULL whenever time_unknown = 1, which is what keeps every
-- imported review out of a false 00:00 bucket.  Do not recompute the hour
-- anywhere else.
--
-- TWO COLUMNS THIS VIEW DELIBERATELY DOES NOT HAVE.
--
-- `interval_days`, because it used to mean the planned interval while the
-- backtest read it as elapsed and the dashboard bucketed it as planned.
-- Removing the name is what stops that recurring: a query that still says
-- interval_days now fails with "no such column" instead of returning a
-- plausible wrong number.
--
-- `elapsed_days`, because the honest value needs the window in review_gaps and
-- serving it here would charge every aggregate for it.  Measured at 100,308
-- reviews: joining review_gaps in costs 144 ms on top of 77 ms, a 187% tax on
-- study_totals, activity_by_day, retention_by_deck and retention_by_hour, none
-- of which look at an interval at all.  So the measured interval lives one view
-- up, in review_log_elapsed, and only interval charts pay for it.  What is here
-- is elapsed_days_stored -- the raw column, NULL where nobody filled it in --
-- under a name that says so.
--
-- There is no `grade` either: grades are binary by design and remembered is the
-- whole signal.  See the reviews table in schema.sql.
-- ---------------------------------------------------------------------------
CREATE VIEW review_log AS
SELECT r.id                AS review_id,
       t.card_id,
       t.id                AS track_id,
       t.kind              AS track_kind,
       c.deck_id,
       dp.path             AS deck_path,
       dp.root_id          AS root_deck_id,
       r.reviewed_at,
       r.tz_offset_minutes,
       r.time_unknown,
       date(datetime(r.reviewed_at, printf('%+d minutes', r.tz_offset_minutes)))
                           AS local_date,
       CASE WHEN r.time_unknown = 1 THEN NULL
            ELSE CAST(strftime('%H',
                   datetime(r.reviewed_at, printf('%+d minutes', r.tz_offset_minutes))
                 ) AS INTEGER)
       END                 AS local_hour,
       r.remembered,
       r.elapsed_days      AS elapsed_days_stored,
       r.scheduled_days,
       r.next_scheduled_days,
       r.duration_ms,
       r.rereview,
       r.source
  FROM reviews r
  JOIN card_tracks t ON t.id = r.track_id
  JOIN cards c       ON c.id = t.card_id
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id;

-- review_log plus the MEASURED interval.  Read this one whenever an interval is
-- involved; read review_log for everything else.
--
--   elapsed_days           COALESCE(stored, measured).  Ground truth, and never
--                          NULL where a predecessor exists -- which is what
--                          makes the 8,934 rows carrying no planned interval
--                          scorable.
--   elapsed_days_measured  the derivation on its own, so the two can be
--                          compared (review_interval_audit does exactly that).
CREATE VIEW review_log_elapsed AS
SELECT rl.*,
       COALESCE(rl.elapsed_days_stored, g.elapsed_days_measured) AS elapsed_days,
       g.elapsed_days_measured
  FROM review_log rl
  LEFT JOIN review_gaps g ON g.review_id = rl.review_id;

-- Interval bucketing.  The boundaries are defined exactly once here, and are
-- applied TWICE -- once to each definition of "interval" -- because the answer
-- differs and the difference is the point.  SPEC wants "retention plotted
-- against interval length, which is where over-studying becomes visible"; on
-- the real corpus the planned definition puts ZERO observations past a year
-- while the measured one puts 3,009 there at 96.88%, which is the single most
-- decision-relevant number on the dashboard.  A chart built on this view must
-- say which basis it used.
CREATE VIEW review_log_bucketed AS
SELECT rl.*,
       CASE WHEN rl.elapsed_days IS NULL  THEN 0
            WHEN rl.elapsed_days <= 1     THEN 1
            WHEN rl.elapsed_days <= 3     THEN 2
            WHEN rl.elapsed_days <= 7     THEN 3
            WHEN rl.elapsed_days <= 21    THEN 4
            WHEN rl.elapsed_days <= 60    THEN 5
            WHEN rl.elapsed_days <= 180   THEN 6
            WHEN rl.elapsed_days <= 365   THEN 7
            ELSE 8 END AS elapsed_bucket,
       CASE WHEN rl.elapsed_days IS NULL  THEN 'unknown'
            WHEN rl.elapsed_days <= 1     THEN '<= 1d'
            WHEN rl.elapsed_days <= 3     THEN '1-3d'
            WHEN rl.elapsed_days <= 7     THEN '3-7d'
            WHEN rl.elapsed_days <= 21    THEN '7-21d'
            WHEN rl.elapsed_days <= 60    THEN '21-60d'
            WHEN rl.elapsed_days <= 180   THEN '60-180d'
            WHEN rl.elapsed_days <= 365   THEN '180-365d'
            ELSE '> 365d' END AS elapsed_bucket_label,
       CASE WHEN rl.scheduled_days IS NULL  THEN 0
            WHEN rl.scheduled_days <= 1     THEN 1
            WHEN rl.scheduled_days <= 3     THEN 2
            WHEN rl.scheduled_days <= 7     THEN 3
            WHEN rl.scheduled_days <= 21    THEN 4
            WHEN rl.scheduled_days <= 60    THEN 5
            WHEN rl.scheduled_days <= 180   THEN 6
            WHEN rl.scheduled_days <= 365   THEN 7
            ELSE 8 END AS scheduled_bucket,
       CASE WHEN rl.scheduled_days IS NULL  THEN 'unknown'
            WHEN rl.scheduled_days <= 1     THEN '<= 1d'
            WHEN rl.scheduled_days <= 3     THEN '1-3d'
            WHEN rl.scheduled_days <= 7     THEN '3-7d'
            WHEN rl.scheduled_days <= 21    THEN '7-21d'
            WHEN rl.scheduled_days <= 60    THEN '21-60d'
            WHEN rl.scheduled_days <= 180   THEN '60-180d'
            WHEN rl.scheduled_days <= 365   THEN '180-365d'
            ELSE '> 365d' END AS scheduled_bucket_label
  FROM review_log_elapsed rl;

-- ---------------------------------------------------------------------------
-- Aggregates.  The regression oracle for the importer is study_totals:
-- 102,020 reviews, 96.24% retention, 636.1 hours, 1,317 study days.
-- ---------------------------------------------------------------------------
CREATE VIEW study_totals AS
SELECT (SELECT count(*) FROM cards)                            AS cards,
       (SELECT count(*) FROM cards WHERE archived = 1)         AS cards_archived,
       (SELECT count(*) FROM card_tracks)                      AS tracks,
       count(*)                                                AS reviews,
       sum(remembered)                                         AS passed,
       sum(1 - remembered)                                     AS lapses,
       CASE WHEN count(*) = 0 THEN NULL
            ELSE 1.0 * sum(remembered) / count(*) END          AS retention,
       sum(duration_ms) / 3600000.0                            AS hours,
       count(DISTINCT local_date)                              AS study_days,
       min(local_date)                                         AS first_review_date,
       max(local_date)                                         AS last_review_date,
       sum(time_unknown)                                       AS reviews_time_unknown
  FROM review_log;

-- 活動 heatmap plus 復習数 / 復習時間 per day.
CREATE VIEW activity_by_day AS
SELECT local_date,
       count(*)                                       AS reviews,
       count(DISTINCT card_id)                        AS cards_seen,
       sum(remembered)                                AS passed,
       1.0 * sum(remembered) / count(*)               AS retention,
       sum(duration_ms) / 60000.0                     AS minutes
  FROM review_log
 GROUP BY local_date;

CREATE VIEW retention_by_deck AS
SELECT deck_id,
       deck_path,
       track_kind,
       count(*)                                       AS reviews,
       sum(1 - remembered)                            AS lapses,
       1.0 * sum(remembered) / count(*)               AS retention,
       sum(duration_ms) / 3600000.0                   AS hours
  FROM review_log
 GROUP BY deck_id, deck_path, track_kind;

-- TWO views, not one with a basis column, so a consumer that forgets to filter
-- gets an error rather than double-counted rows.  There is deliberately no
-- retention_by_interval: the old name did not say which interval it meant.
--
-- Measured on the real corpus, and they disagree everywhere:
--   bucket      elapsed n / ret %      planned n / ret %
--   0-1d        13,495 / 96.67          7,087 / 95.41
--   180-365d     9,343 / 94.35         11,398 / 95.15
--   > 365d       3,009 / 96.88              0 / --
CREATE VIEW retention_by_elapsed_interval AS
SELECT elapsed_bucket                                 AS interval_bucket,
       elapsed_bucket_label                           AS interval_bucket_label,
       count(*)                                       AS reviews,
       sum(1 - remembered)                            AS lapses,
       1.0 * sum(remembered) / count(*)               AS retention,
       avg(elapsed_days)                              AS mean_interval_days
  FROM review_log_bucketed
 GROUP BY elapsed_bucket, elapsed_bucket_label;

CREATE VIEW retention_by_scheduled_interval AS
SELECT scheduled_bucket                               AS interval_bucket,
       scheduled_bucket_label                         AS interval_bucket_label,
       count(*)                                       AS reviews,
       sum(1 - remembered)                            AS lapses,
       1.0 * sum(remembered) / count(*)               AS retention,
       avg(scheduled_days)                            AS mean_interval_days
  FROM review_log_bucketed
 GROUP BY scheduled_bucket, scheduled_bucket_label;

-- Only real timestamps reach this view.  Every imported review is excluded by
-- local_hour IS NULL, which is the whole point of time_unknown.
CREATE VIEW retention_by_hour AS
SELECT local_hour,
       count(*)                                       AS reviews,
       sum(1 - remembered)                            AS lapses,
       1.0 * sum(remembered) / count(*)               AS retention,
       avg(duration_ms) / 1000.0                      AS mean_seconds
  FROM review_log
 WHERE local_hour IS NOT NULL
 GROUP BY local_hour;

-- デッキの進捗.  new / young / mature by the track's current interval; dormant
-- tracks (reverse switched off) are counted separately and never scheduled.
CREATE VIEW deck_progress AS
SELECT c.deck_id,
       dp.path                                                    AS deck_path,
       t.kind                                                     AS track_kind,
       count(*)                                                   AS tracks,
       sum(CASE WHEN t.reps = 0 THEN 1 ELSE 0 END)                AS new_tracks,
       sum(CASE WHEN t.reps > 0 AND COALESCE(t.scheduled_days, 0) < 21
                THEN 1 ELSE 0 END)                                AS young_tracks,
       sum(CASE WHEN t.reps > 0 AND COALESCE(t.scheduled_days, 0) >= 21
                THEN 1 ELSE 0 END)                                AS mature_tracks,
       sum(t.dormant)                                             AS dormant_tracks,
       sum(t.lapses)                                              AS lapses
  FROM card_tracks t
  JOIN cards c ON c.id = t.card_id
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id
 GROUP BY c.deck_id, dp.path, t.kind;

-- Leech-policy input: how many tracks have lapsed n times.  SPEC leaves the
-- leech rule open ("design a rule rather than reverse-engineering Mochi's");
-- this is the distribution that rule gets designed against.
CREATE VIEW lapse_distribution AS
SELECT lapses,
       count(*) AS tracks
  FROM card_tracks
 GROUP BY lapses;

-- ---------------------------------------------------------------------------
-- review_interval_audit -- the denormalisation check.  MUST RETURN NO ROWS.
--
-- Two facts about reviews are stored redundantly, and redundancy that is never
-- checked is just a second answer waiting to be believed:
--
--   elapsed-mismatch      reviews.elapsed_days disagrees with the gap its own
--                         timestamps imply, by more than half a day.  The
--                         tolerance is half a day because every imported
--                         timestamp is date-only, so the true gap is only known
--                         to the day.
--   scheduled-chain-break reviews[n].scheduled_days is not the previous review
--                         of the same track's next_scheduled_days.  This is the
--                         invariant that makes keeping both columns safe; if it
--                         breaks, the importer's one-review shift is back.
--
-- Run it after any import:
--   SELECT problem, count(*) FROM review_interval_audit GROUP BY problem;
-- ---------------------------------------------------------------------------
CREATE VIEW review_interval_audit AS
WITH chain AS (
  SELECT r.id AS review_id,
         r.track_id,
         r.reviewed_at,
         r.elapsed_days,
         r.scheduled_days,
         julianday(r.reviewed_at)
           - julianday(lag(r.reviewed_at) OVER w) AS elapsed_days_measured,
         lag(r.next_scheduled_days) OVER w        AS prev_next_scheduled_days
    FROM reviews r
  WINDOW w AS (PARTITION BY r.track_id ORDER BY r.reviewed_at, r.id)
)
SELECT 'elapsed-mismatch' AS problem, review_id, track_id, reviewed_at,
       elapsed_days AS stored, elapsed_days_measured AS expected
  FROM chain
 WHERE elapsed_days IS NOT NULL
   AND elapsed_days_measured IS NOT NULL
   AND abs(elapsed_days - elapsed_days_measured) > 0.5
UNION ALL
SELECT 'scheduled-chain-break', review_id, track_id, reviewed_at,
       scheduled_days, prev_next_scheduled_days
  FROM chain
 WHERE prev_next_scheduled_days IS NOT NULL
   AND (scheduled_days IS NULL OR scheduled_days <> prev_next_scheduled_days);
