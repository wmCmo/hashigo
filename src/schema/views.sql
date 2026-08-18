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

-- resolved = 0 marks the 8 links (of 7,771) whose target was never exported.
-- They must render as plain display_text, not disappear.
CREATE VIEW card_links_resolved AS
SELECT l.from_card_id,
       l.to_card_id,
       l.display_text,
       l.field_id,
       l.ordinal,
       CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS resolved,
       c.name AS to_card_name
  FROM card_links l
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
-- review_log -- the single base view for every aggregate.
--
-- local_date is always meaningful: the date is the one thing Mochi did store.
-- local_hour is NULL whenever time_unknown = 1, which is what keeps every
-- imported review out of a false 00:00 bucket.  Do not recompute the hour
-- anywhere else.
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
       r.grade,
       r.interval_days,
       r.duration_ms,
       r.rereview,
       r.source
  FROM reviews r
  JOIN card_tracks t ON t.id = r.track_id
  JOIN cards c       ON c.id = t.card_id
  LEFT JOIN deck_paths dp ON dp.deck_id = c.deck_id;

-- Interval bucketing, shared by retention_by_interval so the boundaries are
-- defined exactly once.  SPEC wants "retention plotted against interval
-- length, which is where over-studying becomes visible".
CREATE VIEW review_log_bucketed AS
SELECT rl.*,
       CASE WHEN rl.interval_days IS NULL  THEN 0
            WHEN rl.interval_days <= 1     THEN 1
            WHEN rl.interval_days <= 3     THEN 2
            WHEN rl.interval_days <= 7     THEN 3
            WHEN rl.interval_days <= 21    THEN 4
            WHEN rl.interval_days <= 60    THEN 5
            WHEN rl.interval_days <= 180   THEN 6
            WHEN rl.interval_days <= 365   THEN 7
            ELSE 8 END AS interval_bucket,
       CASE WHEN rl.interval_days IS NULL  THEN 'unknown'
            WHEN rl.interval_days <= 1     THEN '<= 1d'
            WHEN rl.interval_days <= 3     THEN '1-3d'
            WHEN rl.interval_days <= 7     THEN '3-7d'
            WHEN rl.interval_days <= 21    THEN '7-21d'
            WHEN rl.interval_days <= 60    THEN '21-60d'
            WHEN rl.interval_days <= 180   THEN '60-180d'
            WHEN rl.interval_days <= 365   THEN '180-365d'
            ELSE '> 365d' END AS interval_bucket_label
  FROM review_log rl;

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

CREATE VIEW retention_by_interval AS
SELECT interval_bucket,
       interval_bucket_label,
       count(*)                                       AS reviews,
       sum(1 - remembered)                            AS lapses,
       1.0 * sum(remembered) / count(*)               AS retention,
       avg(interval_days)                             AS mean_interval_days
  FROM review_log_bucketed
 GROUP BY interval_bucket, interval_bucket_label;

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
       sum(CASE WHEN t.reps > 0 AND COALESCE(t.interval_days, 0) < 21
                THEN 1 ELSE 0 END)                                AS young_tracks,
       sum(CASE WHEN t.reps > 0 AND COALESCE(t.interval_days, 0) >= 21
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
