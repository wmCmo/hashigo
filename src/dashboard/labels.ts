/**
 * Stage 2 — every user-visible string on the dashboard, in one place, per locale.
 *
 * ENGLISH IS THE DEFAULT, JAPANESE IS KEPT. Zach's decision: the page is his and
 * he reads English faster, but the Japanese is not deleted — keeping both is what
 * makes the extraction PROVABLE. `test/dashboard.test.ts` renders with `ja` and
 * compares byte-for-byte against `test/fixtures/dashboard/ja.golden.html`, which
 * was captured from the pre-extraction renderer. So "no string was mangled on the
 * way into this table" is an assertion rather than a hope, over all 460,400 bytes.
 *
 * WHAT IS NOT IN HERE, deliberately: deck, template and field names. `単語`,
 * `漢字`, `例文`, `意味` are IDENTIFIERS — the user authored them and they name
 * rows in his database. Translating them would make the page disagree with the
 * app, so they pass through untouched in both locales. Same for `Dialect/Kansai`
 * and every other tag path.
 *
 * WHY SO MANY ARE FUNCTIONS. Most of this page is not labels, it is sentences
 * with figures in them, and a sentence is not a template with holes: Japanese puts
 * the counter after the number (`${n}回`) and English puts a word before it
 * (`${n} reviews`), and the two languages order clauses differently. A label table
 * of fragments would produce English that reads like glued Japanese. So anything
 * carrying a figure is a function taking the figures and returning the whole
 * sentence, and each locale writes its own.
 *
 * ONE CLASS OF STRING STAYS ENGLISH IN BOTH: the `<span class="latin">` subtitles
 * that already sat beside the Japanese headings (`activity · reviews per day`).
 * Under `en` those become the heading itself and the subtitle is dropped rather
 * than duplicated — which is why `section()` takes both and each locale decides.
 */

/** Which of the two the page is being rendered in. */
export type Locale = "en" | "ja";

export interface Labels {
  readonly locale: Locale;

  // ── chrome ────────────────────────────────────────────────────────────────
  readonly pageTitle: string;
  readonly h1: string;
  readonly eyebrow: string;
  readonly lede: string;
  readonly metaSource: string;
  readonly metaGenerated: string;
  readonly metaSchema: string;
  readonly metaSpan: string;
  readonly metaTimezone: string;
  readonly metaTimezoneValue: string;
  readonly noData: string;
  /** A section heading. The Latin subtitle is dropped when it IS the heading. */
  section(ja: string, latin: string): string;
  /**
   * The two headings `section()` cannot serve, because their Latin subtitle is
   * itself part Japanese — `retention vs interval — Mochi にはないタイル`. Under
   * `en` that would leave Japanese in an English heading, so each locale writes
   * the whole thing.
   */
  readonly headingIntervalRetention: string;
  readonly headingDeckRetention: string;
  /**
   * A `DateWindow`'s name. Its `label` is authored Japanese (`2026年`) and its
   * `id` is the bare year, so each locale picks rather than formatting — this is
   * the only figure that reaches the page from `metrics.ts` rather than from here,
   * and left alone it put `2026年` inside an English heading.
   */
  windowLabel(id: string, label: string): string;

  // ── tiles ─────────────────────────────────────────────────────────────────
  readonly tileReviews: string;
  readonly tileRetention: string;
  readonly tileStudyTime: string;
  readonly tileCardsStudied: string;
  readonly tileActiveDays: string;
  readonly tileLapses: string;
  readonly tilePerDay: string;
  readonly tilePerReview: string;
  readonly unitHours: string;
  readonly unitTimes: string;
  readonly unitSeconds: string;
  readonly unitPoints: string;
  tileReviewsSub(forward: string, reverse: string): string;
  tileRetentionSub(passed: string, lapses: string, target: string, delta: string): string;
  tileStudyTimeSub(days: string, timed: string): string;
  tileCardsStudiedSub(total: string): string;
  tileActiveDaysSub(span: string): string;
  tileLapsesSub(share: string): string;
  readonly tilePerDaySub: string;
  tilePerReviewSub(mean: string): string;

  // ── totals section ────────────────────────────────────────────────────────
  totalsDef(from: string, to: string, days: string, untimed: string): string;
  totalsRead(target: string, delta: string): string;
  totalsClock(unknown: string): string;

  // ── activity heatmap ──────────────────────────────────────────────────────
  readonly weekdays: readonly (readonly [number, string])[];
  month(m: number): string;
  heatDay(date: string, reviews: string, retention: string, minutes: string): string;
  heatDayEmpty(date: string): string;
  heatAria(year: string): string;
  yearStrip(year: string, reviews: string, days: string, retention: string): string;
  yearTableSummary(year: string, rows: number): string;
  readonly yearTableHead: readonly string[];
  readonly heatLegendTitle: string;
  readonly heatLegendMore: string;
  readonly activityDef: string;
  activityRead(activeDays: string, elapsedDays: string, share: string): string;
  readonly yearsTableSummary: string;
  readonly yearsTableHead: readonly string[];
  /** The year as a table CELL. Japanese appends the counter; English does not. */
  yearRow(year: string): string;

  // ── cards studied / cumulative ────────────────────────────────────────────
  cumulativeAria(first: string, last: string, cards: string): string;
  cumulativeCap(cards: string): string;
  monthlyTip(month: string, cards: string, fresh: string, reviews: string): string;
  monthlyAria(month: string, peak: string): string;
  cumulativeDef(final: string): string;
  cumulativeRead(total: string, studied: string, untouched: string): string;
  readonly monthlyHeading: string;
  readonly monthsTableSummary: string;
  readonly monthsTableHead: readonly string[];

  // ── retention vs interval ─────────────────────────────────────────────────
  targetLine(target: string): string;
  readonly noObservation: string;
  bucketElapsedTip(label: string, retention: string, reviews: string, lapses: string): string;
  bucketScheduledTip(label: string, retention: string, reviews: string): string;
  retentionAria(target: string): string;
  volumeElapsedTip(label: string, reviews: string): string;
  volumeScheduledTip(label: string, reviews: string): string;
  readonly volumeAria: string;
  intervalDef(target: string): string;
  readonly intervalVolumeHeading: string;
  intervalLegend(target: string): string;
  /**
   * Takes STRUCTURE, not pre-built phrases. The "no bucket is below target" case
   * and the "only these N bands" case are different sentences in each language,
   * and building them at the call site would have hard-coded Japanese grammar
   * into a locale-neutral file.
   */
  intervalRead(
    target: string,
    below: readonly string[],
    worst: { readonly label: string; readonly pct: string } | null,
    longest: string,
    longestPct: string,
  ): string;
  beyondYearDef(
    label: string,
    elapsedReviews: string,
    elapsedRetention: string,
    scheduledReviews: string,
    planned: string,
    maxPlanned: string,
    tracks: string,
    firstDue: string,
    lastDue: string,
  ): string;
  capDef(
    liftedOn: string | null,
    planned: string,
    maxPlanned: string,
    cap: string,
    atCap: string,
    withPlan: string,
    atCapPct: string,
    onStaleCap: string,
    maxObserved: string,
  ): string;
  readonly bucketsTableSummary: string;
  readonly bucketsTableHead: readonly string[];

  // ── deck retention ────────────────────────────────────────────────────────
  readonly forward: string;
  readonly reverse: string;
  deckDotTip(path: string, name: string, value: string, reviews: string, small: boolean): string;
  deckAria(target: string): string;
  deckDef(overall: string, min: string): string;
  deckLegend(target: string, smallSample: string): string;
  deckRead(highest: string, highestPct: string, lowest: string, lowestPct: string, spread: string): string;
  readonly decksTableSummary: string;
  readonly decksTableHead: readonly string[];

  // ── deck progress ─────────────────────────────────────────────────────────
  readonly progressNew: string;
  readonly progressYoung: string;
  readonly progressMature: string;
  progressTip(path: string, name: string, value: string, tracks: string): string;
  readonly progressAria: string;
  progressDef(tracks: string, dormant: string, min: string): string;
  readonly progressLegend: string;
  readonly progressTableSummary: string;
  readonly progressTableHead: readonly string[];

  // ── forecast ──────────────────────────────────────────────────────────────
  forecastTip(date: string, tracks: string): string;
  forecastAria(asOf: string, days: string, backlog: string): string;
  forecastDef(asOf: string, days: string, total: string, perDay: string, backlog: string, overdue: string, fresh: string): string;
  forecastProvenance(own: string, mochi: string, hashigo: string): string;
  forecastTableSummary(days: string): string;
  readonly forecastTableHead: readonly string[];

  // ── Mochi reconciliation ──────────────────────────────────────────────────
  readonly match: string;
  mochiDef(first: string, last: string): string;
  readonly mochiTableHead: readonly string[];
  /**
   * The reconciliation rows' names and notes, keyed by `MochiReference.key`.
   *
   * These used to live as Japanese literals in `metrics.ts`, which made them the
   * one class of UI text the locale could not reach — the English page carried
   * `定着率` and `下の注記を参照` in its own table. The FIGURES stay in metrics.ts
   * (they are the reference data, and it has exactly one home, deliberately);
   * only the words moved.
   */
  mochiRowLabel(key: string): string;
  mochiRowNote(key: string): string;
  /**
   * `unexplained` is the SHARE the leading hypothesis fails to account for, or
   * null when there is nothing to account for. Passed as a figure rather than as
   * a finished clause — the clause was being written in Japanese at the call site,
   * which put one language's grammar inside a locale-neutral renderer.
   */
  mochiRead(
    gap: string,
    fewer: string,
    imported: string,
    cardDays: string,
    mochiReviews: string,
    drift: string,
    unexplained: string | null,
  ): string;

  // ── glossary and footer ───────────────────────────────────────────────────
  readonly glossaryHeading: string;
  readonly glossary: readonly (readonly [string, string])[];
  readonly aboutHeading: string;
  about(activeDays: string): string;
}

// ─── Japanese: the strings exactly as the page shipped them ──────────────────

export const JA: Labels = {
  locale: "ja",

  pageTitle: "Hashigo · 学習ダッシュボード",
  h1: "学習ダッシュボード",
  eyebrow: "Hashigo 梯子 · Stage 2 · read-only",
  lede:
    "インポート済みの復習ログだけを読む静的ページ。すべての数字は生成時に確定" +
    "していて、スクリプトも外部リクエストもない。これは同時にインポータの受け入れテストで" +
    "もある — Mochi 自身のダッシュボードが既知の正解を持っているので、一致すればインポート" +
    "は正しい。",
  metaSource: "データ元",
  metaGenerated: "生成",
  metaSchema: "スキーマ",
  metaSpan: "期間",
  metaTimezone: "タイムゾーン",
  metaTimezoneValue: "各復習の tz_offset で日付を切る（UTC ではない）",
  noData: "データなし",
  section: (ja, latin) => `${ja} <span class="latin">${latin}</span>`,
  headingIntervalRetention:
    '定着率 × 復習間隔 <span class="latin">retention vs interval — Mochi にはないタイル</span>',
  headingDeckRetention:
    'デッキ別定着率 <span class="latin">retention by deck — Mochi にはないタイル</span>',
  windowLabel: (_id, label) => label,

  tileReviews: "復習数",
  tileRetention: "定着率",
  tileStudyTime: "復習時間",
  tileCardsStudied: "学習カード数",
  tileActiveDays: "活動日数",
  tileLapses: "失敗",
  tilePerDay: "1日あたり",
  tilePerReview: "1回あたり",
  unitHours: "時間",
  unitTimes: "回",
  unitSeconds: "秒",
  unitPoints: " ポイント",
  tileReviewsSub: (f, r) => `採点イベント、全トラック（順方向 ${f} / 逆方向 ${r}）`,
  tileRetentionSub: (p, l, t, d) => `合格 ${p} / 失敗 ${l} · 目標 ${t} に対して ${d} ポイント`,
  tileStudyTimeSub: (d, t) => `${d}日ぶん · 所要時間を持つ復習 ${t}`,
  tileCardsStudiedSub: (t) => `1回以上採点されたカード。全カード ${t} 枚のうち`,
  tileActiveDaysSub: (s) => `1回以上採点した日 / 経過 ${s}日（両端を含む）`,
  tileLapsesSub: (s) => `「覚えていない」と採点した回数。${s}`,
  tilePerDaySub: "活動日で割った値。休んだ日は含めない",
  tilePerReviewSub: (m) => `中央値。平均は ${m}秒 — 裾が長い`,

  totalsDef: (from, to, days, untimed) =>
    `窓 = ${from} 〜 ${to}（両端を含む ${days}日）。復習数は採点イベント数で、` +
    `1枚のカードの順方向と逆方向は別に数える。定着率 = 合格 / 全採点イベント。` +
    `復習時間 = duration の合計で、${untimed}件は所要時間を持たないため時間には寄与しない。`,
  totalsRead: (target, delta) =>
    `読み: <b>96% を超える定着率は、間隔が必要より短いという意味</b>。` +
    `設定した目標は ${target}（FSRS 既定の 90% ではなく、Zach が決めた値）で、` +
    `いまの位置はそれより ${delta} ポイント上にある。すでに持っている定着率のために毎日の復習を払っている、` +
    `というのが SPEC の指摘で、下の「定着率 × 復習間隔」がその payment を可視化する。`,
  totalsClock: (unknown) =>
    `時刻について: ${unknown}件すべてが time_unknown = 1。Mochi は日付だけを保存し JST 深夜を書いていたので、` +
    `時刻帯別の分析は原理的に不可能。だから 00:00 の偽のピークを作らず、` +
    `retention_by_hour は空のままにしてある。`,

  weekdays: [
    [1, "月"],
    [3, "水"],
    [5, "金"],
  ],
  month: (m) => `${m}月`,
  heatDay: (date, reviews, retention, minutes) =>
    `${date} · ${reviews}回 · 定着率 ${retention} · ${minutes}分`,
  heatDayEmpty: (date) => `${date} · 学習なし`,
  heatAria: (year) => `${year}年の活動ヒートマップ。1日1マス、色は復習数の四分位。`,
  yearStrip: (year, reviews, days, retention) =>
    `${year}年 · ${reviews}回 · ${days}日 · 定着率 ${retention}`,
  yearTableSummary: (year, rows) => `${year}年の1日ごとの数字を表で見る（${rows}日）`,
  yearTableHead: ["日付", "復習数", "カード数", "定着率", "分", "新規"],
  heatLegendTitle: "1日の復習数",
  heatLegendMore: "+",
  activityDef:
    "1マスが1日。色は復習数の四分位で、全期間で共通のしきい値を使うので年どうしを" +
    "比較できる。学習しなかった日は 0 の独立した色 — 「1回だけやった日」と同じ色にしない。" +
    "日付は各復習の tz_offset で切る。",
  activityRead: (activeDays, elapsedDays, share) =>
    `全期間で <b>${activeDays}日</b>が活動日、経過 ${elapsedDays}日のうち ${share}。`,
  yearsTableSummary: "年ごとの数字を表で見る",
  yearsTableHead: ["年", "復習数", "活動日数", "学習カード数", "定着率", "時間"],
  yearRow: (year) => `${year}年`,

  cumulativeAria: (first, last, cards) =>
    `累計学習カード数の推移。${first} の 0 枚から ${last} の ${cards} 枚まで。`,
  cumulativeCap: (cards) => `${cards}枚`,
  monthlyTip: (month, cards, fresh, reviews) =>
    `${month} · ${cards}枚 · 新規 ${fresh}枚 · ${reviews}回`,
  monthlyAria: (month, peak) => `月ごとに学習したカード数。最大は ${month} の ${peak} 枚。`,
  cumulativeDef: (final) =>
    `累計 = その日までに1回以上採点されたカードの実数（重複なし）。` +
    `最終値 ${final} は全期間の学習カード数と定義上一致する。` +
    `月ごとの棒はその月に採点されたカードの実数で、月をまたぐと同じカードが再度数えられる` +
    `ため合計しても累計にはならない。`,
  cumulativeRead: (total, studied, untouched) =>
    `全 ${total} 枚のうち <b>${studied} 枚</b>が一度でも採点されている。残り ${untouched} 枚は未着手（reps = 0）。`,
  monthlyHeading: "月ごとの学習カード数",
  monthsTableSummary: "月ごとの数字を表で見る",
  monthsTableHead: ["月", "復習数", "学習カード数", "新規カード", "定着率", "時間"],

  targetLine: (t) => `目標 ${t}`,
  noObservation: "観測なし",
  bucketElapsedTip: (label, retention, reviews, lapses) =>
    `${label} · 定着率 ${retention} · ${reviews}回 · 失敗 ${lapses}`,
  bucketScheduledTip: (label, retention, reviews) =>
    `${label}（予定 scheduled）· 定着率 ${retention} · ${reviews}回`,
  retentionAria: (target) =>
    `直前の復習間隔ごとの定着率。実測(elapsed)と予定(scheduled)の2系列。目標 ${target} の線からの高さが余剰。`,
  volumeElapsedTip: (label, reviews) => `${label}（実測 elapsed）· ${reviews}回`,
  volumeScheduledTip: (label, reviews) => `${label}（予定 scheduled）· ${reviews}回`,
  volumeAria: "復習間隔ごとの復習回数。",
  intervalDef: (target) =>
    `横軸は<strong>直前の</strong>復習間隔。境界は views.sql の ` +
    `review_log_bucketed で一度だけ定義され、ここでは名前を並べるだけ。` +
    `<strong>「間隔」には2つの定義があり、この図は両方を描く</strong>：` +
    `<b>実測 elapsed</b>（<code>reviews.elapsed_days</code>＝実際に空いた日数、塗りつぶし）と、` +
    `<b>予定 scheduled</b>（<code>reviews.scheduled_days</code>＝スケジューラが空けるつもりだった日数、破線の中抜き）。` +
    `unknown はその定義での直前間隔が存在しない復習。線は目標 ${target}。`,
  intervalVolumeHeading: "各バケットの復習回数（実測 / 予定）",
  intervalLegend: (target) =>
    `<span><i style="background:var(--series-1)"></i>実測 elapsed（実際に空いた日数）</span>` +
    `<span><i style="background:var(--series-2)"></i>予定 scheduled（予定していた日数）</span>` +
    `<span>横の実線 = 目標 ${target}</span>`,
  intervalRead: (target, below, worst, longest, longestPct) =>
    `読み: 目標 ${target} を下回るのは実測で` +
    `${below.length === 0 ? "どのバケットでもない" : `<b>${below.join("・")}</b> の${below.length}帯だけ`}` +
    `、最も悪い${worst === null ? "" : ` <b>${worst.label} で ${worst.pct}</b>`}。` +
    `それ以外の帯は目標より上、すなわち<b>必要より短い間隔で復習している</b>。` +
    `最長の観測帯 ${longest} でも ${longestPct} で、` +
    `これが「間隔を伸ばす余地がある」という主張の実データ。`,
  beyondYearDef: (label, er, ert, sr, planned, maxPlanned, tracks, firstDue, lastDue) =>
    `<b>2つの定義が ${label} で完全に食い違う理由</b>。` +
    `実測では ${er}回 / 定着率 ${ert}、予定では ${sr}回。予定が0なのは Mochi が1年より先を予定しなかったからではなく` +
    `（${planned}回予定しており、最長 ${maxPlanned}日）、` +
    `<code>scheduled_days</code> は「直前の復習が予定した間隔」なので、` +
    `<strong>その予定に対応する復習がまだ行われていない</strong>ぶんは集計に現れないため。` +
    `${tracks}件のトラックが1年超で予定されているが、期日は ${firstDue} 〜 ${lastDue} で1件も来ていない。` +
    `だからこのページは<strong>実測を観測値として読む</strong>。BACKTEST.md も同じ基準で採点しており、` +
    `${label} の件数は両方で ${er} で一致する。`,
  capDef: (liftedOn, planned, maxPlanned, cap, atCap, withPlan, atCapPct, onStaleCap, maxObserved) =>
    `<b>365日の上限は${liftedOn === null ? "解除されていない" : `${liftedOn} に解除された`}</b>。` +
    `${liftedOn === null ? "" : `それ以前に1年超を予定した復習は0件、以後は ${planned}件（最長 ${maxPlanned}日）。`}` +
    `いま上限ちょうど（${cap}日）に止まっているトラックは ${atCap} / ${withPlan}件 = ${atCapPct}。` +
    `${liftedOn === null ? "" : `うち <b>${onStaleCap}件</b>は最後の復習が解除より前で、` +
      `解除後の Mochi なら選ばなかったはずの古い予定のまま止まっている — これが実際に残っている制約。`}` +
    `ただし実際に経過した最長間隔は ${maxObserved}日なので、` +
    `そこから先はどちらにせよ観測の外側（外挿）になる。`,
  bucketsTableSummary: "バケットごとの数字を表で見る（実測と予定を並べて）",
  bucketsTableHead: [
    "直前の間隔",
    "実測 復習数",
    "実測 失敗",
    "実測 定着率",
    "実測 平均日数",
    "予定 復習数",
    "予定 定着率",
    "予定 平均日数",
  ],

  forward: "順方向",
  reverse: "逆方向",
  deckDotTip: (path, name, value, reviews, small) =>
    `${path} · ${name} ${value} · ${reviews}回` + (small ? "（標本が小さい）" : ""),
  deckAria: (target) =>
    `デッキごとの順方向・逆方向の定着率。${target} の線が目標。最高と最低に値を表示。`,
  deckDef: (overall, min) =>
    `全体 ${overall} は変動を隠す。ここは直接カードを持つデッキ（そのデッキ自身の復習 ${min}回以上）を復習数の多い順に並べ、順方向と逆方向を別の点で描いたもの。` +
    `点も選抜も<strong>そのデッキ自身の復習だけ</strong>で、子デッキを含む小計は表の側にある` +
    `（同じ行に2つの分母を混ぜないため）。2点を結ぶ細線がその差。`,
  deckLegend: (target, smallSample) =>
    `<span><i style="background:var(--series-1)"></i>順方向 forward</span>` +
    `<span><i style="background:var(--series-2)"></i>逆方向 reverse</span>` +
    `<span>縦の実線 = 目標 ${target}</span>` +
    `<span>中抜きの点 = ${smallSample}回未満（標本が小さい）</span>`,
  deckRead: (highest, highestPct, lowest, lowestPct, spread) =>
    `復習500回以上のデッキで、<b>${highest} ${highestPct}</b> から <b>${lowest} ${lowestPct}</b> まで ${spread} ポイントの幅がある。目標定着率がデッキごとの設定であるべき理由がこれ。`,
  decksTableSummary: "全デッキを表で見る",
  decksTableHead: [
    "デッキ",
    "復習数（小計）",
    "復習数（自身）",
    "失敗",
    "定着率（自身）",
    "順方向（自身）",
    "逆方向（自身）",
    "定着率（小計）",
    "時間（小計）",
  ],

  progressNew: "未学習",
  progressYoung: "学習中",
  progressMature: "定着",
  progressTip: (path, name, value, tracks) => `${path} · ${name} ${value} / ${tracks}トラック `,
  progressAria: "デッキごとのトラックの状態の割合。未学習・学習中・定着。行末は総トラック数。",
  progressDef: (tracks, dormant, min) =>
    `数えているのはカードではなく<strong>トラック</strong>: 逆方向が有効な` +
    `カードは2トラック。全 ${tracks} トラック。` +
    `未学習 = reps 0、学習中 = 現在の間隔 21日未満、定着 = 21日以上（views.sql の` +
    ` deck_progress の定義そのまま）。休眠（逆方向を後から切ったトラック）は ${dormant}件なので描いていない。この図は直接カードを持つデッキのみ、` +
    `トラック ${min}件以上。`,
  progressLegend:
    `<span><i style="background:var(--ord-1)"></i>未学習 new</span>` +
    `<span><i style="background:var(--ord-2)"></i>学習中 young &lt; 21d</span>` +
    `<span><i style="background:var(--ord-3)"></i>定着 mature ≥ 21d</span>`,
  progressTableSummary: "全デッキを表で見る（小計込み）",
  progressTableHead: ["デッキ", "カード", "トラック", "未学習", "学習中", "定着", "休眠", "失敗回数"],

  forecastTip: (date, tracks) => `${date} · ${tracks}件`,
  forecastAria: (asOf, days, backlog) =>
    `${asOf} の翌日から ${days} 日間に予定されている復習件数。当日以前の ${backlog} 件は含まない。`,
  forecastDef: (asOf, days, total, perDay, backlog, overdue, fresh) =>
    `${asOf} 時点。翌日から ${days} 日間で <strong>${total}</strong> 件（1日あたり ${perDay} 件）。` +
    `当日以前に期限が来ている <strong>${backlog}</strong> 件（うち ${overdue} 件は前日以前）は棒グラフに含まない — ` +
    `それは予測ではなく残務だから。未学習の ${fresh} 件も予定日を持たないため含まない。`,
  forecastProvenance: (own, mochi, hashigo) =>
    `<strong>この棒の出どころ。</strong> 期限が先の ${own} 件のうち、` +
    `Mochi から取り込んだ予定日が <strong>${mochi}</strong> 件、` +
    `Hashigo が出した予定日が <strong>${hashigo}</strong> 件。` +
    `取り込んだトラックは、ここで採点されるまで Mochi の予定日を保持する（意図的）。` +
    `したがってこのグラフは、採点のたびに1件ずつ Hashigo のものになる。`,
  forecastTableSummary: (days) => `日ごとの内訳（${days} 日）`,
  forecastTableHead: ["日付", "件数"],

  match: "一致",
  mochiDef: (first, last) =>
    `Mochi 側の数字はユーザのダッシュボードのスクリーンショットから` +
    `（notes/dashboard-reconciliation.md）。<strong>こちらの数字を Mochi に合わせて調整は` +
    `していない。</strong>活動日数と定着率が完全一致することは、窓の取り方とトラックの` +
    `選び方が正しいことを示す。ただし<strong>タイムゾーンの受け入れシグナルではない</strong>` +
    `— この窓では 2026-01-01 と 2025-12-31 のどちらにも復習がないので、日付を JST で切っても` +
    `UTC で切っても 2026 年の数字は 14,420 回 / 211 日で変わらない（測定済み）。JST を実際に` +
    `固定しているのは全期間の初日 ${first} と最終日 ${last} で、UTC で切ると両方とも1日ずれる。`,
  mochiTableHead: ["指標", "Mochi", "Hashigo", "差", "判定"],
  mochiRowLabel: (key) =>
    ({
      reviews: "復習数",
      daysElapsed: "日数",
      activeDays: "活動日数",
      retention: "定着率",
      cardsStudied: "累計学習カード数",
    })[key] ?? key,
  mochiRowNote: (key) =>
    ({
      reviews: "定義の差。下の注記を参照",
      daysElapsed: "両端を含む数え方。2026-08-19 時点で一致",
      activeDays: "完全一致",
      retention: "完全一致（表示桁で）",
      cardsStudied: "−68。窓内で学習した実カード数",
    })[key] ?? "",
  mochiRead: (gap, fewer, imported, cardDays, mochiReviews, drift, unexplained) =>
    `復習数の差 ${gap} 件（Mochi 側がこちらより ${fewer} 少ない）は、インポートの誤りではない — インポートは ${imported} 件でエクスポートとバイト一致している。` +
    `候補となる定義を8つ試して却下した記録が notes/dashboard-reconciliation.md にある。` +
    `最有力は「1日1カード1回として数える」で、この窓では <b>${cardDays}</b> 件 — Mochi の ${mochiReviews} とは ${drift} 件ずれる。` +
    `${unexplained === null ? "" : `${unexplained} の差を説明できないので、`}仮説として書いておくだけにして、` +
    `表示する数字は定義がはっきりしている採点イベント数のままにした。`,

  glossaryHeading: "この表の言葉の定義",
  glossary: [
    ["復習数", "採点イベントの数。全トラック（順方向・逆方向・cloze）を数える。"],
    ["学習カード数", "窓の中で1回以上採点されたカードの実数。"],
    ["活動日数", "1回以上採点した日の数。日付は各復習の tz_offset で切る（UTC ではない）。"],
    ["日数", "両端を含む。窓の終わりは最後の復習日で止める。"],
    ["定着率", "合格 / 全採点イベント。"],
    ["復習時間", "duration の合計。所要時間を持たない復習は寄与しない。"],
    [
      "直前の間隔",
      "その復習が何日ぶりだったか。Mochi の <code>interval</code> は<em>次の</em>間隔なので、インポート時に前のレコードから導出している。",
    ],
  ],
  aboutHeading: "このページについて",
  about: (activeDays) =>
    `src/dashboard/render.ts が生成。スクリプトなし、外部リクエストなし、フォント読み込み` +
    `なし — 電波を切った端末で file:// から開ける。集計図にはすべて対応する表が付いている` +
    `（年別・月別・バケット別・デッキ別）。<b>活動ヒートマップの日ごとの値も、年ごとの表に` +
    `${activeDays}日ぶんすべて入っている — 値を持つ日はどれも表から読める。値を持たない日は` +
    `マスの <code>title</code> だけだが、そこには数字がない。</b>色はライト・ダークで別々に` +
    `選び、data-viz バリデータを通してある。`,
};

// ─── English: the default ────────────────────────────────────────────────────
//
// Not a gloss of the Japanese. Where the Japanese sentence is built around a
// counter or a topic marker the English is rewritten to read as English, and the
// technical vocabulary is the one BACKTEST.md and the module docs already use
// (elapsed / scheduled / retention / lapse / track) so the page and the repo say
// the same words for the same things.

export const EN: Labels = {
  locale: "en",

  pageTitle: "Hashigo · study dashboard",
  h1: "Study dashboard",
  eyebrow: "Hashigo 梯子 · Stage 2 · read-only",
  lede:
    "A static page that reads nothing but the imported review log. Every figure is " +
    "fixed at generation time; there is no script and no outbound request. It is also " +
    "the importer's acceptance test — Mochi's own dashboard is a known-correct answer, " +
    "so agreement means the import is right.",
  metaSource: "source",
  metaGenerated: "generated",
  metaSchema: "schema",
  metaSpan: "span",
  metaTimezone: "timezone",
  metaTimezoneValue: "dates cut by each review's own tz_offset, not by UTC",
  noData: "no data",
  // Under `en` the Latin subtitle IS the heading, so it is not repeated.
  section: (_ja, latin) => latin,
  headingIntervalRetention: 'retention vs interval <span class="latin">a tile Mochi lacks</span>',
  headingDeckRetention: 'retention by deck <span class="latin">a tile Mochi lacks</span>',
  windowLabel: (id, _label) => id,

  tileReviews: "reviews",
  tileRetention: "retention",
  tileStudyTime: "study time",
  tileCardsStudied: "cards studied",
  tileActiveDays: "active days",
  tileLapses: "lapses",
  tilePerDay: "per active day",
  tilePerReview: "per review",
  unitHours: "h",
  unitTimes: "",
  unitSeconds: "s",
  unitPoints: " points",
  tileReviewsSub: (f, r) => `grading events, all tracks (forward ${f} / reverse ${r})`,
  tileRetentionSub: (p, l, t, d) => `${p} passed / ${l} lapsed · ${d} points against a ${t} target`,
  tileStudyTimeSub: (d, t) => `${d} days' worth · ${t} reviews carry a duration`,
  tileCardsStudiedSub: (t) => `cards graded at least once, of ${t} in the collection`,
  tileActiveDaysSub: (s) => `days with at least one grading / ${s} elapsed, both ends included`,
  tileLapsesSub: (s) => `graded "forgot" this many times — ${s}`,
  tilePerDaySub: "divided by active days only; days off are not counted",
  tilePerReviewSub: (m) => `median. The mean is ${m}s — the tail is long`,

  totalsDef: (from, to, days, untimed) =>
    `Window = ${from} to ${to}, ${days} days with both ends included. Reviews are grading ` +
    `events: one card's forward and reverse directions are counted separately. Retention = ` +
    `passed / all grading events. Study time is the sum of durations, and ${untimed} reviews ` +
    `carry none, so they contribute nothing to it.`,
  totalsRead: (target, delta) =>
    `Read it this way: <b>retention above 96% means the intervals are shorter than they need ` +
    `to be</b>. The target set here is ${target} — Zach's choice, not FSRS's default of 90% — ` +
    `and the collection sits ${delta} points above it. Paying for retention you already have, ` +
    `every day, is SPEC's objection, and "retention vs interval" below is what makes that ` +
    `payment visible.`,
  totalsClock: (unknown) =>
    `On times of day: all ${unknown} reviews carry time_unknown = 1. Mochi stored the date only ` +
    `and wrote midnight JST, so an hour-of-day analysis is impossible in principle. Rather than ` +
    `manufacture a false spike at 00:00, retention_by_hour is left empty.`,

  weekdays: [
    [1, "Mon"],
    [3, "Wed"],
    [5, "Fri"],
  ],
  month: (m) =>
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      m - 1
    ] ?? String(m),
  heatDay: (date, reviews, retention, minutes) =>
    `${date} · ${reviews} reviews · ${retention} retention · ${minutes} min`,
  heatDayEmpty: (date) => `${date} · no study`,
  heatAria: (year) =>
    `Activity heatmap for ${year}. One cell per day; colour is the quartile of the review count.`,
  yearStrip: (year, reviews, days, retention) =>
    `${year} · ${reviews} reviews · ${days} days · ${retention} retention`,
  yearTableSummary: (year, rows) => `see ${year} day by day as a table (${rows} days)`,
  yearTableHead: ["date", "reviews", "cards", "retention", "min", "new"],
  heatLegendTitle: "reviews in a day",
  heatLegendMore: "+",
  activityDef:
    "One cell is one day. Colour is the quartile of the review count, using thresholds shared " +
    "across the whole span so one year is comparable with the next. A day with no study gets " +
    "its own colour for zero — never the same colour as a day with one review. Dates are cut " +
    "by each review's own tz_offset.",
  activityRead: (activeDays, elapsedDays, share) =>
    `<b>${activeDays} days</b> of the ${elapsedDays} elapsed were active — ${share}.`,
  yearsTableSummary: "see the per-year figures as a table",
  yearsTableHead: ["year", "reviews", "active days", "cards studied", "retention", "hours"],
  yearRow: (year) => year,

  cumulativeAria: (first, last, cards) =>
    `Cumulative cards studied, from 0 on ${first} to ${cards} on ${last}.`,
  cumulativeCap: (cards) => `${cards} cards`,
  monthlyTip: (month, cards, fresh, reviews) =>
    `${month} · ${cards} cards · ${fresh} new · ${reviews} reviews`,
  monthlyAria: (month, peak) =>
    `Cards studied per month. The largest is ${month} at ${peak} cards.`,
  cumulativeDef: (final) =>
    `Cumulative = distinct cards graded at least once up to that day, no double counting. The ` +
    `final value ${final} agrees with the all-time cards-studied figure by definition. The ` +
    `monthly bars are distinct cards graded in that month, so a card crossing a month boundary ` +
    `is counted again and the bars do not sum to the cumulative line.`,
  cumulativeRead: (total, studied, untouched) =>
    `<b>${studied}</b> of ${total} cards have been graded at least once. The remaining ` +
    `${untouched} are untouched (reps = 0).`,
  monthlyHeading: "Cards studied per month",
  monthsTableSummary: "see the per-month figures as a table",
  monthsTableHead: ["month", "reviews", "cards studied", "new cards", "retention", "hours"],

  targetLine: (t) => `target ${t}`,
  noObservation: "no observation",
  bucketElapsedTip: (label, retention, reviews, lapses) =>
    `${label} · ${retention} retention · ${reviews} reviews · ${lapses} lapses`,
  bucketScheduledTip: (label, retention, reviews) =>
    `${label} (scheduled) · ${retention} retention · ${reviews} reviews`,
  retentionAria: (target) =>
    `Retention by the preceding review interval, in two series: elapsed and scheduled. Height ` +
    `above the ${target} target line is the surplus.`,
  volumeElapsedTip: (label, reviews) => `${label} (elapsed) · ${reviews} reviews`,
  volumeScheduledTip: (label, reviews) => `${label} (scheduled) · ${reviews} reviews`,
  volumeAria: "Review counts by interval.",
  intervalDef: (target) =>
    `The x axis is the <strong>preceding</strong> review interval. The boundaries are defined ` +
    `exactly once, in views.sql's review_log_bucketed; this page only names them. ` +
    `<strong>"Interval" has two definitions and this chart draws both</strong>: ` +
    `<b>elapsed</b> (<code>reviews.elapsed_days</code> — the gap that actually happened, filled) ` +
    `and <b>scheduled</b> (<code>reviews.scheduled_days</code> — the gap the scheduler intended, ` +
    `dashed and hollow). "unknown" is a review with no preceding interval under that definition. ` +
    `The line is the ${target} target.`,
  intervalVolumeHeading: "Reviews per bucket (elapsed / scheduled)",
  intervalLegend: (target) =>
    `<span><i style="background:var(--series-1)"></i>elapsed — the gap that happened</span>` +
    `<span><i style="background:var(--series-2)"></i>scheduled — the gap intended</span>` +
    `<span>horizontal line = ${target} target</span>`,
  intervalRead: (target, below, worst, longest, longestPct) =>
    `Read it this way: on the elapsed basis the ${target} target is missed ` +
    `${
      below.length === 0
        ? "in no bucket at all"
        : `in ${below.length === 1 ? "one band" : `${below.length} bands`} — <b>${below.join(", ")}</b>`
    }` +
    `${worst === null ? "" : `, worst at <b>${worst.label}, ${worst.pct}</b>`}. ` +
    `Every other band is ABOVE target, which means <b>reviewing at shorter intervals than ` +
    `necessary</b>. Even the longest observed band, ${longest}, sits at ${longestPct} — and that ` +
    `is the evidence behind the claim that these intervals have room to grow.`,
  beyondYearDef: (label, er, ert, sr, planned, maxPlanned, tracks, firstDue, lastDue) =>
    `<b>Why the two definitions disagree completely at ${label}</b>. Elapsed shows ${er} reviews ` +
    `at ${ert} retention; scheduled shows ${sr}. Scheduled is zero not because Mochi never ` +
    `planned beyond a year — it planned ${planned} of them, out to ${maxPlanned} days — but ` +
    `because <code>scheduled_days</code> means "the interval the PRECEDING review planned", so ` +
    `anything whose <strong>matching review has not happened yet</strong> cannot appear in the ` +
    `aggregate. ${tracks} tracks are planned beyond a year, and their due dates run ${firstDue} ` +
    `to ${lastDue}: not one has arrived. That is why this page <strong>reads elapsed as the ` +
    `observation</strong>. BACKTEST.md scores on the same basis, and the ${label} count agrees at ` +
    `${er} in both.`,
  capDef: (liftedOn, planned, maxPlanned, cap, atCap, withPlan, atCapPct, onStaleCap, maxObserved) =>
    `<b>The 365-day cap ${liftedOn === null ? "has not been lifted" : `was lifted on ${liftedOn}`}</b>. ` +
    `${liftedOn === null ? "" : `Before that, zero reviews were planned beyond a year; since, ${planned} have been, out to ${maxPlanned} days. `}` +
    `Tracks sitting on exactly the cap (${cap} days) number ${atCap} of ${withPlan} = ${atCapPct}. ` +
    `${liftedOn === null ? "" : `Of those, <b>${onStaleCap}</b> were last reviewed BEFORE the lift, so they are parked on a plan a post-lift Mochi would not have chosen — that is the constraint still actually in force. `}` +
    `The longest interval that has actually elapsed, though, is ${maxObserved} days, so beyond ` +
    `that everything is outside observation either way.`,
  bucketsTableSummary: "see the per-bucket figures as a table, elapsed beside scheduled",
  bucketsTableHead: [
    "preceding interval",
    "elapsed reviews",
    "elapsed lapses",
    "elapsed retention",
    "elapsed mean days",
    "scheduled reviews",
    "scheduled retention",
    "scheduled mean days",
  ],

  forward: "forward",
  reverse: "reverse",
  deckDotTip: (path, name, value, reviews, small) =>
    `${path} · ${name} ${value} · ${reviews} reviews` + (small ? " (small sample)" : ""),
  deckAria: (target) =>
    `Forward and reverse retention per deck. The ${target} line is the target. The highest and ` +
    `lowest carry their values.`,
  deckDef: (overall, min) =>
    `The overall ${overall} hides the variation. This charts decks that hold cards directly, ` +
    `with at least ${min} reviews of their own, ordered by review count, with forward and reverse ` +
    `as separate points. Both the points and the selection use <strong>that deck's own reviews ` +
    `only</strong>; subtotals including child decks are in the table instead, so no row mixes two ` +
    `denominators. The thin line joining the pair is the gap between them.`,
  deckLegend: (target, smallSample) =>
    `<span><i style="background:var(--series-1)"></i>forward</span>` +
    `<span><i style="background:var(--series-2)"></i>reverse</span>` +
    `<span>vertical line = ${target} target</span>` +
    `<span>hollow point = fewer than ${smallSample} reviews (small sample)</span>`,
  deckRead: (highest, highestPct, lowest, lowestPct, spread) =>
    `Among decks with 500 or more reviews, the range runs from <b>${highest} ${highestPct}</b> ` +
    `down to <b>${lowest} ${lowestPct}</b> — ${spread} points. This is why target retention ` +
    `should be a per-deck setting.`,
  decksTableSummary: "see every deck as a table",
  decksTableHead: [
    "deck",
    "reviews (subtree)",
    "reviews (own)",
    "lapses",
    "retention (own)",
    "forward (own)",
    "reverse (own)",
    "retention (subtree)",
    "hours (subtree)",
  ],

  progressNew: "new",
  progressYoung: "young",
  progressMature: "mature",
  progressTip: (path, name, value, tracks) => `${path} · ${name} ${value} of ${tracks} tracks `,
  progressAria:
    "Share of track states per deck: new, young, mature. The figure at the end of each row is the total track count.",
  progressDef: (tracks, dormant, min) =>
    `What is counted is <strong>tracks</strong>, not cards: a card with reverse enabled is two ` +
    `tracks. ${tracks} tracks in all. New = reps 0; young = current interval under 21 days; ` +
    `mature = 21 days or more (exactly views.sql's deck_progress definition). Dormant tracks — ` +
    `reverse switched off after the fact — number ${dormant}, so they are not drawn. This chart ` +
    `covers only decks holding cards directly, with at least ${min} tracks.`,
  progressLegend:
    `<span><i style="background:var(--ord-1)"></i>new — reps 0</span>` +
    `<span><i style="background:var(--ord-2)"></i>young &lt; 21d</span>` +
    `<span><i style="background:var(--ord-3)"></i>mature ≥ 21d</span>`,
  progressTableSummary: "see every deck as a table, subtotals included",
  progressTableHead: ["deck", "cards", "tracks", "new", "young", "mature", "dormant", "lapses"],

  forecastTip: (date, tracks) => `${date} · ${tracks} due`,
  forecastAria: (asOf, days, backlog) =>
    `Reviews scheduled for the ${days} days after ${asOf}. The ${backlog} already due on or before that date are excluded.`,
  forecastDef: (asOf, days, total, perDay, backlog, overdue, fresh) =>
    `As of ${asOf}. Over the ${days} days that follow, <strong>${total}</strong> reviews are ` +
    `scheduled — ${perDay} a day. The <strong>${backlog}</strong> already due on or before that ` +
    `date (${overdue} of them from earlier still) are NOT in the bars: that is a backlog, not a ` +
    `forecast. The ${fresh} unstudied cards are excluded too, because they carry no due date.`,
  forecastProvenance: (own, mochi, hashigo) =>
    `<strong>Where these bars come from.</strong> Of the ${own} due in future, ` +
    `<strong>${mochi}</strong> carry a due date imported from Mochi and ` +
    `<strong>${hashigo}</strong> carry one Hashigo issued. An imported track keeps Mochi's due ` +
    `date until it is graded here — deliberately. So this chart becomes Hashigo's one card at a ` +
    `time, with every grade.`,
  forecastTableSummary: (days) => `see the daily breakdown (${days} days)`,
  forecastTableHead: ["date", "due"],

  match: "match",
  mochiDef: (first, last) =>
    `Mochi's figures come from a screenshot of the user's own dashboard ` +
    `(notes/dashboard-reconciliation.md). <strong>Nothing here has been tuned to agree with ` +
    `them.</strong> Active days and retention matching exactly shows the window and the track ` +
    `selection are right. It is <strong>not</strong> an acceptance signal for the timezone, ` +
    `though — in this window there is no review on either 2026-01-01 or 2025-12-31, so cutting ` +
    `dates by JST or by UTC gives the same 14,420 reviews over 211 days for 2026 (measured). What ` +
    `actually pins JST is the all-time span: the first day ${first} and the last ${last} both ` +
    `shift by one under UTC.`,
  mochiTableHead: ["metric", "Mochi", "Hashigo", "diff", "verdict"],
  mochiRowLabel: (key) =>
    ({
      reviews: "reviews",
      daysElapsed: "days",
      activeDays: "active days",
      retention: "retention",
      cardsStudied: "cumulative cards studied",
    })[key] ?? key,
  mochiRowNote: (key) =>
    ({
      reviews: "a difference of definition — see the note below",
      daysElapsed: "both ends counted; agrees as of 2026-08-19",
      activeDays: "exact match",
      retention: "exact match, to the digits shown",
      cardsStudied: "−68 — distinct cards studied inside the window",
    })[key] ?? "",
  mochiRead: (gap, fewer, imported, cardDays, mochiReviews, drift, unexplained) =>
    `The ${gap} review difference — Mochi reporting ${fewer} fewer than this page — is not an ` +
    `import error: the import matches the export byte for byte at ${imported} reviews. ` +
    `notes/dashboard-reconciliation.md records eight candidate definitions tried and rejected. ` +
    `The leading one is "count one card once per day", which in this window gives ` +
    `<b>${cardDays}</b> — ${drift} away from Mochi's ${mochiReviews}. ` +
    `${unexplained === null ? "" : `It leaves ${unexplained} unexplained, so `}it is left written ` +
    `down as a hypothesis, and the figure shown stays the grading-event count, whose definition ` +
    `is unambiguous.`,

  glossaryHeading: "What the words on this page mean",
  glossary: [
    ["reviews", "the number of grading events, counting every track — forward, reverse and cloze."],
    ["cards studied", "distinct cards graded at least once inside the window."],
    [
      "active days",
      "the number of days with at least one grading. Dates are cut by each review's own tz_offset, not by UTC.",
    ],
    ["days", "both ends included. The window stops at the last review date."],
    ["retention", "passed / all grading events."],
    ["study time", "the sum of durations. A review carrying no duration contributes nothing."],
    [
      "preceding interval",
      "how long it had been since that card was last seen. Mochi's <code>interval</code> is the <em>next</em> interval, so this is derived from the previous record at import time.",
    ],
  ],
  aboutHeading: "About this page",
  about: (activeDays) =>
    `Generated by src/dashboard/render.ts. No script, no outbound request, no webfont — it opens ` +
    `from a file:// URL on a device with the radio off. Every aggregate chart has a matching ` +
    `table (by year, by month, by bucket, by deck). <b>The activity heatmap's daily values are in ` +
    `the per-year tables too, all ${activeDays} of them — every day that carries a value can be ` +
    `read from a table. Days with no reviews have only the cell's <code>title</code>, and it ` +
    `holds no figure.</b> Colours were chosen separately for light and dark and run through the ` +
    `data-viz validator.`,
};

/** By locale, for a CLI flag or a test to pick from. */
export const LOCALES: Readonly<Record<Locale, Labels>> = { en: EN, ja: JA };
