import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { defaultStoreDatabase, openBlobStoreDatabase, type BlobStore } from "../src/blobs/index.js";
import { openDatabase } from "../src/db/index.js";
import { memoryDocument, type MemoryElement } from "../src/render/dom.js";
import type { MediaMount } from "../src/render/nodes.js";
import type { PlayableMediaElement } from "../src/render/audio.js";
import { mountCard, mountTrack } from "../src/review/index.js";

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

  it("THE HARD RULE, through the SHIPPING loop: entering every side plays NOTHING", () => {
    // The whole point of this file. `enter()` is the call every other flashcard
    // renderer uses to start the audio; here it must not even RESOLVE a clip.
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
