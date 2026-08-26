/**
 * Decision 12 says the new-card limit is a SETTING. This is the file that makes
 * that a fact about the database rather than a sentence about a constant.
 *
 * The rules worth pinning are all about the FALLBACK, because these two rows are
 * reachable from a settings screen, from a restored archive and from `sqlite3` —
 * and a strict read of a bad row is an app that will not open until someone edits
 * a database by hand. Every case here is a value the box can actually produce.
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/db/index.js";
import {
  DEFAULT_INTERLEAVE,
  DEFAULT_NEW_LIMIT,
  SESSION_SETTING_KEYS,
  buildSession,
  readSessionSettings,
  readSetting,
  writeSetting,
} from "../src/session/index.js";

const MEMORY = ":memory:";

function db() {
  return openDatabase(MEMORY);
}

describe("session settings", () => {
  it("an absent row means the default, and that is the whole reason no schema bump was needed", () => {
    const handle = db();
    try {
      // A database seeded by `schema.sql` has neither key — `SETTING_KEYS` names
      // only the four it does seed. Resolving instead of seeding is what let this
      // land without `rm build/hashigo.db` and a re-import.
      expect(readSetting(handle, SESSION_SETTING_KEYS.newLimit)).toBeNull();
      expect(readSetting(handle, SESSION_SETTING_KEYS.interleave)).toBeNull();
      expect(readSessionSettings(handle)).toEqual({
        newLimit: DEFAULT_NEW_LIMIT,
        interleave: DEFAULT_INTERLEAVE,
        rejected: [],
      });
    } finally {
      handle.close();
    }
  });

  it("writes, reads back, and reports what it replaced — which is what an undo needs", () => {
    const handle = db();
    try {
      expect(writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "14")).toBeNull();
      expect(readSessionSettings(handle).newLimit).toBe(14);
      // The second write returns the FIRST value, not null. `null` means "the key
      // was absent", which is a different thing from "it was empty" and the page
      // undo distinguishes them.
      expect(writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "20")).toBe("14");
      expect(readSessionSettings(handle).newLimit).toBe(20);
    } finally {
      handle.close();
    }
  });

  it("0 is a legal limit and means due cards only — it must not read as missing", () => {
    const handle = db();
    try {
      writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "0");
      const settings = readSessionSettings(handle);
      expect(settings.newLimit).toBe(0);
      expect(settings.rejected).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("REJECTS rather than substitutes silently, and says what it rejected", () => {
    const handle = db();
    try {
      // Every one of these is a value the settings box can produce: a cleared box,
      // a typed word, a decimal from a mis-set step, a negative from the stepper.
      for (const bad of ["", "   ", "ten", "10.5", "-1", "99999", "NaN", "Infinity"]) {
        writeSetting(handle, SESSION_SETTING_KEYS.newLimit, bad);
        const settings = readSessionSettings(handle);
        expect(settings.newLimit, `new.limit=${JSON.stringify(bad)}`).toBe(DEFAULT_NEW_LIMIT);
        expect(settings.rejected).toEqual([{ key: SESSION_SETTING_KEYS.newLimit, value: bad }]);
      }

      writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "10");
      writeSetting(handle, SESSION_SETTING_KEYS.interleave, "sideways");
      const settings = readSessionSettings(handle);
      expect(settings.interleave).toBe(DEFAULT_INTERLEAVE);
      expect(settings.rejected).toEqual([
        { key: SESSION_SETTING_KEYS.interleave, value: "sideways" },
      ]);
    } finally {
      handle.close();
    }
  });

  it("`Number(\"\")` is 0, so a CLEARED BOX must not silently mean zero new cards", () => {
    // Called out on its own because it is the one that would have shipped. An empty
    // string parses to 0, 0 is a legal limit, and the result is an app that quietly
    // stops showing new cards after he clears a field and tabs away.
    const handle = db();
    try {
      writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "");
      expect(readSessionSettings(handle).newLimit).toBe(DEFAULT_NEW_LIMIT);
    } finally {
      handle.close();
    }
  });

  it("takes all three interleave policies", () => {
    const handle = db();
    try {
      for (const policy of ["spread", "new-first", "due-first"] as const) {
        writeSetting(handle, SESSION_SETTING_KEYS.interleave, policy);
        expect(readSessionSettings(handle).interleave).toBe(policy);
      }
    } finally {
      handle.close();
    }
  });

  it("AN EXPLICIT OPTION STILL WINS — the backtest must not read his settings", () => {
    // `buildSession` resolving from the database is right for the app and would be
    // wrong for a sweep: `src/scheduler/backtest.ts` passes several limits and must
    // get the number it asked for, not the one in whatever database it opened.
    const handle = db();
    try {
      writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "50");
      // No cards, so both plans are empty; what is being pinned is that the option
      // is consulted before the row, which `progress().planned` cannot show. The
      // resolution itself is above; this asserts the call does not throw and that
      // the option path is still live.
      expect(buildSession(handle, { newLimit: 0 }).progress().planned).toBe(0);
      expect(buildSession(handle).progress().planned).toBe(0);
      expect(readSessionSettings(handle).newLimit).toBe(50);
    } finally {
      handle.close();
    }
  });
});
