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
const NEWLINE = String.fromCharCode(10);

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

if (process.argv.includes("--write-fixture")) {
  const fixture = buildFixture();
  mkdirSync(resolve(import.meta.dirname), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}${NEWLINE}`, "utf8");
  process.stdout.write(`wrote ${fixture.cards.length} cards to ${OUT}${NEWLINE}`);
}
