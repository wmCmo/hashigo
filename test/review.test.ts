import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { defaultStoreDatabase, openBlobStoreDatabase, type BlobStore } from "../src/blobs/index.js";
import { openDatabase } from "../src/db/index.js";
import { memoryDocument, type MemoryElement } from "../src/render/dom.js";
import type { MediaMount } from "../src/render/nodes.js";
import type { PlayableMediaElement } from "../src/render/audio.js";
import { loadCard } from "../src/cards/index.js";
import {
  cardMode,
  mountCard,
  mountPrepared,
  mountTrack,
  prepareCard,
  promptsOnEntry,
} from "../src/review/index.js";

/**
 * `src/review` — the card mount, and the FIRST time `shadowingLoop` (the reveal
 * loop that actually ships) is driven over the real corpus.
 *
 * WHY THAT MATTERS. `spike/viewer/README.md` says it plainly: that harness
 * hand-rolls `revealSide()`/`armSide()` rather than importing `shadowingLoop`, so
 * its green no-autoplay panel is evidence about **Chromium**, not about the
 * shipping code. `test/reveal.test.ts` drives the loop but builds its renders by
 * hand. Nothing until now drove `loadCard -> render -> expand -> renderSides ->
 * audioController -> shadowingLoop` over real cards and then asked "did anything
 * play?".
 *
 * The controller's own `stats.requested` is the number to watch: it counts
 * `resolve` calls, so it is non-zero the moment anything tries to find a clip —
 * which is strictly earlier than anything being heard. Asserting on it rather
 * than on playback is the tighter test.
 */

const DB = "build/hashigo.db";
const HAS_CORPUS = existsSync(DB);

/**
 * A stand-in for a real `<audio>`, so playback can be counted in Node.
 *
 * Built with `Object.create` over the render's own `MemoryElement`, so it keeps
 * the `RenderElement` behaviour the controller needs (`setAttribute`, for the
 * `data-audio-state` it writes) and adds only the media surface.
 */
function recorder(): {
  plays: string[];
  playable: (mount: MediaMount<MemoryElement>) => PlayableMediaElement | null;
} {
  const plays: string[] = [];
  const fakes = new Map<MemoryElement, PlayableMediaElement>();
  const playable = (mount: MediaMount<MemoryElement>): PlayableMediaElement | null => {
    const existing = fakes.get(mount.element);
    if (existing !== undefined) return existing;
    let paused = true;
    const fake = Object.create(mount.element) as PlayableMediaElement;
    Object.defineProperties(fake, {
      src: { value: "", writable: true, enumerable: true },
      currentTime: { value: 0, writable: true, enumerable: true },
      paused: { get: () => paused, configurable: true },
      play: {
        value: () => {
          paused = false;
          plays.push(String((fake as { src: string }).src));
          return undefined;
        },
      },
      pause: { value: () => { paused = true; } },
      load: { value: () => {} },
    });
    fakes.set(mount.element, fake);
    return fake;
  };
  return { plays, playable };
}

function openCorpus(): { db: ReturnType<typeof openDatabase>; store: BlobStore; close: () => void } {
  const db = openDatabase(DB, { readOnly: true, applySchema: false });
  const opened = openBlobStoreDatabase(defaultStoreDatabase(DB), { mustExist: true });
  return { db, store: opened.store, close: () => db.close() };
}

describe.skipIf(!HAS_CORPUS)("mountCard over the real corpus", () => {
  /** Cards that actually carry speech, so the audio assertions mean something. */
  function speechCards(db: ReturnType<typeof openDatabase>, limit: number): string[] {
    return (
      db
        .prepare(
          `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
            WHERE t.name = '単語' ORDER BY c.id LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => r.id);
  }

  it("the LOOP's enter() plays NOTHING, on every side of every card, in either mode", () => {
    // `loop.enter()` is the call every other flashcard renderer uses to start the
    // audio; here it must not even RESOLVE a clip. Decision 29 did not soften
    // this by one card: the mode-2 question is asked by `mounted.enter()`, which
    // is a different method, and the two are tested apart on purpose. This one is
    // mode-BLIND — the 120 cards below are a mix — and it stays at zero.
    const { db, store, close } = openCorpus();
    try {
      const ids = speechCards(db, 120);
      let mounted = 0;
      let clips = 0;
      let requested = 0;
      let played = 0;

      for (const cardId of ids) {
        const rec = recorder();
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
          playable: rec.playable,
        });
        if (card === null) continue;
        mounted += 1;
        clips += card.clipCount;

        // Enter EVERY side, in presentation order, exactly as a screen would.
        for (const side of card.loop.sides) side.enter();

        requested += card.audio.stats.requested;
        played += rec.plays.length;
        card.dispose();
      }

      expect(mounted).toBe(120);
      // EXACT, not `> 100`. This assertion read `toBeGreaterThan(100)` until
      // 2026-08-23, which passed at 120 clips and at 238 — it could not tell a
      // corpus with a third of its audio missing from a whole one. See the
      // `resolveGenerated` test below for what that hid.
      expect(clips).toBe(238);
      // eslint-disable-next-line no-console
      console.log(
        `mount+enter over ${mounted} 単語 cards: ${clips} clip mounts · ` +
          `${requested} resolve calls · ${played} play() calls`,
      );
      expect(requested).toBe(0);
      expect(played).toBe(0);
    } finally {
      close();
    }
  });

  it("and REVEAL is what plays — same cards, same loop, one call different", () => {
    // The other half. A test that only proved silence would pass on a module that
    // never plays anything at all, which is the failure this pairs against.
    const { db, store, close } = openCorpus();
    try {
      let revealedCards = 0;
      let played = 0;
      let bytesSeen = 0;

      for (const cardId of speechCards(db, 40)) {
        const rec = recorder();
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
          playable: rec.playable,
        });
        if (card === null || card.clipCount === 0) continue;

        for (const side of card.loop.sides) side.enter();
        expect(card.audio.stats.requested, `${cardId} resolved on entry`).toBe(0);

        for (const side of card.loop.sides) side.reveal("caller");
        if (rec.plays.length > 0) {
          revealedCards += 1;
          played += rec.plays.length;
          bytesSeen += rec.plays.filter((s) => s.length > 0).length;
        }
        card.dispose();
      }

      // eslint-disable-next-line no-console
      console.log(
        `reveal over 40 単語 cards: ${revealedCards} cards played · ${played} play() calls`,
      );
      // 40 of 40 and 79 calls, not 39/39: with `resolveGenerated` on, most cards
      // carry a SECOND clip (the 例文 sentence audio) and revealing both sides
      // plays both. The one card that previously had nothing playable now does.
      expect(revealedCards).toBe(40);
      expect(played).toBe(79);
      // Every play had a source assigned first — the controller never calls
      // `play()` on a bare element, which in Chromium returns a promise that
      // neither resolves nor rejects.
      expect(bytesSeen).toBe(played);
    } finally {
      close();
    }
  });

  it("resolveGenerated is ON by default, and OFF costs a third of the audio", () => {
    // THE REGRESSION THIS FILE DID NOT CATCH, found by a peer review on
    // 2026-08-23. `Audio` and `Translate` chain off `例文`, an `ai` field with
    // zero stored values, so without a text resolver `fieldText` returns null and
    // the chain dies at hop one — silently. Both arms are asserted, because a test
    // on the default alone would still pass if the default were removed and the
    // corpus happened to shrink for some other reason.
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name = '単語' ORDER BY c.id LIMIT 120`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);

      const count = (resolveGenerated?: null): number => {
        let clips = 0;
        for (const cardId of ids) {
          const card = mountCard<MemoryElement>({
            db,
            cardId,
            document: memoryDocument(),
            ...(resolveGenerated === null ? { resolveGenerated: null } : {}),
          });
          if (card === null) continue;
          clips += card.clipCount;
          card.dispose();
        }
        return clips;
      };

      const on = count();
      const off = count(null);
      // eslint-disable-next-line no-console
      console.log(`resolveGenerated on: ${on} clip mounts · off: ${off}`);
      expect(on).toBe(238);
      expect(off).toBe(120);
      // The whole point: the default must be the ON number.
      expect(on).toBeGreaterThan(off);
    } finally {
      db.close();
    }
  });

  it("expands the generator fields, and reports zero divergence", () => {
    // `divergent` is `expandGeneratorFields`'s own "one way this can go quietly
    // wrong". Surfaced through the mount so a screen can assert on it.
    const { db, store, close } = openCorpus();
    try {
      let expanded = 0;
      const divergent: string[] = [];
      for (const cardId of speechCards(db, 60)) {
        const card = mountCard<MemoryElement>({ db, cardId, document: memoryDocument(), store });
        if (card === null) continue;
        expanded += card.expanded;
        divergent.push(...card.divergent);
        card.dispose();
      }
      expect(expanded).toBeGreaterThan(60);
      expect(divergent).toEqual([]);
    } finally {
      close();
    }
  });

  it("mountTrack picks the direction from the track kind", () => {
    const { db, store, close } = openCorpus();
    try {
      const [cardId] = speechCards(db, 1);
      const fwd = mountTrack<MemoryElement>({
        db,
        track: { cardId: cardId!, kind: "forward" },
        document: memoryDocument(),
        store,
      });
      const rev = mountTrack<MemoryElement>({
        db,
        track: { cardId: cardId!, kind: "reverse" },
        document: memoryDocument(),
        store,
      });
      expect(fwd).not.toBeNull();
      expect(rev).not.toBeNull();
      // Reverse permutes the side ORDER, never the authored indices.
      const order = (m: typeof fwd): number[] => m!.result.sides.map((s) => s.index);
      expect(order(fwd)).not.toEqual(order(rev));
      expect([...order(fwd)].sort()).toEqual([...order(rev)].sort());
      fwd!.dispose();
      rev!.dispose();
    } finally {
      close();
    }
  });

  // ─── decision 29: the two modes ────────────────────────────────────────────

  /** Card ids on 単語, split by the `Reading` boolean. */
  function byMode(
    db: ReturnType<typeof openDatabase>,
    reading: boolean,
    limit: number,
  ): string[] {
    const truthy = `EXISTS (SELECT 1 FROM card_field_values v
                              WHERE v.card_id = c.id AND v.field_id = '4Oge7w2M'
                                AND trim(v.value) NOT IN ('', 'false'))`;
    return (
      db
        .prepare(
          `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
            WHERE t.name = '単語' AND ${reading ? "" : "NOT "}${truthy}
            ORDER BY c.id LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => r.id);
  }

  it("MODE 1 (Reading = true) is exactly as hard as it ever was: entry plays NOTHING", () => {
    // Through `mounted.enter()` — the mode-AWARE method, the one a screen calls.
    // On a produce card it must be indistinguishable from `loop.enter()`.
    const { db, store, close } = openCorpus();
    try {
      const ids = byMode(db, true, 60);
      expect(ids).toHaveLength(60);
      let requested = 0;
      let played = 0;
      let clips = 0;
      for (const cardId of ids) {
        const rec = recorder();
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
          playable: rec.playable,
        });
        if (card === null) continue;
        expect(card.mode.mode, `${cardId} should be produce`).toBe("produce");
        expect(card.mode.reading).toBe(true);
        expect(card.mode.accentDrill).toBe(true);
        clips += card.clipCount;
        for (const side of card.loop.sides) card.enter(side.position);
        requested += card.audio.stats.requested;
        played += rec.plays.length;
        card.dispose();
      }
      // eslint-disable-next-line no-console
      console.log(
        `MODE 1 (produce), 60 cards: ${clips} clip mounts · ${requested} resolve calls · ` +
          `${played} play() calls`,
      );
      expect(clips).toBeGreaterThan(60);
      expect(requested).toBe(0);
      expect(played).toBe(0);
    } finally {
      close();
    }
  });

  it("MODE 2 (Reading not true) ASKS on entry — and leaves every cloze masked", () => {
    // The other exercise: the clip is the question and the kanji is the answer.
    // *"if you hide it behind the cloze, and play しょうきゃく … it would force me
    // to remember."*
    //
    // THE ASSERTION THAT MATTERS IS THE SECOND ONE. Playing on entry is easy to
    // get right and easy to get right the WRONG way — `side.play()` also plays,
    // and it unmasks, which would print the answer beside the question. So the
    // masked-count is checked after the audio has been asked for.
    const { db, store, close } = openCorpus();
    try {
      const ids = byMode(db, false, 60);
      expect(ids).toHaveLength(60);
      let asked = 0;
      let played = 0;
      let promptedSides = 0;
      let maskedAfterPrompt = 0;
      let revealedAfterPrompt = 0;
      for (const cardId of ids) {
        const rec = recorder();
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
          playable: rec.playable,
        });
        if (card === null) continue;
        expect(card.mode.mode, `${cardId} should be identify`).toBe("identify");
        expect(card.mode.reading).toBe(false);

        for (const side of card.loop.sides) card.enter(side.position);
        if (card.audio.stats.requested > 0) asked += 1;
        played += rec.plays.length;

        for (const side of card.loop.sides) {
          const prompt = card.loop.log.some(
            (event) => event.kind === "prompt" && event.side.index === side.index,
          );
          if (!prompt) continue;
          promptedSides += 1;
          if (side.revealed) revealedAfterPrompt += 1;
          maskedAfterPrompt += side.clozes.filter((cloze) => !cloze.revealed).length;
        }
        card.dispose();
      }
      // eslint-disable-next-line no-console
      console.log(
        `MODE 2 (identify), 60 cards: ${asked} cards asked · ${played} play() calls · ` +
          `${promptedSides} prompted sides · ${maskedAfterPrompt} clozes STILL MASKED · ` +
          `${revealedAfterPrompt} sides wrongly revealed`,
      );
      // Every one of the 60 asks, and exactly once: side 2 is the only side that
      // both masks something and carries a clip.
      expect(asked).toBe(60);
      expect(promptedSides).toBe(60);
      expect(played).toBe(60);
      // 単語 side 2 masks TWO clozes when `Reading` is false — `Reference` as text
      // and the furigana — so 60 sides carry 120 masks, and all 120 survive.
      expect(maskedAfterPrompt).toBe(120);
      expect(revealedAfterPrompt).toBe(0);
    } finally {
      close();
    }
  });

  it("the visible sentence side is NOT asked, even in mode 2", () => {
    // The trap one level down. An identify card has a sentence side too (`例文` +
    // `Audio`), and NOTHING on it is masked — so playing it on entry hands him a
    // pronunciation he has not produced, which is the autoplay defect again.
    // `promptsOnEntry` requires a cloze on the side for exactly this reason.
    const { db, store, close } = openCorpus();
    try {
      let sentenceSidesWithAudio = 0;
      for (const cardId of byMode(db, false, 30)) {
        const card = mountCard<MemoryElement>({ db, cardId, document: memoryDocument(), store });
        if (card === null) continue;
        for (const side of card.loop.sides) card.enter(side.position);
        for (const side of card.loop.sides) {
          if (side.trigger !== "audio") continue; // audio, nothing masked
          sentenceSidesWithAudio += 1;
          expect(promptsOnEntry(card.mode.mode, side), `${cardId} side ${side.index}`).toBe(false);
          expect(
            card.loop.log.some((e) => e.kind === "prompt" && e.side.index === side.index),
            `${cardId} side ${side.index} was asked`,
          ).toBe(false);
        }
        card.dispose();
      }
      expect(sentenceSidesWithAudio).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("数字 ASKS on entry — its clip is the question and a widget says so", () => {
    // ZACH CAUGHT THIS, 2026-08-23, by asking why his 数字 deck looked reversed.
    // His template is `<< Voice >>` + `<input value=<<NoComma>>>` / `---` /
    // `<< Number >>`: hear a number, TYPE it, then see it. The clip never played,
    // because the identify arm requires an `accent` field — a fact about 単語 and
    // 言葉 encoded as if it were a rule.
    //
    // MEASURED BEFORE THE FIX: the question side rendered an empty input, no text
    // and no sound. Ninety cards whose prompt was a blank screen.
    const { db, store, close } = openCorpus();
    try {
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name = '数字' AND c.archived = 0 ORDER BY c.id`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      // 78, not 90: twelve 数字 cards are ARCHIVED, and the queue excludes those
      // (`src/scheduler/queue.ts`), so they are excluded here too.
      expect(ids).toHaveLength(78);

      let asked = 0;
      let played = 0;
      let answerShown = 0;
      let widgets = 0;
      for (const cardId of ids) {
        const rec = recorder();
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
          playable: rec.playable,
        });
        if (card === null) continue;
        // It is NOT in the pitch-accent drill and must not be dragged into it:
        // 数字 declares no accent field, so the mode stays `produce`. The widget
        // arm is what fires, and it is deliberately mode-blind.
        expect(card.mode.mode).toBe("produce");
        expect(card.mode.accentDrill).toBe(false);

        const first = card.result.sides.filter((side) => !side.empty)[0]!;
        widgets += card.result.widgets.filter((w) => w.side === first.index).length;
        card.enter(first.position);
        if (card.loop.log.some((e) => e.kind === "prompt")) asked += 1;
        played += rec.plays.length;
        // And the ANSWER — the number, on the next side — is untouched by asking.
        for (const side of card.loop.sides) {
          if (side.position === first.position) continue;
          if (side.revealed) answerShown += 1;
        }
        card.dispose();
      }
      // eslint-disable-next-line no-console
      console.log(
        `数字, all ${ids.length}: ${asked} asked · ${played} play() calls · ` +
          `${widgets} widgets on question sides · ${answerShown} answers wrongly shown`,
      );
      expect(asked).toBe(ids.length);
      expect(widgets).toBe(ids.length);
      expect(answerShown).toBe(0);
      // The pairing: it really sounds, it is not merely "asked".
      expect(played).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("promptsOnEntry is mode-blind on the widget arm, and audio-gated on both", () => {
    // The arm has no mode gate ON PURPOSE — 数字 is `produce` — so this states the
    // contract directly rather than only through the corpus. A widget means
    // "produce your answer here", so whatever sounds beside it is the question by
    // construction, and there is nothing on the side that could be the answer.
    const { db, store, close } = openCorpus();
    try {
      const [cardId] = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name = '数字' ORDER BY c.id LIMIT 1`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      const card = mountCard<MemoryElement>({
        db,
        cardId: cardId!,
        document: memoryDocument(),
        store,
      })!;
      const side = card.loop.sides.find((s) => s.audio.length > 0)!;
      expect(promptsOnEntry("produce", side, 1)).toBe(true);
      expect(promptsOnEntry("identify", side, 1)).toBe(true);
      // No widget, no cloze, `produce` — the 敬語 / New Vocab shape, still silent.
      expect(promptsOnEntry("produce", side, 0)).toBe(false);
      // And nothing plays where there is nothing to play.
      const silent = card.loop.sides.find((s) => s.audio.length === 0)!;
      expect(promptsOnEntry("identify", silent, 5)).toBe(false);
      card.dispose();
    } finally {
      close();
    }
  });

  it("the mode split over the whole corpus is 692 produce / 3,177 identify", () => {
    // The two numbers decision 29 rests on, regenerated from the database rather
    // than repeated. Everything outside the pitch-accent drill is `produce`,
    // which is the mode that plays nothing on entry.
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const ids = (
        db.prepare("SELECT id FROM cards ORDER BY id").all() as { id: string }[]
      ).map((r) => r.id);
      const tally = { produce: 0, identify: 0, drill: 0, flippable: 0 };
      for (const id of ids) {
        const loaded = loadCard(db, id);
        if (loaded === null) continue;
        const mode = cardMode(loaded);
        tally[mode.mode] += 1;
        if (mode.accentDrill) tally.drill += 1;
        if (mode.readingFieldId !== null) tally.flippable += 1;
      }
      // eslint-disable-next-line no-console
      console.log(
        `corpus modes: produce ${tally.produce} · identify ${tally.identify} · ` +
          `accent drill ${tally.drill} · Reading flippable ${tally.flippable}`,
      );
      expect(tally.identify).toBe(3177);
      // 3,477 単語 + 392 言葉 = 3,869 cards run the drill; 692 of them produce.
      expect(tally.drill).toBe(3869);
      expect(tally.drill - tally.identify).toBe(692);
      // 単語 declares the boolean; 言葉 does not, so its 392 are permanently
      // identify and a toggle has nothing to write. 3,869 - 392 = 3,477.
      expect(tally.flippable).toBe(3477);
      // Everything else — 漢字, New Vocab, 基本情報, 敬語 … — is produce.
      expect(tally.produce).toBe(ids.length - 3177);
    } finally {
      db.close();
    }
  });

  it("漢字's plain field named `Reading` does not decide anything — 1,662 cards", () => {
    // The name collision that would have made this a one-liner and wrong. 漢字
    // declares `Reading` as a PLAIN text field holding the actual reading (コウ on
    // 36 cards, ショウ on 33). Only a boolean can be the switch, and 漢字 has no
    // accent field either, so it is outside the drill twice over.
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name = '漢字' ORDER BY c.id`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      expect(ids).toHaveLength(1662);
      let withText = 0;
      for (const id of ids) {
        const loaded = loadCard(db, id);
        if (loaded === null) continue;
        const mode = cardMode(loaded);
        expect(mode.mode, `${id} must not be identify`).toBe("produce");
        expect(mode.accentDrill).toBe(false);
        expect(mode.readingFieldId, `${id} exposed a plain field as the switch`).toBeNull();
        if ((loaded.values.get("atw8SiGn") ?? "") !== "") withText += 1;
      }
      // Proof the field really is populated — otherwise this test would pass on
      // an empty column and prove nothing about the collision.
      expect(withText).toBeGreaterThan(1000);
    } finally {
      db.close();
    }
  });

  it("敬語 and New Vocab never ask on entry — the word is VISIBLE beside the clip", () => {
    // Measured, not assumed: 敬語 side 1 is `<<言葉>>` then `<speech>` and New
    // Vocab side 1 is `<<Vocab>>` then `<<Pronunciation>>`. The head word is on
    // screen and unmasked, so a clip on entry gives away a pronunciation he has
    // not produced. 1,224 cards between them.
    const { db, store, close } = openCorpus();
    try {
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name IN ('敬語', 'New Vocab') ORDER BY c.id LIMIT 80`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      expect(ids.length).toBeGreaterThan(0);
      let played = 0;
      let requested = 0;
      for (const cardId of ids) {
        const rec = recorder();
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
          playable: rec.playable,
        });
        if (card === null) continue;
        expect(card.mode.mode, `${cardId} must not be identify`).toBe("produce");
        for (const side of card.loop.sides) card.enter(side.position);
        requested += card.audio.stats.requested;
        played += rec.plays.length;
        card.dispose();
      }
      expect(requested).toBe(0);
      expect(played).toBe(0);
    } finally {
      close();
    }
  });

  it("言葉 is identify on all 392, and 391 of them ask — the 392nd has no head word", () => {
    const { db, store, close } = openCorpus();
    try {
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name = '言葉' ORDER BY c.id`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      expect(ids).toHaveLength(392);
      let played = 0;
      let masked = 0;
      let prompts = 0;
      const silent: string[] = [];
      const outcomes = new Map<string, number>();
      for (const cardId of ids) {
        const rec = recorder();
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
          playable: rec.playable,
          onOutcome: (outcome) => {
            if (outcome.reason !== "prompt") return;
            outcomes.set(outcome.kind, (outcomes.get(outcome.kind) ?? 0) + 1);
          },
        });
        if (card === null) continue;
        expect(card.mode.mode).toBe("identify");
        // No `Reading` field on this template at all, so nothing to flip.
        expect(card.mode.readingFieldId).toBeNull();
        for (const side of card.loop.sides) card.enter(side.position);
        played += rec.plays.length;
        const asked = card.loop.log.filter((e) => e.kind === "prompt");
        if (asked.length === 0) silent.push(cardId);
        prompts += asked.length;
        for (const event of asked) {
          // `{{<<言葉>>}}` — the head word IS the cloze here, unlike 単語 where the
          // reading is. It must still be masked after the question.
          masked += event.side.clozes.filter((cloze) => !cloze.revealed).length;
        }
        card.dispose();
      }
      // eslint-disable-next-line no-console
      console.log(
        `言葉, all ${ids.length}: ${prompts} asked · ${played} play() calls · ` +
          `${masked} clozes still masked · no question ${JSON.stringify(silent)} · ` +
          `outcomes ${JSON.stringify(Object.fromEntries(outcomes))}`,
      );
      // 391, and the 392nd is NOT a defect in the mode logic — MEASURED, after a
      // first guess that blamed the corpus's never-generated clips and was wrong.
      // Card `0Weo2702` has an EMPTY head word, so `{{<<言葉>>}}` masks nothing and
      // `<<Speech>>` has no text to speak: 0 clozes, 0 clips, trigger `none`.
      // There is no question to ask, and `prompt()` returning false is the right
      // answer rather than a miss.
      expect(prompts).toBe(391);
      expect(masked).toBe(391);
      expect(silent).toEqual(["0Weo2702"]);

      // ── AND THE 14 THE SHELL HAS TO HANDLE ──
      // 377 of the 391 questions actually made a sound. The other 14 asked into a
      // clip the store cannot produce, and on an IDENTIFY card that is worse than
      // it is on a produce card: silence there is not a missing extra, it is the
      // question itself going missing, leaving a masked word, a `型` label and
      // nothing to identify. Pinned so the shell's fallback has a number to aim
      // at, and so this cannot drift unnoticed.
      expect(played).toBe(377);
      expect(prompts - played).toBe(14);
      expect(outcomes.get("playing")).toBe(377);
    } finally {
      close();
    }
  });

  it("asks at most once per entry, so a re-render does not double the audio", () => {
    const { db, store, close } = openCorpus();
    try {
      const [cardId] = byMode(db, false, 1);
      const rec = recorder();
      const card = mountCard<MemoryElement>({
        db,
        cardId: cardId!,
        document: memoryDocument(),
        store,
        playable: rec.playable,
      });
      const side = card!.loop.sides.find((s) => s.trigger === "cloze" && s.audio.length > 0)!;
      card!.enter(side.position);
      card!.enter(side.position);
      card!.enter(side.position);
      expect(rec.plays).toHaveLength(1);
      // `loop.enter` is still there and still silent — nothing was smuggled into it.
      const before = rec.plays.length;
      card!.loop.enter(side.position);
      expect(rec.plays.length).toBe(before);
      card!.dispose();
    } finally {
      close();
    }
  });

  it("a REVERSE identify track is SILENT on entry — the clip is the answer there", () => {
    // FOUND BY RUNNING THE APP, not by reasoning, and it is the reason
    // `promptsOnEntry` asks about the SIDE rather than about the card.
    //
    // Reverse permutes the side ORDER, so on a reverse 単語 track the first side
    // he sees is 意味 — a cloze and NO clip. The word's audio sits on a later
    // side, where it is the ANSWER, and autoplaying it on entry would hand him
    // the thing he is meant to produce. Forward and reverse are the SAME mode and
    // the same card; only the order differs.
    const { db, store, close } = openCorpus();
    try {
      const ids = byMode(db, false, 40);
      let reverseSilent = 0;
      let forwardAsked = 0;
      for (const cardId of ids) {
        for (const kind of ["forward", "reverse"] as const) {
          const rec = recorder();
          const card = mountTrack<MemoryElement>({
            db,
            track: { cardId, kind },
            document: memoryDocument(),
            store,
            playable: rec.playable,
          });
          if (card === null) continue;
          expect(card.mode.mode).toBe("identify");
          // Only the FIRST side is entered — what a screen shows as the question.
          const first = card.result.sides.filter((side) => !side.empty)[0];
          if (first === undefined) continue;
          card.enter(first.position);
          const asked = card.loop.log.some((event) => event.kind === "prompt");
          if (kind === "reverse") {
            expect(asked, `${cardId} reverse asked on entry`).toBe(false);
            expect(rec.plays, `${cardId} reverse played on entry`).toEqual([]);
            reverseSilent += 1;
          } else if (asked) {
            forwardAsked += 1;
          }
          card.dispose();
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `direction: ${forwardAsked}/40 forward asked on entry · ${reverseSilent}/40 reverse silent`,
      );
      expect(reverseSilent).toBe(40);
      // And the pairing, so this is not a test that would pass on a module that
      // never asks at all: the same 40 cards, forward, all ask.
      expect(forwardAsked).toBe(40);
    } finally {
      close();
    }
  });

  // ─── the process boundary the shell has ────────────────────────────────────

  it("PreparedCard survives a REAL structuredClone, over 300 cards", () => {
    // The app shell puts the database in a worker (OPFS sync access handles are
    // worker-only) and the DOM on the page, so a prepared card crosses
    // `postMessage`. "It looks like plain data" is exactly how a function ends up
    // in a payload and turns into a DataCloneError on the phone and never in the
    // suite — so this uses the real `structuredClone`, not a JSON round-trip,
    // because JSON silently DROPS a function where structuredClone throws.
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name IN ('単語', '言葉', '漢字', 'New Vocab', '基本情報')
              ORDER BY c.id LIMIT 300`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      let cloned = 0;
      let sides = 0;
      for (const cardId of ids) {
        const prepared = prepareCard({ db, cardId });
        if (prepared === null) continue;
        const copy = structuredClone(prepared) as typeof prepared;
        cloned += 1;
        sides += copy.sides.length;
        // The clone is EQUIVALENT, not merely cloneable — a payload that arrives
        // structurally different renders a different card.
        expect(copy.cardId).toBe(prepared.cardId);
        expect(copy.mode).toEqual(prepared.mode);
        expect(copy.sides.length).toBe(prepared.sides.length);
        expect(copy.loaded.values).toEqual(prepared.loaded.values);
        // `values` is a Map, which is why this is structuredClone and not JSON:
        // JSON.stringify turns a Map into `{}` and loses every field value.
        expect(copy.loaded.values instanceof Map).toBe(true);
      }
      // eslint-disable-next-line no-console
      console.log(`structuredClone: ${cloned} prepared cards · ${sides} sides`);
      expect(cloned).toBe(300);
      expect(sides).toBeGreaterThan(600);
    } finally {
      db.close();
    }
  });

  it("mountPrepared renders the same card mountCard does, and stays silent on entry", async () => {
    // The split must be a split, not a rewrite: the two halves composed by hand
    // have to equal the one-call form. Asserted on the numbers that matter —
    // clips, sides, mode — and on the hard rule surviving the boundary.
    const { db, store, close } = openCorpus();
    try {
      for (const cardId of speechCards(db, 20)) {
        const whole = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
        });
        const prepared = prepareCard({ db, cardId })!;
        // Deliberately through a CLONE and an ASYNC resolver — the shell's shape.
        const posted = structuredClone(prepared) as typeof prepared;
        const rec = recorder();
        const asked: string[] = [];
        const halves = mountPrepared<MemoryElement>(posted, {
          document: memoryDocument(),
          resolve: async (address) => {
            asked.push(address.origin);
            return null;
          },
          playable: rec.playable,
        });
        expect(halves.clipCount).toBe(whole!.clipCount);
        expect(halves.result.sides.length).toBe(whole!.result.sides.length);
        expect(halves.mode).toEqual(whole!.mode);
        expect(halves.expanded).toBe(whole!.expanded);

        // The rule across the boundary: entering asks the worker for NOTHING.
        for (const side of halves.loop.sides) halves.loop.enter(side.position);
        expect(asked, `${cardId} fetched a payload on entry`).toEqual([]);
        await halves.audio.idle();
        expect(rec.plays).toEqual([]);

        whole!.dispose();
        halves.dispose();
      }
    } finally {
      close();
    }
  });

  it("returns null for a card that does not exist, and dispose is idempotent", () => {
    const { db, store, close } = openCorpus();
    try {
      expect(
        mountCard<MemoryElement>({
          db,
          cardId: "no-such-card",
          document: memoryDocument(),
          store,
        }),
      ).toBeNull();

      const [cardId] = speechCards(db, 1);
      const card = mountCard<MemoryElement>({
        db,
        cardId: cardId!,
        document: memoryDocument(),
        store,
      });
      card!.dispose();
      expect(() => card!.dispose()).not.toThrow();
    } finally {
      close();
    }
  });
});
