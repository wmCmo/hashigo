# src/dashboard — Stage 2. Owns the read-only tiles computed from the imported review log (活動, 学習カード数, 累計, 復習数, 定着率, 復習時間, デッキの進捗) plus retention-vs-interval. Doubles as the importer acceptance test. 復習予測 landed 2026-08-22 with stage 6 — read `forecast` in `metrics.ts` before quoting it, because most of the due dates it charts are still Mochi's and the tile counts both provenances rather than implying they are ours.

## The page is in English, and the Japanese is kept as the proof

`labels.ts` holds every user-visible string in both locales; **English is the default**
(Zach's decision, 2026-08-22). `--locale ja` renders the other one.

**The Japanese is not a legacy path — it is the test.** 231 strings moved out of
`render.ts`, across 242 lines of a 1,560-line file, and checking a handful of headings
would not show that nothing was mangled: a swapped interpolation, a dropped counter, or an
`esc()` applied to markup instead of to its inputs all leave every asserted figure intact.
So `test/fixtures/dashboard/ja.golden.html` was captured from the renderer BEFORE the
extraction, and `test/dashboard.test.ts` renders with `ja` and compares **byte for byte**
over 428,701 bytes. Delete the Japanese and that check goes with it.

It earned its place during the migration by catching three real defects: `+` translated to
`以上` in the heat legend, `esc()` wrapped around `section()`'s markup so the `<span>`
printed as text, and a Japanese clause being assembled at the call site instead of inside
the locale.

**Two rules for adding a string.**

1. **Anything carrying a figure is a FUNCTION, not a template with holes.** Japanese puts
   the counter after the number (`${n}回`), English puts a word before it (`${n} reviews`),
   and the two order clauses differently. A table of fragments produces English that reads
   like glued Japanese.
2. **Deck, template and field names never go in here.** `単語`, `漢字`, `第3章` are
   IDENTIFIERS the user authored; translating them would make the page disagree with his
   database. A test asserts that every Japanese run in the English page is a name that
   exists in the database — 26 distinct runs, all of them deck or template names, plus
   `梯子`, which is the product.
