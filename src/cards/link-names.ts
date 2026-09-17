/**
 * THE NAME BEHIND A BARE `[[id]]`.
 *
 * ─── ZACH, 2026-09-15, FROM A REVERSE 漢字 CARD ON HIS PHONE ────────────────
 *
 *     give, tKEAH1CO, perform, alms
 *
 * *"instead of rendering the word, it shows the id — which is the leftovers
 * artifact from mochi era, where you can only states the id, and it will render
 * the first field?? i want that too"*
 *
 * He is describing Mochi's behaviour correctly. Mochi has TWO link forms, and the
 * card he was looking at (施) carries one of each:
 *
 *     [[alms|2JIxWV2M]]   display text authored -> "alms"
 *     [[tKEAH1CO]]        no display text       -> Mochi prints the TARGET'S NAME
 *
 * `src/render/nodes.ts` has always known how to do the second — `wikiLink` falls
 * back to `target.name` when the authored display is absent or empty. **Nothing
 * ever gave it a `resolveCardLink`.** With the option undefined the renderer
 * builds `{}`, `target.name` is undefined, and the last-resort branch prints the
 * id so that the anchor is never empty and untappable. That fallback is right and
 * stays; it was simply the only branch reachable.
 *
 * ─── HOW BIG THIS IS, MEASURED ─────────────────────────────────────────────
 *
 * Bare `[[id]]` occurrences in `card_field_values`: **38, across 33 cards, and
 * all 38 resolve — zero dead targets.** None at all in `cards.content`. So this
 * is a small fix by volume and he still hit it, which is what 33 cards in a
 * 756-card queue does.
 *
 * (`app/links.ts`'s table says "display = the bare id: 0". No contradiction — it
 * counted the `[[display|id]]` form only. `src/template/ast.ts` has always
 * counted the bare form separately, and said 46; that figure is over the export's
 * raw text, this one over stored field values after the import.)
 *
 * ─── AN UNKNOWN ID IS `{}`, NEVER `null` ───────────────────────────────────
 *
 * `resolveCardLink` returning `null` means "no such card", and the renderer then
 * prints the authored source verbatim — brackets, pipe and id. For the 18 links
 * in this corpus whose target really is gone, that would replace a plain word
 * with `[[alms|2JIxWV2M]]` on screen: a REGRESSION, on cards that read fine
 * today. So an id we cannot name resolves to `{}` — a link with no name, which is
 * exactly the state the renderer has been in for every link until now.
 *
 * Surfacing dead links AS dead is a real question and a different one. It changes
 * what 18 cards look like, so it is his.
 *
 * BROWSER-PORTABLE, like everything else under `src/cards` — `SqliteHandle`, no
 * `node:` import. This runs in the OPFS worker, beside `prepareCard`.
 */
import type { SqliteHandle } from "../db/browser.js";
import { walkSides, type Side } from "../template/ast.js";

/**
 * Card id → the card's own name, for every wiki-link on these sides.
 *
 * A plain object rather than a `Map` because this crosses the worker→page
 * boundary on `PreparedCard`, and structured clone carries both — but the page
 * half of `app/` reads it as data, and a plain object is what every other field
 * on that interface already is.
 */
export type LinkNames = Readonly<Record<string, string>>;

/**
 * Every wiki-link target on `sides`, in document order, de-duplicated.
 *
 * Collected for EVERY link and not only the bare ones. A link whose display text
 * is authored does not need the name to render — but the set is tiny, the query
 * is one statement either way, and a collector that filtered on "is the display
 * empty" would have to be kept in step with the renderer's own idea of empty
 * (`null` and `""` both count there). Two places deciding the same thing is how
 * they come to disagree.
 */
export function linkTargetsOf(sides: readonly Side[]): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  walkSides(sides, (node) => {
    if (node.kind !== "wikiLink") return;
    if (seen.has(node.target)) return;
    seen.add(node.target);
    targets.push(node.target);
  });
  return targets;
}

/**
 * Name every one of those targets that is a real card.
 *
 * An id with no row is simply absent from the result — see the header: absent
 * means "no name", not "no card", and the renderer treats the two the same way it
 * always has.
 *
 * `archived` is NOT filtered. A card he archived is still a card he wrote and its
 * name is still the right word to print, which is the rule `backlinksOf` and
 * `SearchOptions` already follow.
 */
export function linkNamesFor(db: SqliteHandle, sides: readonly Side[]): LinkNames {
  const targets = linkTargetsOf(sides);
  if (targets.length === 0) return {};
  const placeholders = targets.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, name FROM cards WHERE id IN (${placeholders})`)
    .all(...targets) as readonly { id: string; name: string | null }[];
  const names: Record<string, string> = {};
  for (const row of rows) {
    // An empty name would render an empty anchor, which is the very thing the
    // renderer's id fallback exists to prevent. Leave it out and let that stand.
    if (row.name === null || row.name.trim() === "") continue;
    names[row.id] = row.name;
  }
  return names;
}

// ─── the same question, for `#tags` ─────────────────────────────────────────

/**
 * Every `#tag` path written on `sides`, in document order, de-duplicated.
 *
 * Zach, 2026-09-18: *"i want the tag to behave like hyperlink too"*.
 *
 * It lives beside `linkTargetsOf` because it is the identical problem and the
 * header above already argues it: the renderer's resolver is SYNCHRONOUS and the
 * page holds no database, so the answer has to be collected in the half that
 * does. The first attempt at this shipped the workspace's whole tag list on the
 * `decks` reply instead, and it was wrong for a reason worth keeping — that
 * request races the worker's `open` at boot, so a card mounted first rendered
 * every tag as dead text and never re-rendered. A fact a card needs travels with
 * the card.
 */
export function tagPathsOf(sides: readonly Side[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  walkSides(sides, (node) => {
    if (node.kind !== "tag" || node.path === "") return;
    if (seen.has(node.path)) return;
    seen.add(node.path);
    paths.push(node.path);
  });
  return paths;
}

/**
 * Which of those paths are real tags.
 *
 * A list and not a map: a tag has nothing to carry but its own existence, and
 * the href is minted from the path. The renderer prints an unknown `#` as the
 * text it was authored as, which is what makes a generous grammar safe — every
 * `#` in this corpus is a real tag, but a URL fragment in a future field value
 * would parse as one and must not become a chip that leads nowhere.
 *
 * `tags` holds 20 rows for 19 real tags: `Dialect` exists only because
 * `Dialect/Kansai` needs a parent and `tags.parent_path` is a foreign key onto
 * `tags.path`. A synthesised ancestor is still a tag worth clicking — it is how
 * he would reach every card under it — so this does not filter on cards.
 */
export function knownTagsFor(db: SqliteHandle, sides: readonly Side[]): string[] {
  const paths = tagPathsOf(sides);
  if (paths.length === 0) return [];
  const placeholders = paths.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT path FROM tags WHERE path IN (${placeholders})`)
    .all(...paths) as readonly { path: string }[];
  return rows.map((row) => row.path);
}
