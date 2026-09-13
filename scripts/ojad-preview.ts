/**
 * A look at `<ojad>` on REAL cards, before it reaches any device.
 *
 *     npx vite-node scripts/ojad-preview.ts -- --db build/hashigo.db --out build/ojad-preview.html
 *
 * ─── WHY THIS EXISTS, AND IT IS NOT A MOCKUP ────────────────────────────────
 *
 * Zach, 2026-09-13: *"let's generate first, it won't reach my phone, that means
 * i can view it on pc, and if i say okay, then you can make it reach my phone
 * correct?"* — and the premise needed one correction. **His laptop browser is in
 * exactly the same position as his phone**: both hold their own OPFS copy and
 * both are gated by the same `seedReviews` freshness check, so neither shows a
 * template change until something delivers it. There is no "PC first" state.
 *
 * So this renders the cards through the SHIPPING path — `mountTrack` ->
 * `mountPrepared` -> `renderSides` with the real supports — and writes the
 * result to a file he can open. No device is touched, nothing is synced, and
 * what he sees is what the review screen would draw.
 *
 * **It is emphatically NOT `build/mock/out/`.** CLAUDE.md is explicit that those
 * are hand-authored by `scripts/mockup-html.ts` and that the real render
 * produces none of their structure. This produces exactly the real structure,
 * because it calls the real renderer; the only thing it adds is a page to hold
 * the cards and a `<link>` to `app/style.css`.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { defaultStoreDatabase, openBlobStoreDatabase } from "../src/blobs/index.js";
import { arg } from "../src/cli/args.js";
import { openDatabase } from "../src/db/index.js";
import { resolveDescriptorText } from "../src/generate/index.js";
import { memoryDocument, serialise, type MemoryElement } from "../src/render/dom.js";
import { mountTrack } from "../src/review/index.js";

const DB = arg("db", "build/hashigo.db");
const OUT = arg("out", "build/ojad-preview.html");
const WANT = Number(arg("count", "12"));

const db = openDatabase(DB, { readOnly: true });
const { store } = openBlobStoreDatabase(defaultStoreDatabase(DB), {
  mustExist: true,
  create: false,
});

/**
 * Cards chosen for VARIETY, not for looking good.
 *
 * A preview built from the first N rows would be twelve near-identical 単語
 * cards, and the cases worth seeing are the ones that stress the notation: many
 * accent phrases, several devoiced morae, and at least one sentence long enough
 * to wrap. Ordered so the widest spread comes first.
 */
const rows = db
  .prepare(
    `SELECT v.card_id   AS cardId,
            v.value     AS marks,
            n.value     AS word,
            t.name      AS template,
            length(v.value) - length(replace(v.value, '|', '')) AS phrases,
            length(v.value) - length(replace(v.value, '*', '')) AS heads,
            length(v.value) - length(replace(v.value, '_', '')) AS devoiced
       FROM card_field_values v
       JOIN cards c     ON c.id = v.card_id
       JOIN templates t ON t.id = c.template_id
       LEFT JOIN card_field_values n
              ON n.card_id = v.card_id AND n.field_id = 'name'
      WHERE v.field_id = 'ojad' AND c.archived = 0
      ORDER BY (devoiced > 0) DESC, phrases DESC
      LIMIT ?`,
  )
  .all(WANT) as {
  cardId: string;
  marks: string;
  word: string | null;
  template: string;
  phrases: number;
  heads: number;
  devoiced: number;
}[];

const blocks: string[] = [];
let rendered = 0;

for (const row of rows) {
  const card = mountTrack<MemoryElement>({
    db,
    track: { cardId: row.cardId, kind: "forward" },
    document: memoryDocument(),
    store,
  });
  if (card === null) continue;
  rendered += 1;

  // THE GENERATED TEXT, FILLED. Without this the example sentence renders EMPTY:
  // `例文` is an `ai` field whose text lives in the blob store and arrives through
  // `fillText`, which the app does from its worker. A preview that skipped it
  // would show the reading with no sentence above it — which is exactly what the
  // first run of this script produced, and it looked like a bug in the feature.
  card.fillText(
    card.textSlots.map((slot) =>
      resolveDescriptorText(db, {
        kind: slot.kind as Parameters<typeof resolveDescriptorText>[1]["kind"],
        text: slot.text,
        lang: slot.lang,
        voice: slot.voice,
        options: slot.options,
      }),
    ),
  );

  // EVERY SIDE, UNMASKED — this is decision 30's preview mode, not review mode.
  // A masked preview would hide the sentence side behind a reveal he cannot
  // click in a static file.
  const sides = card.result.sides
    .filter((side) => !side.empty)
    .map((side) => serialise(side.element))
    .join("\n");

  blocks.push(
    `<section class="preview-card">
  <header class="preview-head">
    <span class="preview-word">${escape(row.word ?? row.cardId)}</span>
    <span class="preview-meta">${escape(row.template)} · ${row.phrases + 1} phrases · ` +
      `${row.heads} head${row.heads === 1 ? "" : "s"} · ${row.devoiced} devoiced</span>
  </header>
  <div class="hashigo-card">${sides}</div>
  <pre class="preview-marks">${escape(row.marks)}</pre>
</section>`,
  );
  card.dispose();
}

const page = `<!doctype html>
<html lang="ja" data-theme="${arg("theme", "light")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OJAD preview — ${rendered} real cards</title>
<style>${readFileSync('app/style.css', 'utf8')}</style>
<style>
  body { margin: 0; padding: 24px; background: var(--paper); color: var(--ink);
         font-family: var(--sans, system-ui), sans-serif; }
  .preview-note { max-width: 720px; margin: 0 auto 28px; color: var(--muted);
                  line-height: 1.7; font-size: 14px; }
  .preview-note b { color: var(--ink); }
  .preview-card { max-width: 720px; margin: 0 auto 28px; background: var(--card);
                  border: 1px solid var(--line); padding: 18px 20px; }
  .preview-head { display: flex; justify-content: space-between; align-items: baseline;
                  gap: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--line);
                  padding-bottom: 8px; }
  .preview-word { font-size: 19px; font-weight: 600; }
  .preview-meta { color: var(--muted); font-size: 12px; }
  /* The stored value, so the notation can be checked against what is drawn. */
  .preview-marks { color: var(--muted); font-size: 11px; margin: 14px 0 0;
                   white-space: pre-wrap; word-break: break-all; opacity: 0.75; }
  /* A preview shows every side at once — decision 30. Nothing is masked here,
     because a mask in a static file is a mask he cannot open. */
  .hashigo-cloze-mask { display: none; }
  .hashigo-cloze-answer { display: inline !important; }
</style>
</head>
<body>
<div class="preview-note">
  <b>${rendered} real cards, rendered through the shipping path</b> — the same
  <code>mountTrack → mountPrepared → renderSides</code> the review screen uses, with
  <code>app/style.css</code> as-is. Nothing has been synced; no device holds this yet.
  <br><br>
  <b>Red</b> is the head of the accent: the pitch falls <i>after</i> that mora.
  <b>Gray with a ring</b> is a devoiced vowel. A 平板 phrase carries no mark at all —
  that absence is the signal. The small gray line under each stored value is the raw
  notation, so the drawing can be checked against the data.
  <br><br>
  Clozes are shown open here because a preview shows every side at once (decision 30).
</div>
${blocks.join("\n")}
</body>
</html>
`;

writeFileSync(OUT, page, "utf8");
console.log(`${rendered} card(s) -> ${OUT}`);
db.close();

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
