import type { GlanceDay, GlanceDeck } from "../src/dashboard/index.js";
import { recallOf } from "../src/dashboard/recall.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";
import type { ReplyFor } from "./protocol.js";
import { closeSidebar } from "./sidebar.js";
import { setIcon } from "./icons.js";
import { say } from "./ui.js";
import { ask } from "./worker-client.js";

export const LOW_RECALL = 0.85;
const LOW_RECALL_LEGEND = `under ${Math.round(LOW_RECALL * 100)}% remembered, not counting new cards`;

export async function openDashboard(): Promise<void> {
  closeSidebar();

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
  title.textContent = "dashboard";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the dashboard");
  setIcon(close, "x");
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  body.setAttribute("aria-busy", "true");
  body.appendChild(glanceSkeleton());
  pushLayer(bareLayer(root));
  close.focus();

  let reply: ReplyFor["glance"];
  try {
    reply = await ask<"glance">({ kind: "glance" });
  } catch (cause) {
    closeIfTop(root);
    say((cause as Error).message, true);
    return;
  }
  if (!root.isConnected) return;
  const g = reply.glance;
  title.title = `${reply.elapsedMs.toFixed(0)} ms`;
  body.replaceChildren();
  body.removeAttribute("aria-busy");

  const pct = (r: number | null): string => (r === null ? "—" : `${(100 * r).toFixed(1)}%`);
  const dayDetail = (day: GlanceDay): string => {
    if (day.reviews === 0) return `${day.date} · nothing reviewed`;
    const head = `${day.date} · ${day.reviews.toLocaleString()} reviews`;
    const recall = recallOf(day);
    if (day.firsts === 0) return `${head} · ${pct(recall)} remembered`;
    const fresh = `${day.firsts.toLocaleString()} new`;
    return recall === null
      ? `${head} · all ${fresh}`
      : `${head} · ${pct(recall)} remembered, ${fresh} not counted`;
  };

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
        g.today.reviews === 0 && g.streakDays > 0 ? "through yesterday" : "days",
      ],
      [
        "learned",
        g.collection.learned.toLocaleString(),
        `of ${g.collection.live.toLocaleString()} live · ` +
          `${(g.collection.live - g.collection.learned).toLocaleString()} to go`,
      ],
    ]),
  );

  body.appendChild(glanceHead("tracks learned, last 12 months"));
  body.appendChild(
    glanceBars(
      g.learnedByMonth.map((month) => ({
        label: month.month.slice(5),
        value: month.learned,
        good: null,
        detail:
          `${month.month} · ${month.learned.toLocaleString()} learned · ` +
          `${month.cumulative.toLocaleString()} in all`,
      })),
    ),
  );

  body.appendChild(glanceHead("the last 14 days you studied"));
  body.appendChild(
    glanceBars(
      g.recent.map((day) => ({
        label: day.date.slice(5),
        value: day.reviews,
        good: recallOf(day),
        detail: dayDetail(day),
      })),
    ),
  );

  body.appendChild(glanceLegend(LOW_RECALL_LEGEND));

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

  body.appendChild(glanceHead("learned by deck"));
  body.appendChild(glanceDecks(g.decks));

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

  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    `The full report (retention by interval, deck and track, the heatmap, the ` +
    `long-interval outlook) reads the whole history, and nothing can be graded ` +
    `while it builds. ` +
    (dashboardLastMs === null
      ? `On a desktop it took 81 seconds.`
      : `Last time here: ${(dashboardLastMs / 1000).toFixed(0)} seconds.`);
  const full = document.createElement("button");
  full.type = "button";
  full.className = "gcard-op";
  full.textContent = "build the full report";
  full.addEventListener("click", () => void buildDashboard());
  body.append(glanceHead("the four-year report"), note, full);
}

function glanceSkeleton(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "glance-skeleton";
  wrap.setAttribute("aria-hidden", "true");
  wrap.appendChild(
    glanceTiles([
      ["due now", "000", "0,000 new waiting"],
      ["done today", "000", "000% kept"],
      ["streak", "00", "through yesterday"],
      ["learned", "0,000", "of 00,000 live · 0,000 to go"],
    ]),
  );
  const charts: readonly (readonly [string, readonly number[]])[] = [
    ["tracks learned, last 12 months", [8, 10, 12, 30, 72, 70, 74, 48, 76, 40, 30, 62]],
    ["the last 14 days you studied", [50, 42, 44, 6, 96, 90, 90, 90, 86, 90, 90, 92, 90, 6]],
    ["scheduled, next 14 days", [96, 84, 46, 60, 46, 76, 40, 66, 70, 90, 40, 64, 46, 54]],
  ];
  for (const [heading, heights] of charts) {
    wrap.appendChild(glanceHead(heading));
    const chart = glanceBars(
      heights.map((value) => ({ label: "00", value, good: null, detail: "0000-00-00 · 00 reviews" })),
    );
    for (const column of chart.querySelectorAll("button")) column.disabled = true;
    wrap.appendChild(chart);
    if (heading === "the last 14 days you studied") {
      wrap.appendChild(glanceLegend(LOW_RECALL_LEGEND));
    }
  }
  const status = document.createElement("span");
  status.className = "visually-hidden";
  status.textContent = "loading the dashboard";
  const live = document.createElement("div");
  live.setAttribute("role", "status");
  live.appendChild(status);
  const outer = document.createElement("div");
  outer.append(live, wrap);
  return outer;
}

function glanceHead(text: string): HTMLElement {
  const head = document.createElement("h3");
  head.className = "tpl-head";
  head.textContent = text;
  return head;
}

function glanceLegend(text: string): HTMLElement {
  const legend = document.createElement("p");
  legend.className = "glance-legend";
  const swatch = document.createElement("span");
  swatch.className = "glance-swatch";
  swatch.setAttribute("aria-hidden", "true");
  legend.append(swatch, document.createTextNode(text));
  return legend;
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

function glanceDecks(decks: readonly GlanceDeck[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "glance-decks";
  for (const deck of decks) {
    const row = document.createElement("div");
    row.className = "glance-deck";
    row.style.setProperty("--deck-depth", `${deck.depth}`);

    const name = document.createElement("span");
    name.className = "glance-deck-name";
    name.textContent = deck.path.slice(deck.path.lastIndexOf("/") + 1);
    name.title = deck.path;

    const track = document.createElement("span");
    track.className = "glance-deck-track";
    const fill = document.createElement("i");
    fill.className = "glance-deck-fill";
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

interface GlanceColumn {
  readonly label: string;
  readonly value: number;
  readonly good: number | null;
  readonly detail: string;
}

function glanceBars(days: readonly GlanceColumn[]): HTMLElement {
  const chart = document.createElement("div");
  chart.className = "glance-chart";
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
    column.title = day.detail;
    column.setAttribute("aria-label", day.detail);
    column.setAttribute("aria-pressed", "false");
    const bar = document.createElement("i");
    bar.className = "glance-bar";
    bar.style.height = `${Math.max(2, Math.round((100 * day.value) / peak))}%`;
    if (day.good !== null && day.good < LOW_RECALL) bar.classList.add("is-low");
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
  title.textContent = "dashboard · full report";
  title.title = `${(reply.bytes / 1024).toFixed(0)} KB · ${reply.elapsedMs.toFixed(0)} ms`;

  const ops = document.createElement("div");
  ops.className = "layer-ops";
  const language = document.createElement("button");
  language.type = "button";
  language.className = "layer-op";
  language.textContent = dashboardLocale === "ja" ? "English" : "日本語";
  language.addEventListener("click", () => {
    dashboardLocale = dashboardLocale === "ja" ? "en" : "ja";
    closeIfTop(root);
    void buildDashboard();
  });
  ops.appendChild(language);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close the dashboard");
  setIcon(close, "x");
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, ops, close);
  panel.appendChild(head);

  const frame = document.createElement("iframe");
  frame.className = "dashboard-frame";
  frame.setAttribute("title", "dashboard");
  frame.setAttribute("sandbox", "");
  frame.srcdoc = reply.html;
  panel.appendChild(frame);
  root.appendChild(panel);

  pushLayer(bareLayer(root));
  close.focus();
}

let dashboardLocale = "en";

let dashboardLastMs: number | null = null;
