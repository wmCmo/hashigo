import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultStoreDatabase, openBlobStoreDatabase, type BlobStore } from "../src/blobs/index.js";
import { openDatabase } from "../src/db/index.js";
import { elementsByTag, memoryDocument, type MemoryElement } from "../src/render/dom.js";
import type { MediaMount } from "../src/render/nodes.js";
import type { PlayableMediaElement } from "../src/render/audio.js";
import { loadCard } from "../src/cards/index.js";
import { resolveDescriptorText } from "../src/generate/index.js";
import { readingOf } from "../src/review/text.js";
import {
  cardGaps,
  cardMode,
  mountCard,
  mountPrepared,
  mountTrack,
  prepareCard,
  promptsOnEntry,
} from "../src/review/index.js";

const DB = "build/hashigo.db";
const HAS_CORPUS = existsSync(DB);

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

        for (const side of card.loop.sides) side.enter();

        requested += card.audio.stats.requested;
        played += rec.plays.length;
        card.dispose();
      }

      expect(mounted).toBe(120);
      expect(clips).toBe(240);
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
      expect(revealedCards).toBe(40);
      expect(played).toBe(80);
      expect(bytesSeen).toBe(played);
    } finally {
      close();
    }
  });

  it("resolveGenerated is ON by default, and OFF costs a third of the audio", () => {
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
      expect(on).toBe(240);
      expect(off).toBe(120);
      expect(on).toBeGreaterThan(off);
    } finally {
      db.close();
    }
  });

  it("expands the generator fields, and reports zero divergence", () => {
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
      const order = (m: typeof fwd): number[] => m!.result.sides.map((s) => s.index);
      expect(order(fwd)).not.toEqual(order(rev));
      expect([...order(fwd)].sort()).toEqual([...order(rev)].sort());
      fwd!.dispose();
      rev!.dispose();
    } finally {
      close();
    }
  });

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
      expect(asked).toBe(60);
      expect(promptedSides).toBe(60);
      expect(played).toBe(60);
      expect(maskedAfterPrompt).toBe(120);
      expect(revealedAfterPrompt).toBe(0);
    } finally {
      close();
    }
  });

  it("the visible sentence side is NOT asked, even in mode 2", () => {
    const { db, store, close } = openCorpus();
    try {
      let sentenceSidesWithAudio = 0;
      for (const cardId of byMode(db, false, 30)) {
        const card = mountCard<MemoryElement>({ db, cardId, document: memoryDocument(), store });
        if (card === null) continue;
        for (const side of card.loop.sides) card.enter(side.position);
        for (const side of card.loop.sides) {
          if (side.trigger !== "audio") continue;
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
        expect(card.mode.mode).toBe("produce");
        expect(card.mode.accentDrill).toBe(false);

        const first = card.result.sides.filter((side) => !side.empty)[0]!;
        widgets += card.result.widgets.filter((w) => w.side === first.index).length;
        card.enter(first.position);
        if (card.loop.log.some((e) => e.kind === "prompt")) asked += 1;
        played += rec.plays.length;
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
      expect(played).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("promptsOnEntry is mode-blind on the widget arm, and audio-gated on both", () => {
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
      expect(promptsOnEntry("produce", side, 0)).toBe(false);
      const silent = card.loop.sides.find((s) => s.audio.length === 0)!;
      expect(promptsOnEntry("identify", silent, 5)).toBe(false);
      card.dispose();
    } finally {
      close();
    }
  });

  it("the mode split over the whole corpus is 692 produce / 3,177 identify", () => {
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
      expect(tally.drill).toBe(3870);
      expect(tally.drill - tally.identify).toBe(693);
      expect(tally.flippable).toBe(3478);
      expect(tally.produce).toBe(ids.length - 3177);
    } finally {
      db.close();
    }
  });

  it("漢字's plain field named `Reading` does not decide anything — 1,662 cards", () => {
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
      expect(withText).toBeGreaterThan(1000);
    } finally {
      db.close();
    }
  });

  it("敬語 and New Vocab never ask on entry — the word is VISIBLE beside the clip", () => {
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
        expect(card.mode.readingFieldId).toBeNull();
        for (const side of card.loop.sides) card.enter(side.position);
        played += rec.plays.length;
        const asked = card.loop.log.filter((e) => e.kind === "prompt");
        if (asked.length === 0) silent.push(cardId);
        prompts += asked.length;
        for (const event of asked) {
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
      expect(prompts).toBe(391);
      expect(masked).toBe(391);
      expect(silent).toEqual(["0Weo2702"]);

      expect(played).toBe(390);
      expect(prompts - played).toBe(1);
      expect(outcomes.get("playing")).toBe(390);
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
      const before = rec.plays.length;
      card!.loop.enter(side.position);
      expect(rec.plays.length).toBe(before);
      card!.dispose();
    } finally {
      close();
    }
  });

  it("a REVERSE identify track is SILENT on entry — the clip is the answer there", () => {
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
      expect(forwardAsked).toBe(40);
    } finally {
      close();
    }
  });

  it("REVERSE PERMUTES SIDES AND NOTHING ELSE — cloze order stays ascending inside each", () => {
    const { db, store, close } = openCorpus();
    try {
      const ids = byMode(db, false, 40);
      let permuted = 0;
      let sidesChecked = 0;
      for (const cardId of ids) {
        const shape = (kind: "forward" | "reverse"): { order: number[]; clozes: number[][] } => {
          const card = mountTrack<MemoryElement>({
            db,
            track: { cardId, kind },
            document: memoryDocument(),
            store,
          });
          if (card === null) return { order: [], clozes: [] };
          const order = card.loop.sides.map((side) => side.index);
          const clozes = card.loop.sides.map((side) => side.clozes.map((mount) => mount.ordinal));
          card.dispose();
          return { order, clozes };
        };
        const forward = shape("forward");
        const reverse = shape("reverse");
        if (forward.order.length === 0) continue;

        expect(new Set(reverse.order), cardId).toEqual(new Set(forward.order));
        if (reverse.order.join() !== forward.order.join()) permuted += 1;

        for (const perSide of [...forward.clozes, ...reverse.clozes]) {
          const ascending = [...perSide].sort((a, b) => a - b);
          expect(perSide, `${cardId} cloze order`).toEqual(ascending);
          sidesChecked += 1;
        }
      }
      // eslint-disable-next-line no-console
      console.log(`reverse: ${permuted}/40 cards permuted · ${sidesChecked} sides cloze-ordered`);
      expect(permuted).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("PreparedCard survives a REAL structuredClone, over 300 cards", () => {
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
        expect(copy.cardId).toBe(prepared.cardId);
        expect(copy.mode).toEqual(prepared.mode);
        expect(copy.sides.length).toBe(prepared.sides.length);
        expect(copy.loaded.values).toEqual(prepared.loaded.values);
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

describe("text generators get filled", () => {
  it("fills the example sentence, and leaves audio alone", () => {
    if (!HAS_CORPUS) return;
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const document = memoryDocument();
      const prepared = prepareCard({ db, cardId: "YH9TDoyg" });
      expect(prepared).not.toBeNull();
      const card = mountPrepared(prepared!, { document, resolve: () => null });

      expect(card.textSlots.length).toBeGreaterThan(0);
      expect(card.textSlots.every((s) => s.kind !== "speech")).toBe(true);

      const texts = card.textSlots.map((slot) =>
        resolveDescriptorText(db, {
          kind: slot.kind as never,
          text: slot.text,
          lang: slot.lang,
          voice: slot.voice,
          options: slot.options,
        }),
      );
      const filled = card.fillText(texts);
      expect(filled).toBeGreaterThan(0);

      const rendered = JSON.stringify(card.result.root);
      expect(rendered).toContain("皇居は東京にある日本の皇室の居所です。");
      card.dispose();
    } finally {
      db.close();
    }
  });

  it("fills nothing when there is no generation, rather than emptying the slot", () => {
    if (!HAS_CORPUS) return;
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const document = memoryDocument();
      const prepared = prepareCard({ db, cardId: "YH9TDoyg" });
      const card = mountPrepared(prepared!, { document, resolve: () => null });
      expect(card.fillText(card.textSlots.map(() => null))).toBe(0);
      card.dispose();
    } finally {
      db.close();
    }
  });
});

describe("furigana fills", () => {
  it("unwraps Mochi's bracket annotation to a plain reading", () => {
    expect(readingOf("野菜(やさい)")).toBe("やさい");
    expect(readingOf("あり得(え)る")).toBe("える");
    expect(readingOf("見舞(みま)い")).toBe("みまい");
    expect(readingOf("お世話(せわ)")).toBe("せわ");
    expect(readingOf("野菜（やさい）")).toBe("やさい");
    expect(readingOf("ひとり")).toBe("ひとり");
    expect(readingOf("")).toBe("");
  });

  it.skipIf(!HAS_CORPUS)("aligns the reading to the KANJI RUN over the real corpus", () => {
    const { db, store, close } = openCorpus();
    try {
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c JOIN templates t ON t.id = c.template_id
              WHERE t.name = '単語' AND c.archived = 0 ORDER BY c.id LIMIT 120`,
          )
          .all() as { id: string }[]
      ).map((row) => row.id);

      let filled = 0;
      let segmented = 0;
      for (const cardId of ids) {
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
        });
        if (card === null) continue;
        const slots = card.textSlots;
        const texts = slots.map((slot) =>
          resolveDescriptorText(db, {
            kind: slot.kind,
            text: slot.text,
            lang: slot.lang,
            voice: slot.voice,
            options: slot.options,
          } as never),
        );
        card.fillText(texts);
        for (const ruby of elementsByTag(card.result.root, "ruby")) {
          const align = ruby.getAttribute("data-ruby-align");
          if (align === null) continue;
          filled += 1;
          if (align === "segmented") segmented += 1;
          expect(ruby.textContent, cardId).not.toContain("(");
          expect(ruby.textContent, cardId).not.toContain("（");
        }
        card.dispose();
      }
      // eslint-disable-next-line no-console
      console.log(`furigana: ${filled} annotated · ${segmented} aligned run-by-run`);
      expect(filled).toBeGreaterThan(0);
      expect(segmented).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it.skipIf(!HAS_CORPUS)("NEVER OFFERS a furigana that is not behind a mask", () => {
    const { db, store, close } = openCorpus();
    try {
      let masked = 0;
      let bare = 0;
      let offered = 0;
      const ids = (
        db
          .prepare(
            `SELECT c.id FROM cards c
               JOIN templates t ON t.id = c.template_id
               JOIN template_fields f ON f.template_id = t.id AND f.name = 'Reading'
               JOIN card_field_values v ON v.card_id = c.id AND v.field_id = f.id
              WHERE c.archived = 0 AND v.value = 'true' ORDER BY c.id LIMIT 80`,
          )
          .all() as { id: string }[]
      ).map((row) => row.id);
      ids.push("66APe4TF", "FbT06BiI", "I3DYYihl", "NzXtdG1C", "OglIuWhv");
      for (const cardId of ids) {
        const card = mountCard<MemoryElement>({
          db,
          cardId,
          document: memoryDocument(),
          store,
        });
        if (card === null) continue;
        for (const mount of card.result.generations) {
          if (mount.name !== "furigana") continue;
          if (mount.request === null || mount.output === null) continue;
          if (mount.inCloze) masked += 1;
          else bare += 1;
        }
        offered += card.textSlots.filter((slot) => slot.name === "furigana").length;
        card.dispose();
      }
      // eslint-disable-next-line no-console
      console.log(`furigana on produce cards: ${masked} masked · ${bare} bare · ${offered} offered`);
      expect(masked).toBeGreaterThan(0);
      expect(bare).toBeGreaterThan(0);
      expect(offered).toBe(masked);
    } finally {
      close();
    }
  });
});

describe.skipIf(!HAS_CORPUS)("LaTeX reaches the shipping mount", () => {
  function mathCards(db: ReturnType<typeof openDatabase>, limit = 20): string[] {
    return (
      db
        .prepare(
          `SELECT DISTINCT v.card_id AS id FROM card_field_values v
            WHERE v.value LIKE '%$%' AND v.value LIKE '%\%' LIMIT ?`,
        )
        .all(limit) as { id: string }[]
    ).map((r) => r.id);
  }

  it("typesets every fragment in the corpus, and refuses none", () => {
    const { db, store, close } = openCorpus();
    try {
      const ids = mathCards(db);
      expect(ids.length).toBeGreaterThan(0);
      let subset = 0;
      let source = 0;
      for (const cardId of ids) {
        const card = mountCard<MemoryElement>({ db, cardId, document: memoryDocument(), store });
        if (card === null) continue;
        subset += card.result.census.get("math:subset") ?? 0;
        source += card.result.census.get("math:source") ?? 0;
        card.dispose();
      }
      expect(subset).toBeGreaterThan(0);
      expect(source, "a fragment fell outside the subset and rendered as source").toBe(0);
    } finally {
      close();
    }
  });

  it("puts ÷ on 変動費率, where he found it as `$\div$`", () => {
    const { db, store, close } = openCorpus();
    try {
      const row = db
        .prepare(`SELECT id FROM cards WHERE name LIKE '変動費率%' LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(row, "the card Zach reported is not in the corpus").toBeDefined();
      const card = mountCard<MemoryElement>({
        db,
        cardId: (row as { id: string }).id,
        document: memoryDocument(),
        store,
      });
      expect(card).not.toBeNull();
      const text = (card as NonNullable<typeof card>).result.sides
        .map((side) => side.element.textContent)
        .join(" ");
      expect(text).toContain("÷");
      expect(text).not.toContain("$");
      expect(text).not.toContain("\div");
      (card as NonNullable<typeof card>).dispose();
    } finally {
      close();
    }
  });
});

import { readingSwitch } from "../src/review/index.js";
import { booleanValue } from "../src/template/resolve.js";
import { decodeFieldOptions } from "../src/cards/index.js";

describe("decision 29's switch, found by role, agrees with the name on every template", () => {
  it("role-first and name-only pick the IDENTICAL field on all templates", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      const templates = db.prepare("SELECT id, name FROM templates").all() as { id: string; name: string }[];
      expect(templates.length).toBeGreaterThan(5);
      for (const template of templates) {
        const fields = (
          db
            .prepare("SELECT id, name, type, options FROM template_fields WHERE template_id = ? ORDER BY pos, id")
            .all(template.id) as { id: string; name: string; type: string; options: string | null }[]
        ).map((row) => ({ ...row, options: decodeFieldOptions(row.options ?? "{}") }));
        const byName = fields.find((field) => field.name.trim() === "Reading" && field.type === "boolean");
        expect(readingSwitch(fields)?.id, template.name).toBe(byName?.id);
      }
    } finally {
      db.close();
    }
  });

  it("a role on a NON-boolean is ignored — 漢字's plain Reading can never become the switch", () => {
    const fields = [
      { id: "k", name: "Reading", type: "plain", options: { "hashigo-role": "reading-switch" } },
    ];
    expect(readingSwitch(fields)).toBeUndefined();
  });

  it("the role wins over the name when both exist and point at different booleans", () => {
    const fields = [
      { id: "old", name: "Reading", type: "boolean", options: {} },
      { id: "new", name: "Produce", type: "boolean", options: { "hashigo-role": "reading-switch" } },
    ];
    expect(readingSwitch(fields)?.id).toBe("new");
  });
});

describe("booleanValue — the one rule the gate and the mode share", () => {
  it("a stored value always wins, including an explicit false", () => {
    expect(booleanValue("true", { "boolean-default": false })).toBe(true);
    expect(booleanValue("false", { "boolean-default": true })).toBe(false);
  });
  it("a card with no value takes the field's default", () => {
    expect(booleanValue(undefined, { "boolean-default": true })).toBe(true);
    expect(booleanValue("", { "boolean-default": true })).toBe(true);
    expect(booleanValue(undefined, { "boolean-default": false })).toBe(false);
  });
  it("no default means false — which is every card in the corpus today", () => {
    expect(booleanValue(undefined, {})).toBe(false);
    expect(booleanValue(undefined, undefined)).toBe(false);
  });
});

describe.skipIf(!HAS_CORPUS)("cardGaps", () => {
  const withNewWord = (word: string) => {
    const dir = mkdtempSync(join(tmpdir(), "hashigo-gaps-"));
    const copy = join(dir, "corpus.db");
    copyFileSync(DB, copy);
    const db = openDatabase(copy, { applySchema: false });
    db.prepare(
      `UPDATE card_field_values SET value = ?
        WHERE card_id = '01HxiZut'
          AND field_id = (SELECT f.id FROM template_fields f JOIN cards c ON c.template_id = f.template_id
                           WHERE c.id = '01HxiZut' AND f.name = '単語')`,
    ).run(word);
    return {
      db,
      done: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  it("names what a card renders and nothing has made — speech for the new word among it", () => {
    const { db, done } = withNewWord("係数テスト");
    try {
      const gaps = cardGaps(db, "01HxiZut");
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.every((gap) => gap.text.trim() !== "")).toBe(true);
      expect(gaps.some((gap) => gap.kind === "speech" && gap.text.includes("係数テスト"))).toBe(true);
    } finally {
      done();
    }
  });

  it("is empty for a card whose generations all exist", () => {
    const db = openDatabase(DB, { readOnly: true, applySchema: false });
    try {
      expect(cardGaps(db, "01HxiZut")).toEqual([]);
      expect(cardGaps(db, "no-such-card")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("never offers furigana — the Worker cannot make one, and a reading is drilled", () => {
    const { db, done } = withNewWord("係数テスト");
    try {
      const all = cardGaps(db, "01HxiZut", new Set(["ai", "translate", "speech", "furigana"]));
      const shipped = cardGaps(db, "01HxiZut");
      expect(shipped.length).toBeGreaterThan(0);
      expect(shipped.some((gap) => gap.kind === "furigana")).toBe(false);
      expect(all.some((gap) => gap.kind === "furigana")).toBe(true);
    } finally {
      done();
    }
  });
});
