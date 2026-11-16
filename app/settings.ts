import type { ReplyFor } from "./protocol.js";
import { applyTheme, currentTheme } from "./appearance.js";
import { exportBackup } from "./backup-ui.js";
import { bareLayer, closeIfTop, pushLayer } from "./layers.js";
import { pushUndo } from "./ops.js";
import { THEMES, readTheme, themeLabel } from "./theme.js";
import { openConfirm, say } from "./ui.js";
import { setTextWithCode } from "./dom.js";
import { setIcon } from "./icons.js";
import { versionLabel } from "./version.js";
import { ask } from "./worker-client.js";
import { localDate } from "./new-day.js";
import { LATE_NIGHT_ENDS_HOUR, LATE_NIGHT_KEY, previousDate } from "../src/session/late-night.js";

interface SettingRow {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly when: string;
  readonly control:
    | { readonly kind: "number"; readonly min: number; readonly max: number; readonly step: number }
    | { readonly kind: "choice"; readonly options: readonly (readonly [string, string])[] }
    | { readonly kind: "text"; readonly placeholder: string };
  readonly confirm?: { readonly title: string; readonly body: string };
}

const SETTING_ROWS: readonly SettingRow[] = [
  {
    key: "new.limit",
    label: "new cards per day",
    note:
      "Counts tracks, not cards: forward and reverse are picked separately, at " +
      "random. 0 means due cards only.",
    when: "next session",
    control: { kind: "number", min: 0, max: 500, step: 1 },
  },
  {
    key: "session.interleave",
    label: "where new cards land",
    note:
      "spread puts them evenly through the plan. due-first holds them to the end, " +
      "which means a long day never reaches them.",
    when: "next session",
    control: {
      kind: "choice",
      options: [
        ["spread", "spread through the session"],
        ["new-first", "new cards first"],
        ["due-first", "due cards first"],
      ],
    },
  },
  {
    key: "queue.exam-target",
    label: "漢検 target",
    note:
      "New cards whose word has a kanji at this level or the one below come first, " +
      "after 優先 cards. Still the same number a day, at random within each tier. " +
      "Only 日本語. Move it up when you pass.",
    when: "next session",
    control: {
      kind: "choice",
      options: [
        ["off", "off — 優先 cards only"],
        ["3", "3級 — 4級 + 3級 kanji"],
        ["準2", "準2級 — 3級 + 準2級 kanji"],
        ["2", "2級 — 準2級 + 2級 kanji"],
      ],
    },
  },
  {
    key: "target_retention.default",
    label: "target retention",
    note:
      "0.90 matches your ~69 reviews a day; 0.95 would be 2–3× that. Per-deck " +
      "overrides still win, and the 365-day cap keeps a low value safe.",
    when: "next grade",
    control: { kind: "number", min: 0.7, max: 0.97, step: 0.01 },
    confirm: {
      title: "Change target retention?",
      body:
        "Every future grade uses it, on every deck without its own value. No " +
        "existing due date moves, so cards drift to the new value over weeks as " +
        "they come up.",
    },
  },
  {
    key: "reverse.default",
    label: "reverse reviews, by default",
    note:
      "Only reaches decks that inherit all the way to the top — every top-level " +
      "deck, and the decks under them that inherit. 単語, 漢字, 言葉 and 文法 have " +
      "reverse on of their own, so they and the decks under them don't change.",
    when: "next card built",
    control: {
      kind: "choice",
      options: [
        ["off", "off — reverse is opt-in per deck"],
        ["on", "on — every inheriting deck reverses"],
      ],
    },
    confirm: {
      title: "Turn reverse on by default?",
      body:
        "Every deck that inherits all the way up gains a reverse track per card, and each one is " +
        "a card you have never seen. No history is lost either way: a track turned " +
        "off goes dormant and keeps its reviews.",
    },
  },
  {
    key: "timezone.default",
    label: "timezone",
    note:
      "Decides which local date counts as today, which is the only thing that " +
      "selects the queue. IANA name, e.g. Asia/Tokyo.",
    when: "next session",
    control: { kind: "text", placeholder: "Asia/Tokyo" },
  },
  {
    key: "voice.default",
    label: "default voice",
    note:
      "Leave empty. Every clip is filed under the voice that made it, so a value " +
      "here stops most clips in its language from matching, and they are made " +
      "again at a cost. Set it only when you mean to regenerate the audio.",
    when: "next clip generated",
    control: { kind: "text", placeholder: "(empty — use the template's voice)" },
    confirm: {
      title: "Set a default voice?",
      body:
        "This is the one setting here that costs money. With a value, most clips " +
        "in its language stop matching, so they are made again.",
    },
  },
];

export async function openSettings(): Promise<void> {
  const root = document.createElement("div");
  root.className = "layer layer-edit layer-settings";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "settings");

  const backdrop = document.createElement("div");
  backdrop.className = "layer-backdrop";
  backdrop.addEventListener("click", () => closeIfTop(root));
  root.appendChild(backdrop);

  const panel = document.createElement("div");
  panel.className = "layer-panel";
  const head = document.createElement("div");
  head.className = "layer-head";
  const title = document.createElement("span");
  title.textContent = "settings";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "layer-close";
  close.setAttribute("aria-label", "close settings");
  setIcon(close, "x");
  close.addEventListener("click", () => closeIfTop(root));
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "layer-body";
  panel.appendChild(body);
  root.appendChild(panel);

  const status = document.createElement("div");
  status.className = "edit-status";
  status.setAttribute("aria-live", "polite");

  body.classList.add("is-loading");
  body.setAttribute("aria-busy", "true");
  body.appendChild(themeRow());
  for (const row of SETTING_ROWS) {
    const placeholder = settingRow(row, "", false, status);
    for (const control of placeholder.querySelectorAll("input, select")) {
      (control as HTMLInputElement).disabled = true;
    }
    body.appendChild(placeholder);
  }
  pushLayer(bareLayer(root));
  close.focus();

  let reply: ReplyFor["settings"];
  try {
    reply = await ask<"settings">({ kind: "settings" });
  } catch (cause) {
    closeIfTop(root);
    say((cause as Error).message, true);
    return;
  }
  if (!root.isConnected) return;
  body.replaceChildren();
  body.classList.remove("is-loading");
  body.removeAttribute("aria-busy");

  for (const bad of reply.resolved.rejected) {
    const warn = document.createElement("p");
    warn.className = "settings-bad";
    const name = SETTING_ROWS.find((row) => row.key === bad.key)?.label ?? bad.key;
    warn.textContent =
      `${name} is ${JSON.stringify(bad.value)}, which can't be used, so the ` +
      `default is in use instead. Fix or clear it below.`;
    body.appendChild(warn);
  }

  const effective: Readonly<Record<string, string>> = {
    "new.limit": String(reply.resolved.newLimit),
    "session.interleave": reply.resolved.interleave,
    "queue.exam-target": reply.resolved.examTarget,
  };
  body.appendChild(themeRow());

  {
    const stored = reply.values[LATE_NIGHT_KEY];
    body.appendChild(settingRow(lateNightRow(stored), stored ?? "", stored === undefined, status));
  }

  for (const row of SETTING_ROWS) {
    const stored = reply.values[row.key];
    body.appendChild(
      settingRow(row, stored ?? effective[row.key] ?? "", stored === undefined, status),
    );
  }

  body.appendChild(settingsState(reply));
  body.appendChild(status);
  (body.querySelector(".edit-input") as HTMLElement | null)?.focus();
}

function themeRow(): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "edit-row";

  const label = document.createElement("span");
  label.className = "edit-label";
  label.textContent = "theme";
  const when = document.createElement("i");
  when.className = "edit-type";
  when.textContent = "at once · this device only";
  label.appendChild(when);
  wrap.appendChild(label);

  const select = document.createElement("select");
  select.className = "edit-input";
  for (const value of THEMES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = themeLabel(value);
    select.appendChild(option);
  }
  select.value = currentTheme;
  select.addEventListener("change", () => {
    applyTheme(readTheme(select.value));
  });
  wrap.appendChild(select);

  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent =
    "Both themes are checked for contrast. This one doesn't sync: each device " +
    "keeps its own.";
  wrap.appendChild(note);
  return wrap;
}

function settingRow(
  row: SettingRow,
  current: string,
  unstored: boolean,
  status: HTMLElement,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "edit-row";

  const label = document.createElement("span");
  label.className = "edit-label";
  label.textContent = row.label;
  const when = document.createElement("i");
  when.className = "edit-type";
  when.textContent = unstored ? `${row.when} · default, not stored` : row.when;
  label.appendChild(when);
  wrap.appendChild(label);

  let control: HTMLInputElement | HTMLSelectElement;
  if (row.control.kind === "choice") {
    const select = document.createElement("select");
    select.className = "edit-input";
    for (const [value, text] of row.control.options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    }
    select.value = current;
    control = select;
  } else {
    const input = document.createElement("input");
    input.className = "edit-input";
    if (row.control.kind === "number") {
      input.type = "number";
      input.min = String(row.control.min);
      input.max = String(row.control.max);
      input.step = String(row.control.step);
    } else {
      input.type = "text";
      input.placeholder = row.control.placeholder;
    }
    input.value = current;
    control = input;
  }

  const commit = (): void => {
    const value = control.value.trim();
    if (value === current) return;
    const write = (): void => {
      void saveSetting(row, value, current, status);
    };
    if (row.confirm === undefined) write();
    else openConfirm(row.confirm.title, row.confirm.body, "change it", write, "normal");
  };
  control.addEventListener("change", commit);
  wrap.appendChild(control);

  const note = document.createElement("p");
  note.className = "settings-note";
  setTextWithCode(note, row.note);
  wrap.appendChild(note);
  return wrap;
}

function lateNightRow(stored: string | undefined): SettingRow {
  const now = new Date();
  const today = localDate(now);
  const yesterday = previousDate(today);
  const options: (readonly [string, string])[] = [
    ["", "off"],
    [today, `on — keep ${today} open past midnight`],
  ];
  if (now.getHours() < LATE_NIGHT_ENDS_HOUR) options.push([yesterday, `on — go back to ${yesterday}`]);
  if (stored !== undefined && stored !== "" && !options.some(([value]) => value === stored)) {
    options.push([stored, `on — ${stored} (too old, does nothing)`]);
  }
  return {
    key: LATE_NIGHT_KEY,
    label: "late night",
    note:
      "For a night you won't finish before midnight. After midnight the app keeps " +
      "showing that day's reviews and new cards instead of starting the next day. " +
      "It turns itself off when you finish them, or at 06:00, whichever comes first.",
    when: "now, or after a reload past midnight",
    control: { kind: "choice", options },
  };
}

function shown(row: SettingRow, value: string): string {
  if (row.control.kind === "choice" && row.control.options.some(([option]) => option === value)) {
    const text = row.control.options.find(([option]) => option === value)?.[1] ?? value;
    return text.split(" — ")[0] ?? text;
  }
  if (value === "") return "empty";
  if (row.control.kind !== "choice") return value;
  const text = row.control.options.find(([option]) => option === value)?.[1];
  return text === undefined ? value : (text.split(" — ")[0] ?? text);
}

async function saveSetting(
  row: SettingRow,
  value: string,
  before: string,
  status: HTMLElement,
): Promise<void> {
  const key = row.key;
  try {
    const reply = await ask<"setSetting">({ kind: "setSetting", key, value });
    const describe = `${row.label}: ${shown(row, reply.previous ?? before)} → ${shown(row, value)}`;
    status.textContent = describe;
    say(describe);
    pushUndo({
      describe,
      run: async () => {
        await ask<"setSetting">({ kind: "setSetting", key, value: reply.previous ?? before });
      },
    });
  } catch (cause) {
    status.textContent = (cause as Error).message;
    say((cause as Error).message, true);
  }
}

function settingsState(reply: ReplyFor["settings"]): HTMLElement {
  const box = document.createElement("div");
  box.className = "settings-state";

  const mib = (bytes: number | null): string =>
    bytes === null ? "unknown" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const coverage =
    reply.audio.cardsWithSpeech === 0
      ? "no speech in this database"
      : `${reply.audio.cardsThatCanPlay.toLocaleString()} of ` +
        `${reply.audio.cardsWithSpeech.toLocaleString()} cards with speech can play ` +
        `(${((100 * reply.audio.cardsThatCanPlay) / reply.audio.cardsWithSpeech).toFixed(1)}%)`;

  const lines: readonly (readonly [string, string])[] = [
    [
      "storage",
      `${reply.storage.persisted ? "persistent" : "not persistent — the browser may clear it"} · ` +
        `${mib(reply.storage.usageBytes)} used of ${mib(reply.storage.quotaBytes)}`,
    ],
    ["audio on this device", `${coverage} · ${reply.audio.payloads.toLocaleString()} payloads`],
    ["local reviews", reply.localReviews.toLocaleString()],
    [
      "resolved plan",
      `${reply.resolved.newLimit} new/day, ${reply.resolved.interleave}`,
    ],
    ["versions", `app ${versionLabel()} · schema v${reply.schemaVersion} · sqlite ${reply.sqliteVersion}`],
  ];
  for (const [name, text] of lines) {
    const line = document.createElement("p");
    line.className = "settings-line";
    const key = document.createElement("b");
    key.textContent = name;
    line.append(key, document.createTextNode(text));
    box.appendChild(line);
  }

  const backup = document.createElement("button");
  backup.type = "button";
  backup.className = "gcard-op";
  backup.textContent = "export a backup";
  backup.addEventListener("click", () => void exportBackup());
  box.appendChild(backup);
  return box;
}
