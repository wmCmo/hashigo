/**
 * THE DASHBOARD FROM THE SIDEBAR — his #1, moved out of `main.ts` on 2026-09-25.
 *
 * Self-contained: the only thing it needs besides the worker is closing the drawer
 * on a phone before it opens, which `./sidebar.ts` owns.
 */

import type { GlanceDeck } from "../src/dashboard/index.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";
import type { ReplyFor } from "./protocol.js";
import { closeSidebar } from "./sidebar.js";
import { say } from "./ui.js";
import { ask } from "./worker-client.js";

/**
 * His #1, and the answer to *"what about just simple dashboard in mobile app and
 * full suit dashboard on laptop?"*
 *
 * **The split is right; the axis is not device.** He reviews on the laptop too, and
 * a laptop tab runs the same sqlite-wasm in the same one worker — so the full
 * report is the same 81 seconds there. It splits by what the numbers are FOR: this
 * is "how am I doing", and the four-year analysis is a button inside it.
 *
 * Rendered in the app's own palette rather than in an iframe, which is the other
 * half of his question. The full report is a complete document with its own white
 * stylesheet and has no choice; a dozen figures do, and on a phone a white sheet
 * dropped into a dark app at night is its own answer.
 */
export async function openDashboard(): Promise<void> {
  closeSidebar();
  let reply: ReplyFor["glance"];
  try {
    reply = await ask<"glance">({ kind: "glance" });
  } catch (cause) {
    say((cause as Error).message, true);
    return;
  }
  const g = reply.glance;

  const root = document.createElement("div");
  root.className = "layer layer-edit layer-glance";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "dashboard");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent = `dashboard · ${reply.elapsedMs.toFixed(0)} ms`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the dashboard");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  const pct = (r: number | null): string => (r === null ? "—" : `${(100 * r).toFixed(1)}%`);

  // ── today, and the streak ──
  body.appendChild(
    glanceTiles([
      ["due now", g.today.due.toLocaleString(), `${g.today.fresh} new waiting`],
      [
        "done today",
        g.today.reviews.toLocaleString(),
        g.today.reviews === 0 ? "not started" : `${pct(g.today.remembered / g.today.reviews)} kept`,
      ],
      [
        "streak",
        `${g.streakDays}`,
        // Said out loud because the number is generous on purpose — see
        // `Glance.streakDays`. A streak that reads 0 at breakfast is a number that
        // punishes him for the time of day.
        g.today.reviews === 0 && g.streakDays > 0 ? "through yesterday" : "days",
      ],
      // REPLACES "live tracks", which said 12,917 of 13,393 — the gap being the
      // dormant and archived ones, a number he cannot act on. This is the same
      // denominator carrying a figure that moves: decision 12 introduces 10 new
      // tracks a day, so "to go" is the runway and it shortens every session.
      [
        "learned",
        g.collection.learned.toLocaleString(),
        `of ${g.collection.live.toLocaleString()} live · ` +
          `${(g.collection.live - g.collection.learned).toLocaleString()} to go`,
      ],
    ]),
  );

  // ── how fast that number moves ──
  body.appendChild(glanceHead("tracks learned, last 12 months"));
  body.appendChild(
    glanceBars(
      g.learnedByMonth.map((month) => ({
        label: month.month.slice(5),
        value: month.learned,
        // No tone: `is-low` means "retention under 0.85" on the chart above, and
        // there is no such thing as a bad month for STARTING cards. Reusing the
        // red here would make the same colour mean two things on one screen.
        good: null,
        detail:
          `${month.month} · ${month.learned.toLocaleString()} learned · ` +
          `${month.cumulative.toLocaleString()} in all`,
      })),
    ),
  );

  // ── the last 14 active days ──
  body.appendChild(glanceHead("the last 14 days you studied"));
  body.appendChild(
    glanceBars(
      g.recent.map((day) => ({
        label: day.date.slice(5),
        value: day.reviews,
        // Retention as the bar's TONE, not a second bar. Two bars per day on a
        // 375px screen is four pixels each.
        good: day.reviews === 0 ? null : day.remembered / day.reviews,
        // The readout is where retention becomes a NUMBER. The tone says "this
        // day was below 0.85" and cannot say by how much; a quiet day says so in
        // words rather than showing "0 reviews · —% remembered".
        detail:
          day.reviews === 0
            ? `${day.date} · nothing reviewed`
            : `${day.date} · ${day.reviews.toLocaleString()} reviews · ` +
              `${pct(day.remembered / day.reviews)} remembered`,
      })),
    ),
  );

  // ── what is coming ──
  body.appendChild(glanceHead("scheduled, next 14 days"));
  body.appendChild(
    glanceBars(
      g.forecast.map((day) => ({
        label: day.date.slice(5),
        value: day.due,
        good: null,
        detail: `${day.date} · ${day.due.toLocaleString()} due`,
      })),
    ),
  );

  // ── where it stands, deck by deck ──
  body.appendChild(glanceHead("learned by deck"));
  body.appendChild(glanceDecks(g.decks));

  // ── the two windows ──
  body.appendChild(glanceHead("windows"));
  body.appendChild(
    glanceTiles([
      [
        "last 30 days",
        g.last30.reviews.toLocaleString(),
        `${pct(g.last30.retention)} · ${g.last30.activeDays} active days`,
      ],
      [
        "all time",
        g.allTime.reviews.toLocaleString(),
        `${pct(g.allTime.retention)} · ${g.allTime.firstDate ?? "—"} → ${g.allTime.lastDate ?? "—"}`,
      ],
    ]),
  );

  // ── the full report ──
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    `The full analysis — retention by interval, by deck, by track, the heatmap, the ` +
    `long-interval outlook — is the same document \`npm run dashboard\` writes. It ` +
    `reads the whole history and SQLite runs synchronously in the one worker, so ` +
    `nothing can grade while it builds. ` +
    (dashboardLastMs === null
      ? `On a desktop it measured 81 seconds.`
      : `Last run here: ${(dashboardLastMs / 1000).toFixed(0)} seconds.`);
  const full = document.createElement("button");
  full.type = "button";
  full.className = "sidebar-action";
  full.textContent = "build the full report";
  full.addEventListener("click", () => void buildDashboard());
  body.append(glanceHead("the four-year report"), note, full);

  pushLayer(bareLayer(root));
  close.focus();
}

function glanceHead(text: string): HTMLElement {
  const head = document.createElement("h3");
  head.className = "tpl-head";
  head.textContent = text;
  return head;
}

function glanceTiles(rows: readonly (readonly [string, string, string])[]): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "glance-tiles";
  for (const [label, value, note] of rows) {
    const tile = document.createElement("div");
    tile.className = "glance-tile";
    const l = document.createElement("span");
    l.className = "glance-label";
    l.textContent = label;
    const v = document.createElement("b");
    v.className = "glance-value";
    v.textContent = value;
    const n = document.createElement("i");
    n.className = "glance-note";
    n.textContent = note;
    tile.append(l, v, n);
    grid.appendChild(tile);
  }
  return grid;
}

/**
 * The deck breakdown of the learned figure — a row per deck, tree order.
 *
 * ─── NOT `glanceBars`, AND NOT THE FULL REPORT'S TABLE ──────────────────────
 *
 * `glanceBars` is for a series over TIME: it shares one vertical scale across
 * columns, which is what makes two weeks of reviews comparable at a glance. Decks
 * are not a series and their sizes differ by three orders of magnitude — 単語 has
 * 7,192 live tracks and 原神 has 2 — so one shared scale would render every deck
 * but the largest as a hairline. Each row carries its OWN proportion instead, so
 * a small deck at 90% reads as 90%.
 *
 * ─── THE NUMBER IS TEXT, NOT A TOOLTIP ─────────────────────────────────────
 *
 * The time charts need a readout because a bar has no room for its figure and a
 * `title` is a hover affordance, which decision 19 forbids as a sole carrier. A
 * row is wide, so `learned / live` simply sits in it and there is nothing to
 * reveal, nothing to press, and no state to get wrong.
 *
 * DEPTH IS INDENTATION, and the rows arrive in path order so it reads as a tree.
 * The leaf name is shown rather than the full path: `deck_paths` spells
 * `日本語/単語/ビジネス`, and at depth 2 in a 375px column the ancestors are
 * already above it on screen.
 */
function glanceDecks(decks: readonly GlanceDeck[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "glance-decks";
  for (const deck of decks) {
    const row = document.createElement("div");
    row.className = "glance-deck";
    row.style.setProperty("--deck-depth", `${deck.depth}`);

    const name = document.createElement("span");
    name.className = "glance-deck-name";
    // The leaf, but the full path is the accessible name — a screen reader has no
    // indentation to read the nesting off.
    name.textContent = deck.path.slice(deck.path.lastIndexOf("/") + 1);
    name.title = deck.path;

    const track = document.createElement("span");
    track.className = "glance-deck-track";
    const fill = document.createElement("i");
    fill.className = "glance-deck-fill";
    // `live` is 0 only for a deck holding no cards at all, which decision 3 drops
    // from the tree — but an empty deck is creatable from the app, so guard it
    // rather than paint a NaN-wide bar.
    const share = deck.live === 0 ? 0 : deck.learned / deck.live;
    fill.style.width = `${(100 * share).toFixed(1)}%`;
    if (deck.learned === deck.live && deck.live > 0) fill.classList.add("is-done");
    track.appendChild(fill);

    const count = document.createElement("span");
    count.className = "glance-deck-num";
    count.textContent = `${deck.learned.toLocaleString()}/${deck.live.toLocaleString()}`;

    row.append(name, track, count);
    row.setAttribute(
      "aria-label",
      `${deck.path} — ${deck.learned} of ${deck.live} tracks learned`,
    );
    list.appendChild(row);
  }
  return list;
}

/** One column of a glance chart. `detail` is the sentence the readout says. */
interface GlanceColumn {
  readonly label: string;
  readonly value: number;
  readonly good: number | null;
  /** What this bar MEANS, in words. The only place its number is legible. */
  readonly detail: string;
}

/**
 * A bar row in CSS, with no chart library and no canvas.
 *
 * SPEC problem #1 is battery: this is the same reason the standalone dashboard
 * ships zero JavaScript. A `<div>` with a percentage height computes once at layout
 * and never again.
 *
 * ─── THE NUMBER HAS TO BE REACHABLE BY THUMB — Zach, 2026-09-14 ─────────────
 *
 * *"on mobile dashboard, there are bar charts, i want to see numbers when i press
 * them or hold"*. The figure was on `title` and nowhere else, which is a HOVER
 * affordance — the sole-carrier case decision 19 forbids, on the one screen with
 * no keycaps to excuse it. And it was worse than "hard to reach" on his handset:
 * the tick labels under the bars are `display: none` below 520px (two weeks of
 * dates do not fit 375px), so a bar on a phone carried **no number and no date at
 * all**. Fourteen anonymous rectangles.
 *
 * So every column is a real button and the chart carries a readout line above it.
 * **`pointerdown`, not `click`** — that is what makes "or hold" work with no timer
 * and no long-press gesture to learn: the readout fills the instant the finger
 * lands and stays until the next press, so holding and releasing both show it.
 * `click` is bound as well, for the keyboard, and is idempotent with it.
 *
 * The readout starts on the LAST column rather than empty. An empty line is a
 * band of blank space that has to be discovered before it explains anything, and
 * the most recent day — today's work, or tomorrow's load — is the one worth
 * reading unprompted.
 */
function glanceBars(days: readonly GlanceColumn[]): HTMLElement {
  const chart = document.createElement("div");
  chart.className = "glance-chart";
  // `output` with `aria-live`: a bar is a picture, and this line is the only form
  // of it a screen reader can read at all.
  const readout = document.createElement("output");
  readout.className = "glance-read";
  readout.setAttribute("aria-live", "polite");
  const bars = document.createElement("div");
  bars.className = "glance-bars";
  chart.append(readout, bars);

  const peak = Math.max(1, ...days.map((day) => day.value));
  const columns: HTMLButtonElement[] = [];
  const pick = (at: number): void => {
    columns.forEach((column, index) => {
      column.classList.toggle("is-picked", index === at);
      column.setAttribute("aria-pressed", index === at ? "true" : "false");
    });
    readout.textContent = days[at]?.detail ?? "";
  };

  days.forEach((day, index) => {
    const column = document.createElement("button");
    column.type = "button";
    column.className = "glance-col";
    // Kept for a pointer that has one, and repeated as the accessible name so the
    // button is not announced as an empty control.
    column.title = day.detail;
    column.setAttribute("aria-label", day.detail);
    column.setAttribute("aria-pressed", "false");
    const bar = document.createElement("i");
    bar.className = "glance-bar";
    // A zero-review day still gets a hairline, so a GAP reads as a gap rather
    // than as a day the chart forgot.
    bar.style.height = `${Math.max(2, Math.round((100 * day.value) / peak))}%`;
    if (day.good !== null && day.good < 0.85) bar.classList.add("is-low");
    const label = document.createElement("span");
    label.className = "glance-tick";
    label.textContent = day.label;
    column.append(bar, label);
    column.addEventListener("pointerdown", () => pick(index));
    column.addEventListener("click", () => pick(index));
    columns.push(column);
    bars.appendChild(column);
  });

  if (days.length > 0) pick(days.length - 1);
  return chart;
}

async function buildDashboard(): Promise<void> {
  say("building the dashboard — the database is busy until it finishes…");
  let reply: ReplyFor["dashboard"];
  try {
    reply = await ask<"dashboard">({ kind: "dashboard", locale: dashboardLocale });
  } catch (cause) {
    say((cause as Error).message, true);
    return;
  }
  dashboardLastMs = reply.elapsedMs;

  const root = document.createElement("div");
  root.className = "layer layer-dashboard";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "dashboard");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent =
    `dashboard · ${(reply.bytes / 1024).toFixed(0)} KB · ` +
    `${reply.elapsedMs.toFixed(0)} ms`;

  const ops = document.createElement("div");
  ops.className = "layer-ops";
  // Decision: English by default, `ja` byte-identical to a committed golden file.
  // Both are one render, so the toggle re-asks rather than translating on screen.
  const language = document.createElement("button");
  language.type = "button";
  language.className = "layer-op";
  language.textContent = dashboardLocale === "ja" ? "English" : "日本語";
  language.addEventListener("click", () => {
    dashboardLocale = dashboardLocale === "ja" ? "en" : "ja";
    closeIfTop(root);
    // Straight to the build: he has already agreed to the cost once, and asking
    // again for the same data in the other language is a question with one answer.
    void buildDashboard();
  });
  ops.appendChild(language);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the dashboard");
  close.textContent = "✕";
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, ops, close);
  panel.appendChild(head);

  const frame = document.createElement("iframe");
  frame.className = "dashboard-frame";
  frame.setAttribute("title", "dashboard");
  // No `allow-scripts`: the document contains none, and saying so here is what
  // makes that a guarantee rather than an observation.
  frame.setAttribute("sandbox", "");
  frame.srcdoc = reply.html;
  panel.appendChild(frame);
  root.appendChild(panel);

  pushLayer(bareLayer(root));
  close.focus();
  say(`dashboard: ${reply.elapsedMs.toFixed(0)} ms over the whole history`);
}

/** Remembered for the session only; the render is per open either way. */
let dashboardLocale = "en";

/**
 * What the last build actually cost HERE.
 *
 * Null until one has run, and the fallback is the desktop figure said as a desktop
 * figure. His phone wrote the corpus 1.44x faster than this machine, so quoting 81
 * seconds at him there would be wrong in the direction that reads as a warning —
 * which is the direction that stops him using something that works.
 */
let dashboardLastMs: number | null = null;
