/**
 * Regenerate `cards.json` — real cards, lifted verbatim out of the three
 * exports, for the stage-4 golden files.
 *
 *   npx vite-node test/fixtures/render/extract.ts -- --write-fixture
 *
 * `exports/` is 657 MB and gitignored, so this fixture is what lets the render
 * goldens be REAL rather than invented on a clean clone. Same contract as
 * `test/fixtures/templates/extract.ts`: generated, never hand-edited, and
 * `test/render.test.ts` re-derives it from the exports and fails if the two have
 * drifted.
 *
 * TWO KINDS OF ROW, and the split matters:
 *
 *   * ONE REPRESENTATIVE PER TEMPLATE ROW — all 11, so every template body has a
 *     golden of what Zach actually sees rather than of its `<<Field>>` skeleton.
 *     Chosen deterministically: the most-populated card, ties broken by id, so
 *     re-running this cannot quietly swap the sample.
 *   * NAMED CARDS, each carrying one thing the corpus has exactly once or twice
 *     and the renderer has to get right — the only `<span style>`, the only audio
 *     attachment, the only table, the U+200E adjacency in both its shapes, the
 *     two sides of 単語's `Reading` boolean. A census cannot see whether these
 *     render correctly; a golden can.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { fieldValueText } from "../../../src/import/entities.js";
import {
  asRecord,
  asRecords,
  asText,
  isRecord,
  loadExport,
  walkCards,
  type MochiRecord,
} from "../../../src/import/transit.js";

const EXPORT_NAMES = ["日本語", "English", "基本情報"] as const;
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const OUT = resolve(import.meta.dirname, "cards.json");
/** `.gitattributes` pins LF; written explicitly so the fixture cannot land twice. */
const NEWLINE = String.fromCharCode(10);

/** Cards named for one specific reason each. The reason is committed with them. */
const NAMED: readonly (readonly [string, string])[] = [
  ["29thh3wW", "the task's own example: ～に[[引き|…]]U+200E[[換え|…]], Reading false"],
  ["0u55CwvF", "U+200E between a PIPED link and a BARE one — both forms, adjacent"],
  ["ChtBgqLJ", "単語 with Reading TRUE: side 1 shows Reference outright"],
  ["QnHb5aT2", 'the corpus’s only <span style="color:yellow">'],
  ["CtDsQetR", "the corpus's only audio attachment: ![…](uVQp0iMb.mp3)"],
  ["Hz4r241V", "an @media/ image reference inside a field value"],
  ["urSsYURi", "漢字: inline $…$ math, plus the <draw> canvas on side 2"],
  ["ucxaOAxb", "the corpus's only markdown table, on a TEMPLATE-LESS card"],
];

interface FixtureCard {
  readonly why: string;
  readonly export: string;
  readonly id: string;
  /** `""` for a template-less card, whose sides come from `content`. */
  readonly templateId: string;
  readonly content: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface RenderFixture {
  readonly generatedFrom: readonly string[];
  readonly cards: readonly FixtureCard[];
}

interface Raw {
  readonly export: string;
  readonly id: string;
  readonly templateId: string;
  readonly content: string;
  readonly values: Record<string, string>;
}

function readAll(): { cards: Raw[]; names: Map<string, string> } {
  const cards: Raw[] = [];
  const names = new Map<string, string>();
  for (const name of EXPORT_NAMES) {
    const root = loadExport(resolve(ROOT, "exports", name));
    for (const template of asRecords(root["templates"])) {
      names.set(asText(template["id"]), asText(template["name"]));
    }
    for (const { card } of walkCards(root)) {
      const values: Record<string, string> = {};
      for (const [fieldId, field] of Object.entries(asRecord(card["fields"]))) {
        values[fieldId] = fieldValueText(isRecord(field) ? (field as MochiRecord)["value"] : field);
      }
      cards.push({
        export: name,
        id: asText(card["id"]),
        templateId: asText(card["template-id"]),
        content: asText(card["content"]),
        values,
      });
    }
  }
  return { cards, names };
}

function populated(card: Raw): number {
  return Object.values(card.values).filter((value) => value !== "").length;
}

export function buildFixture(): RenderFixture {
  const { cards, names } = readAll();
  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const chosen = new Map<string, FixtureCard>();

  // One representative per (export, template) pair, deterministically.
  const pairs = new Set(
    cards.filter((card) => card.templateId !== "").map((card) => `${card.export}\u0000${card.templateId}`),
  );
  for (const pair of [...pairs].sort()) {
    const [exportName = "", templateId = ""] = pair.split("\u0000");
    const candidates = cards
      .filter((card) => card.export === exportName && card.templateId === templateId)
      .sort((a, b) => populated(b) - populated(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const pick = candidates[0];
    if (pick === undefined) continue;
    chosen.set(pick.id, {
      why: `representative of ${exportName}/${names.get(templateId) ?? templateId}`,
      export: pick.export,
      id: pick.id,
      templateId: pick.templateId,
      content: pick.content,
      values: pick.values,
    });
  }

  for (const [id, why] of NAMED) {
    const card = byId.get(id);
    if (card === undefined) throw new Error(`named fixture card ${id} is not in the exports`);
    // A named reason wins over "representative of …": it says why the card is here.
    chosen.set(id, {
      why,
      export: card.export,
      id: card.id,
      templateId: card.templateId,
      content: card.content,
      values: card.values,
    });
  }

  return {
    generatedFrom: [...EXPORT_NAMES],
    cards: [...chosen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/**
 * Written only on an explicit flag:
 *
 *     npx vite-node test/fixtures/render/extract.ts -- --write-fixture
 *
 * NOT the usual `import.meta.url === pathToFileURL(process.argv[1]).href`
 * guard. Under this repo's `vite-node`, `process.argv[1]` is
 * `node_modules/vite-node/vite-node.mjs` and the script path is not in `argv` at
 * all, so that guard can never fire — see the ORPHAN note in the stage-4 report
 * about `test/fixtures/templates/extract.ts`, where it silently does nothing and
 * still exits 0. A flag is checkable.
 *
 * It must stay conditional: `test/render.test.ts` imports `buildFixture` to
 * check the committed fixture has not drifted from the exports, and a module that
 * rewrote the fixture on import would make that check vacuous.
 */
if (process.argv.includes("--write-fixture")) {
  const fixture = buildFixture();
  mkdirSync(resolve(import.meta.dirname), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}${NEWLINE}`, "utf8");
  process.stdout.write(`wrote ${fixture.cards.length} cards to ${OUT}${NEWLINE}`);
}
