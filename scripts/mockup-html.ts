/**
 * Stage-7 mockups, step 2 of 2: four chromes over the cards step 1 extracted.
 *
 *   npx vite-node scripts/mockup-cards.ts     # first — writes cards.json
 *   npx vite-node scripts/mockup-html.ts      # then  — writes the pages
 *
 * A2 is the CHOSEN one (decision 23). A, B and C are kept because the decision was
 * made by comparing them, and a rejected option is part of the record.
 *
 * Everything on screen is real: sides from `src/render`, audio bytes out of the
 * 617.9 MiB store, accents from the `accents` table. Where a generator is still
 * pending in the corpus (furigana, ai) it is shown as a labelled chip rather than
 * faked, so nothing here reads as working when it is not.
 *
 * THE HARD RULE IS HONOURED: an audio element gets its `src` and its `play()`
 * only from `reveal()`. Nothing plays on card entry.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Card {
  id: string;
  head: string;
  deck: string;
  sides: { index: number; empty: boolean; html: string }[];
  audio: string | null;
  audioKiB: number;
  accentType: string | null;
  accentPos: number | null;
  reading: string | null;
  pending: string[];
  newCard: boolean;
}
const cards: Card[] = JSON.parse(readFileSync("build/mock/out/cards.json", "utf-8"));

const JP = '"Hiragino Kaku Gothic ProN","Yu Gothic","Yu Gothic UI",Meiryo,"Noto Sans JP"';

/** The derived contour as high/low mora blocks. 平板 (0) = low then high. */
function contour(reading: string | null, pos: number | null): string {
  if (reading === null || pos === null) return "";
  const mora: string[] = [];
  for (const ch of reading) {
    if ("ャュョァィゥェォ".includes(ch) && mora.length > 0) mora[mora.length - 1] += ch;
    else mora.push(ch);
  }
  const high = (i: number): boolean => (pos === 0 ? i > 0 : i < pos);
  const cells = mora
    .map((m, i) => '<span class="mora ' + (high(i) ? "hi" : "lo") + '">' + m + "</span>")
    .join("");
  return '<div class="contour">' + cells + "</div>";
}

const SHARED_JS = [
  "var screens = Array.prototype.slice.call(document.querySelectorAll('.card'));",
  "var at = 0;",
  "function show(i) {",
  "  screens.forEach(function (s, n) { s.hidden = n !== i; });",
  "  var s = screens[i];",
  "  if (!s) return;",
  "  s.dataset.state = 'prompt';",
  // Entering a card must leave it silent AND unloaded: dropping the src is what
  // makes re-entry incapable of playing without another reveal.
  "  s.querySelectorAll('audio').forEach(function (a) { a.pause(); a.removeAttribute('src'); });",
  "  document.querySelectorAll('.progress-now').forEach(function (e) { e.textContent = String(i + 1); });",
  "}",
  "function reveal(s) {",
  "  if (!s || s.dataset.state === 'revealed') return;",
  "  s.dataset.state = 'revealed';",
  "  var a = s.querySelector('audio[data-clip]');",
  "  if (a) { a.src = a.dataset.clip; a.play().catch(function () {}); }",
  "}",
  "function grade() {",
  "  var s = screens[at];",
  "  if (s && s.dataset.state !== 'revealed') return;",
  "  at = (at + 1) % screens.length;",
  "  show(at);",
  "  window.scrollTo(0, 0);",
  "}",
  "document.addEventListener('click', function (e) {",
  "  if (e.target.closest('[data-act=\"reveal\"]')) { reveal(screens[at]); return; }",
  "  if (e.target.closest('[data-act=\"grade\"]')) { grade(); return; }",
  "  if (e.target.closest('[data-act=\"play\"]')) {",
  "    var a = screens[at].querySelector('audio[data-clip]');",
  "    if (a && a.getAttribute('src')) a.play().catch(function () {});",
  "  }",
  "});",
  "document.addEventListener('keydown', function (e) {",
  "  if (e.key === ' ' || e.key === 'Enter') {",
  "    e.preventDefault();",
  "    if (screens[at].dataset.state === 'prompt') reveal(screens[at]); else grade();",
  "  }",
  "  if (e.key === 'j' || e.key === 'f') grade();",
  "});",
  "show(0);",
].join("\n");

function audioEl(c: Card, controls: boolean): string {
  if (c.audio === null) return '<span class="chip">no clip in the store for this card</span>';
  // No `src` here on purpose — reveal() assigns it. `controls` only where the
  // native player IS the control; direction C ships its own button instead.
  return '<audio data-clip="' + c.audio + '" preload="none" class="clip"' + (controls ? " controls" : "") + "></audio>";
}

function pendingChips(c: Card): string {
  if (c.pending.length === 0) return "";
  const chips = c.pending
    .map((p) => '<span class="chip">' + p + " — still pending in the corpus, not faked here</span>")
    .join("");
  return '<div class="pendings">' + chips + "</div>";
}

function realSides(c: Card): string {
  return c.sides
    .filter((s) => !s.empty)
    .map(
      (s) =>
        '<div class="realside"><div class="sidelabel">side ' +
        String(s.index + 1) +
        "</div>" +
        s.html +
        "</div>",
    )
    .join("");
}

/** 型. Decision 20 puts it on side 2, immediately above `<<Speech>>`. */
function typeBadge(c: Card): string {
  if (c.accentType === null) return "";
  const pos = c.accentPos === null ? "" : ' <span class="pos">' + String(c.accentPos) + "</span>";
  return '<span class="kata" title="型 — side 2, above Speech (decision 20)">' + c.accentType + pos + "</span>";
}

const COMMON_CLOZE_CSS = [
  // The mockup shows the revealed form, so the mask is out and the answer is in.
  ".hashigo-cloze-mask{display:none}",
  ".hashigo-cloze-answer{display:inline!important}",
  "ruby rt:empty::after{content:'—';opacity:.45}",
  // The pending <<Speech>> element the renderer emits has no src in a mockup —
  // the resolved clip is shown in the chrome above instead. A dead native player
  // is worse than none, so it is hidden rather than left tappable.
  ".realside audio{display:none}",
].join("");

// ─── A. TERMINAL ─────────────────────────────────────────────────────────────
const A =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Hashigo · A — terminal</title><style>" +
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "body{background:#111214;color:#e6e6e6;font:15px/1.6 ui-monospace,'Cascadia Mono',Consolas," +
  JP +
  ",monospace;min-height:100vh;display:flex;flex-direction:column;-webkit-text-size-adjust:100%}" +
  "header,footer{padding:12px 16px;color:#6a6d73;font-size:12px;letter-spacing:.08em;text-transform:uppercase;display:flex;justify-content:space-between;border-bottom:1px solid #212327}" +
  "footer{border:0;border-top:1px solid #212327}" +
  "main{flex:1;display:flex;flex-direction:column;justify-content:center;padding:24px 16px;max-width:720px;margin:0 auto;width:100%}" +
  ".deck{color:#6a6d73;font-size:12px;margin-bottom:24px}" +
  ".head{font-size:clamp(48px,16vw,86px);line-height:1.1;font-family:" +
  JP +
  ",serif;color:#f4f4f4;letter-spacing:.04em}" +
  ".hint{margin-top:28px;color:#5c5f65;font-size:13px}.hint b{color:#e2b714;font-weight:400}" +
  ".reveal-zone{margin-top:28px;border:1px dashed #2c2f34;background:none;color:#e2b714;font:inherit;padding:14px;width:100%;cursor:pointer;letter-spacing:.06em}" +
  ".reveal-zone:active{background:#17181b}" +
  '[data-state="revealed"] .reveal-zone,[data-state="revealed"] .hint{display:none}' +
  ".answer{display:none}" +
  '[data-state="revealed"] .answer{display:block;animation:in .18s ease-out}' +
  "@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1}}" +
  ".reading{font-family:" +
  JP +
  ",sans-serif;font-size:30px;color:#e2b714;margin:20px 0 6px;letter-spacing:.06em}" +
  ".kata{display:inline-block;border:1px solid #3a3d43;color:#9fe6a0;padding:2px 8px;font-size:13px;margin-left:10px;vertical-align:middle}" +
  ".kata .pos{color:#6a6d73}" +
  ".contour{display:flex;gap:3px;margin:14px 0 22px;flex-wrap:wrap}" +
  ".mora{font-family:" +
  JP +
  ",sans-serif;font-size:17px;padding:5px 8px;border:1px solid #2c2f34}" +
  ".mora.hi{border-top:2px solid #e2b714;color:#f4f4f4}" +
  ".mora.lo{border-bottom:2px solid #4a4d53;color:#9a9da3;align-self:flex-end}" +
  ".clip{width:100%;margin:6px 0 18px;filter:invert(.92) hue-rotate(180deg)}" +
  ".realside{border-top:1px solid #212327;padding:14px 0;font-family:" +
  JP +
  ",sans-serif}" +
  ".sidelabel{color:#4a4d53;font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px;font-family:inherit}" +
  ".chip{display:inline-block;border:1px solid #2c2f34;color:#6a6d73;padding:2px 7px;font-size:11px;margin:2px 4px 2px 0}" +
  ".pendings{margin:10px 0}" +
  ".grades{display:flex;gap:10px;margin-top:22px}" +
  ".grades button{flex:1;background:none;border:1px solid #3a3d43;color:#e6e6e6;font:inherit;padding:16px;cursor:pointer;letter-spacing:.05em}" +
  ".grades .no{border-color:#5c3a3a;color:#e08d8d}.grades .ok{border-color:#3a5c42;color:#9fe6a0}" +
  ".grades button:active{background:#17181b}" +
  ".grades kbd{color:#5c5f65;font-size:11px;display:block;margin-top:4px}" +
  "a{color:#7cb7e0}" +
  COMMON_CLOZE_CSS +
  "</style>" +
  '<header><span>梯子 · review</span><span><span class="progress-now">1</span>/' +
  String(cards.length) +
  " · 443 due</span></header><main>" +
  cards
    .map(
      (c) =>
        '<section class="card" data-state="prompt">' +
        '<div class="deck">' +
        c.deck +
        "</div>" +
        '<div class="head">' +
        c.head +
        "</div>" +
        '<div class="hint">say the contour aloud, then <b>reveal</b></div>' +
        '<button class="reveal-zone" data-act="reveal">[ space ] reveal</button>' +
        '<div class="answer">' +
        '<div class="reading">' +
        (c.reading ?? "") +
        typeBadge(c) +
        "</div>" +
        contour(c.reading, c.accentPos) +
        audioEl(c, true) +
        pendingChips(c) +
        realSides(c) +
        '<div class="grades">' +
        '<button class="no" data-act="grade">forgot<kbd>f</kbd></button>' +
        '<button class="ok" data-act="grade">remembered<kbd>j</kbd></button>' +
        "</div></div></section>",
    )
    .join("") +
  "</main><footer><span>direction A — terminal</span><span>mockup · nothing is graded</span></footer>" +
  "<script>" +
  SHARED_JS +
  "</script>";

// ─── B. DOCUMENT ─────────────────────────────────────────────────────────────
const B =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Hashigo · B — document</title><style>" +
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "body{background:#fff;color:#32302c;font:16px/1.7 -apple-system,'Segoe UI',Inter," +
  JP +
  ",sans-serif;min-height:100vh;display:flex;flex-direction:column;-webkit-text-size-adjust:100%}" +
  "header{padding:14px 20px;border-bottom:1px solid #ebeae8;display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#8a857e}" +
  "main{flex:1;width:100%;max-width:680px;margin:0 auto;padding:36px 20px 48px}" +
  ".deck{font-size:13px;color:#a39d95;margin-bottom:6px}" +
  ".head{font-size:clamp(40px,12vw,62px);font-weight:600;line-height:1.15;letter-spacing:-.01em;color:#1f1e1c}" +
  ".hint{margin-top:14px;color:#8a857e;font-size:14px}" +
  ".reveal-zone{margin-top:26px;width:100%;padding:15px;border:1px solid #e3e1de;border-radius:8px;background:#fbfbfa;color:#4a453e;font:inherit;font-weight:500;cursor:pointer}" +
  ".reveal-zone:active{background:#f1f0ee}" +
  '[data-state="revealed"] .reveal-zone,[data-state="revealed"] .hint{display:none}' +
  '.answer{display:none}[data-state="revealed"] .answer{display:block}' +
  ".rule{height:1px;background:#ebeae8;margin:28px 0}" +
  ".reading{font-size:30px;font-weight:500;color:#1f1e1c;letter-spacing:.04em;margin-bottom:4px}" +
  ".kata{display:inline-block;background:#eef6ee;color:#2f6b39;border-radius:4px;padding:3px 9px;font-size:13px;font-weight:600;margin-left:10px;vertical-align:middle}" +
  ".kata .pos{color:#7aa382;font-weight:400}" +
  ".contour{display:flex;gap:4px;margin:16px 0 24px;flex-wrap:wrap}" +
  ".mora{font-size:17px;padding:6px 9px;border-radius:5px;background:#f5f4f2}" +
  ".mora.hi{background:#1f1e1c;color:#fff}" +
  ".mora.lo{color:#8a857e;align-self:flex-end}" +
  ".clip{width:100%;margin:4px 0 20px}" +
  ".realside{border-top:1px solid #ebeae8;padding:18px 0}" +
  ".sidelabel{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#b5afa6;margin-bottom:10px}" +
  ".chip{display:inline-block;background:#f5f4f2;color:#8a857e;border-radius:4px;padding:3px 8px;font-size:12px;margin:2px 5px 2px 0}" +
  ".pendings{margin:8px 0 4px}" +
  ".grades{display:flex;gap:12px;margin-top:30px}" +
  ".grades button{flex:1;padding:17px;border-radius:8px;border:1px solid #e3e1de;background:#fff;font:inherit;font-weight:600;cursor:pointer}" +
  ".grades .no{color:#a8443d;border-color:#f0d9d7}.grades .ok{color:#2f6b39;border-color:#d7ead9}" +
  "a{color:#3a6ea8}" +
  "blockquote{border-left:3px solid #ebeae8;padding-left:14px;color:#6b665f;margin:10px 0}" +
  "ol,ul{padding-left:22px}h4{font-size:17px;margin:12px 0 6px}" +
  ".hashigo-missing-field{background:#fdf3e3;color:#8a6d3b;border-radius:3px;padding:1px 4px;font-size:13px}" +
  COMMON_CLOZE_CSS +
  "</style>" +
  '<header><span>梯子 &nbsp;·&nbsp; 復習</span><span><span class="progress-now">1</span> of ' +
  String(cards.length) +
  "</span></header><main>" +
  cards
    .map(
      (c) =>
        '<section class="card" data-state="prompt">' +
        '<div class="deck">' +
        c.deck +
        "</div>" +
        '<div class="head">' +
        c.head +
        "</div>" +
        '<div class="hint">Recall the pitch pattern and say it aloud before revealing.</div>' +
        '<button class="reveal-zone" data-act="reveal">Reveal reading &amp; audio</button>' +
        '<div class="answer"><div class="rule"></div>' +
        '<div class="reading">' +
        (c.reading ?? "") +
        typeBadge(c) +
        "</div>" +
        contour(c.reading, c.accentPos) +
        audioEl(c, true) +
        pendingChips(c) +
        realSides(c) +
        '<div class="grades">' +
        '<button class="no" data-act="grade">Forgot</button>' +
        '<button class="ok" data-act="grade">Remembered</button>' +
        "</div></div></section>",
    )
    .join("") +
  "</main><script>" +
  SHARED_JS +
  "</script>";

// ─── C. THUMB-FIRST ──────────────────────────────────────────────────────────
const C =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Hashigo · C — thumb</title><style>" +
  "*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}" +
  "body{background:#0c0d10;color:#f0f0f2;font:16px/1.6 -apple-system,'Segoe UI'," +
  JP +
  ",sans-serif;-webkit-text-size-adjust:100%;overscroll-behavior:none}" +
  ".card{min-height:100dvh;display:flex;flex-direction:column}"
  + ".card[hidden]{display:none!important}" +
  ".top{padding:14px 18px;display:flex;justify-content:space-between;font-size:12px;color:#61646d;letter-spacing:.06em}" +
  ".stage{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center;min-height:0;overflow-y:auto}" +
  ".deck{font-size:12px;color:#61646d;margin-bottom:18px;letter-spacing:.04em}" +
  ".head{font-size:clamp(60px,22vw,120px);line-height:1.05;font-weight:500;letter-spacing:.03em}" +
  ".hint{margin-top:22px;color:#61646d;font-size:14px;max-width:22ch}" +
  ".answer{display:none;width:100%}" +
  '[data-state="revealed"] .answer{display:block}' +
  '[data-state="revealed"] .hint{display:none}' +
  '[data-state="revealed"] .head{font-size:clamp(34px,11vw,54px);opacity:.55}' +
  ".reading{font-size:clamp(26px,8vw,40px);color:#8ee6a0;letter-spacing:.06em;margin:18px 0 2px;font-weight:500}" +
  ".kata{display:inline-block;border:1px solid #2a2d35;border-radius:99px;color:#8ee6a0;padding:3px 11px;font-size:13px;margin-left:8px;vertical-align:middle}" +
  ".kata .pos{color:#61646d}" +
  ".contour{display:flex;gap:4px;margin:18px 0;flex-wrap:wrap;justify-content:center}" +
  ".mora{font-size:18px;padding:7px 10px;border-radius:6px;background:#16181d}" +
  ".mora.hi{background:#8ee6a0;color:#0c0d10;font-weight:600}" +
  ".mora.lo{color:#8b8f99;align-self:flex-end}" +
  ".playbtn{width:76px;height:76px;border-radius:50%;border:1px solid #2a2d35;background:#16181d;color:#8ee6a0;font-size:26px;margin:12px auto 0;display:block;cursor:pointer}" +
  ".playbtn:active{background:#1f222a}" +
  ".detail{margin-top:20px;text-align:left;font-size:14px;color:#b7bac2;border-top:1px solid #1c1f26;padding-top:14px}" +
  ".sidelabel{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#4a4d55;margin:10px 0 6px}" +
  ".chip{display:inline-block;border:1px solid #2a2d35;border-radius:4px;color:#61646d;padding:2px 7px;font-size:11px;margin:2px 4px 2px 0}" +
  ".reveal-zone{width:100%;padding:26px;border:0;border-top:1px solid #1c1f26;background:#12141a;color:#8ee6a0;font:inherit;font-size:17px;font-weight:600;cursor:pointer;letter-spacing:.04em}" +
  ".reveal-zone:active{background:#181b22}" +
  '[data-state="revealed"] .reveal-zone{display:none}' +
  ".grades{display:none}" +
  '[data-state="revealed"] .grades{display:flex}' +
  ".grades button{flex:1;padding:30px 10px;border:0;border-top:1px solid #1c1f26;background:#12141a;font:inherit;font-size:16px;font-weight:600;cursor:pointer}" +
  ".grades .no{color:#f09a94;border-right:1px solid #1c1f26}.grades .ok{color:#8ee6a0}" +
  ".grades button:active{background:#181b22}" +
  "audio.clip{display:none}a{color:#7cb7e0}" +
  COMMON_CLOZE_CSS +
  "</style>" +
  cards
    .map(
      (c) =>
        '<section class="card" data-state="prompt">' +
        '<div class="top"><span>梯子</span><span><span class="progress-now">1</span>/' +
        String(cards.length) +
        "</span></div>" +
        '<div class="stage">' +
        '<div class="deck">' +
        c.deck +
        "</div>" +
        '<div class="head">' +
        c.head +
        "</div>" +
        '<div class="hint">Say the pitch contour aloud, then reveal.</div>' +
        '<div class="answer">' +
        '<div class="reading">' +
        (c.reading ?? "") +
        typeBadge(c) +
        "</div>" +
        contour(c.reading, c.accentPos) +
        audioEl(c, false) +
        (c.audio === null ? "" : '<button class="playbtn" data-act="play" aria-label="replay">&#9654;</button>') +
        '<div class="detail">' +
        pendingChips(c) +
        realSides(c) +
        "</div></div></div>" +
        '<div class="bottom">' +
        '<button class="reveal-zone" data-act="reveal">reveal &amp; listen</button>' +
        '<div class="grades">' +
        '<button class="no" data-act="grade">forgot</button>' +
        '<button class="ok" data-act="grade">remembered</button>' +
        "</div></div></section>",
    )
    .join("") +
  "<script>" +
  SHARED_JS +
  "</script>";

// ─── A2. TERMINAL, RIGHT-HANDED ──────────────────────────────────────────────
// A's look with C's hand. Four changes, each from a stated reason:
//   1. The controls are pinned to the bottom edge. In A they sat wherever the
//      content ended -- measured at y=894 on an 812px viewport, i.e. below the
//      fold -- so grading meant scrolling first, ~100x a day.
//   2. Replay is C's round button, bottom RIGHT, because the phone is held in a
//      RIGHT hand. A native <audio controls> puts the play affordance at the far
//      LEFT of a full-width strip, which is the worst corner for that thumb.
//   3. The keycap hints render ONLY where a real pointer exists
//      (`@media (hover: hover) and (pointer: fine)`). NOT behind a tooltip: a
//      phone has no hover, which is decision 19's own argument.
//   4. Contrast. A's side labels were 2.21:1 and its deck/meta 3.61:1; both now
//      clear AA on #111214 (5.77:1 and 6.44:1, measured).
// `remembered` stays on the RIGHT: over 102,020 corpus reviews retention is
// 96.24%, so ~96 of every 100 taps are that button, and it belongs under the
// thumb that is already there.
const A2 =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Hashigo &middot; A2 &mdash; terminal, right-handed</title><style>" +
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "body{background:#111214;color:#e6e6e6;font:15px/1.6 ui-monospace,'Cascadia Mono',Consolas," +
  JP +
  ",monospace;min-height:100vh;-webkit-text-size-adjust:100%}" +
  "header{padding:12px 16px;color:#9298a0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;" +
  "display:flex;justify-content:space-between;border-bottom:1px solid #212327;" +
  "position:sticky;top:0;background:#111214;z-index:4}" +
  "main{padding:24px 16px 132px;max-width:720px;margin:0 auto;width:100%}" +
  ".deck{color:#9298a0;font-size:12px;margin-bottom:22px}" +
  // Decision 25. Ink + border, NOT the accent green: green means `remembered`
  // and nothing else. A second near-green reads as a bug.
  ".newtag{display:inline-block;border:1px solid #4d5158;color:#e6e6e6;" +
  "font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:2px 7px;" +
  "margin-left:10px;vertical-align:1px}" +
  ".head{font-size:clamp(48px,16vw,86px);line-height:1.1;font-family:" +
  JP +
  ",serif;color:#f4f4f4;letter-spacing:.04em}" +
  ".hint{margin-top:26px;color:#9298a0;font-size:13px}.hint b{color:#e2b714;font-weight:400}" +
  ".answer{display:none}" +
  '[data-state="revealed"] .answer{display:block;animation:in .18s ease-out}' +
  '[data-state="revealed"] .hint{display:none}' +
  "@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1}}" +
  ".reading{font-family:" +
  JP +
  ",sans-serif;font-size:30px;color:#e2b714;margin:22px 0 6px;letter-spacing:.06em}" +
  // Green belongs to `remembered` and nothing else: a second near-green reads as
  // a bug. Zach's own one-accent rule, which this badge was breaking.
  ".kata{display:inline-block;border:1px solid #4d5158;color:#e6e6e6;padding:2px 8px;font-size:13px;" +
  "margin-left:10px;vertical-align:middle}" +
  ".kata .pos{color:#9298a0}" +
  ".contour{display:flex;gap:3px;margin:14px 0 20px;flex-wrap:wrap}" +
  ".mora{font-family:" +
  JP +
  ",sans-serif;font-size:17px;padding:5px 8px;border:1px solid #2c2f34}" +
  ".mora.hi{border-top:2px solid #e2b714;color:#f4f4f4}" +
  ".mora.lo{border-bottom:2px solid #6a6d73;color:#9a9da3;align-self:flex-end}" +
  "audio.clip{display:none}" +
  ".realside{border-top:1px solid #212327;padding:14px 0;font-family:" +
  JP +
  ",sans-serif}" +
  ".sidelabel{color:#8b8f96;font-size:11px;letter-spacing:.1em;text-transform:uppercase;" +
  "margin-bottom:8px;font-family:inherit}" +
  ".chip{display:inline-block;border:1px solid #2c2f34;color:#9298a0;padding:2px 7px;font-size:11px;" +
  "margin:2px 4px 2px 0}" +
  ".pendings{margin:10px 0}" +
  "a{color:#8cc3e8}" +
  ".bar{position:fixed;left:0;right:0;bottom:0;z-index:5;background:#111214;" +
  "border-top:1px solid #212327;display:flex;gap:10px;" +
  "padding:10px 12px calc(10px + env(safe-area-inset-bottom))}" +
  ".bar button{flex:1;background:none;border:1px solid #4d5158;color:#e6e6e6;font:inherit;" +
  "padding:17px 10px;cursor:pointer;letter-spacing:.05em}" +
  ".bar button:active{background:#1b1d21}" +
  ".reveal-zone{color:#e2b714!important;border-style:dashed!important}" +
  ".no{border-color:#6d4444!important;color:#e9a3a3!important}" +
  ".ok{border-color:#436b4d!important;color:#9fe6a0!important}" +
  '[data-state="prompt"] .grades{display:none}' +
  '[data-state="revealed"] .reveal-zone{display:none}' +
  ".grades{display:flex;gap:10px;flex:1}" +
  ".replay{position:fixed;right:16px;bottom:calc(86px + env(safe-area-inset-bottom));z-index:6;" +
  "width:66px;height:66px;border-radius:50%;border:1px solid #4d5158;background:#1b1d21;" +
  "color:#e2b714;font-size:22px;cursor:pointer;display:none;" +
  "box-shadow:0 6px 20px rgba(0,0,0,.45)}" +
  ".replay:active{background:#24272c}" +
  '[data-state="revealed"] .replay{display:block}' +
  ".kbd{display:none}" +
  "@media (hover:hover) and (pointer:fine){" +
  ".kbd{display:block;color:#9298a0;font-size:11px;margin-top:5px}" +
  ".kbd-inline{display:inline;color:#9298a0}" +
  "}" +
  ".kbd-inline{display:none}" +
  COMMON_CLOZE_CSS +
  "</style>" +
  '<header><span>梯子 &middot; review</span><span><span class="progress-now">1</span>/' +
  String(cards.length) +
  " &middot; 443 due</span></header>" +
  cards
    .map(
      (c) =>
        '<section class="card" data-state="prompt"><main>' +
        '<div class="deck">' +
        c.deck +
        (c.newCard ? '<span class="newtag">new card</span>' : "") +
        "</div>" +
        '<div class="head">' +
        c.head +
        "</div>" +
        '<div class="hint">say the contour aloud, then reveal' +
        '<span class="kbd-inline"> &mdash; <b>space</b></span></div>' +
        '<div class="answer">' +
        '<div class="reading">' +
        (c.reading ?? "") +
        typeBadge(c) +
        "</div>" +
        contour(c.reading, c.accentPos) +
        audioEl(c, false) +
        pendingChips(c) +
        realSides(c) +
        "</div></main>" +
        (c.audio === null
          ? ""
          : '<button class="replay" data-act="play" aria-label="replay the clip">&#9654;</button>') +
        '<div class="bar">' +
        '<button class="reveal-zone" data-act="reveal">reveal<span class="kbd">space</span></button>' +
        '<div class="grades">' +
        '<button class="no" data-act="grade">forgot<span class="kbd">f</span></button>' +
        '<button class="ok" data-act="grade">remembered<span class="kbd">j</span></button>' +
        "</div></div></section>",
    )
    .join("") +
  "<script>" +
  SHARED_JS +
  "</script>";

// A phone-sized chooser, so one tunnel URL reaches all three.
const INDEX =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Hashigo · stage-7 directions</title><style>" +
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "body{background:#0c0d10;color:#f0f0f2;font:16px/1.55 -apple-system,'Segoe UI'," +
  JP +
  ",sans-serif;padding:28px 20px 40px;-webkit-text-size-adjust:100%}" +
  "h1{font-size:22px;font-weight:600;letter-spacing:.02em}" +
  "p.sub{color:#8b8f99;font-size:14px;margin:8px 0 24px}" +
  "a.card{display:block;text-decoration:none;color:inherit;border:1px solid #22252c;" +
  "border-radius:12px;padding:18px;margin-bottom:14px;background:#12141a}" +
  "a.card:active{background:#181b22}" +
  ".k{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8ee6a0}" +
  ".n{font-size:19px;font-weight:600;margin:6px 0 6px}" +
  ".d{font-size:14px;color:#8b8f99}" +
  "footer{color:#61646d;font-size:12px;margin-top:22px;border-top:1px solid #1c1f26;padding-top:16px}" +
  "code{background:#16181d;border-radius:4px;padding:1px 5px;font-size:12px}" +
  "</style>" +
  "<h1>梯子 — stage 7, three directions</h1>" +
  '<p class="sub">Same four real cards, same real audio. Tap one. Audio fires on reveal only.</p>' +
  '<a class="card" href="/mock/a2-terminal.html"><div class="k">direction a2 &mdash; recommended</div>' +
  '<div class="n">Terminal, right-handed</div><div class="d">Direction A, with C&rsquo;s hand: controls pinned to the bottom edge, ' +
  "round replay button bottom-RIGHT, keycap hints only where a real pointer exists, " +
  "contrast fixed.</div></a>" +
  '<a class="card" href="/mock/a-terminal.html"><div class="k">direction a &mdash; original</div>' +
  '<div class="n">Terminal</div><div class="d">Dense, monospace, high contrast. Keyboard-first ' +
  "(space to reveal, f / j to grade). Everything on one scroll.</div></a>" +
  '<a class="card" href="/mock/b-document.html"><div class="k">direction b</div>' +
  '<div class="n">Document</div><div class="d">Light, generous, reads like a page. Hairline ' +
  "dividers, wide buttons at the end of the content.</div></a>" +
  '<a class="card" href="/mock/c-thumb.html"><div class="k">direction c</div>' +
  '<div class="n">Thumb-first</div><div class="d">Huge head word, vertically centred. Reveal and ' +
  "grading pinned to the bottom edge, one-handed. Own play button.</div></a>" +
  "<footer>Mockups. Nothing is graded, no scheduler is wired, no database is written. " +
  "Regenerate with <code>vite-node build/mock/gen.ts</code> then <code>build/mock/html.ts</code>." +
  "</footer>";

writeFileSync("build/mock/out/index.html", INDEX, "utf-8");
writeFileSync("build/mock/out/a-terminal.html", A, "utf-8");
writeFileSync("build/mock/out/a2-terminal.html", A2, "utf-8");
writeFileSync("build/mock/out/b-document.html", B, "utf-8");
writeFileSync("build/mock/out/c-thumb.html", C, "utf-8");
console.log("wrote index a2-terminal a-terminal b-document c-thumb");
