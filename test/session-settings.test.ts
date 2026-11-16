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
      expect(readSetting(handle, SESSION_SETTING_KEYS.newLimit)).toBeNull();
      expect(readSetting(handle, SESSION_SETTING_KEYS.interleave)).toBeNull();
      expect(readSessionSettings(handle)).toEqual({
        newLimit: DEFAULT_NEW_LIMIT,
        interleave: DEFAULT_INTERLEAVE,
        examTarget: "準2",
        rejected: [],
      });
    } finally {
      handle.close();
    }
  });

  it("resolves the 漢検 exam target, and flags a value the queue cannot use — decision 53", () => {
    const handle = db();
    try {
      expect(readSetting(handle, SESSION_SETTING_KEYS.examTarget)).toBeNull();
      for (const good of ["off", "3", "準2", "2"]) {
        writeSetting(handle, SESSION_SETTING_KEYS.examTarget, good);
        expect(readSessionSettings(handle).examTarget).toBe(good);
        expect(readSessionSettings(handle).rejected).toEqual([]);
      }
      writeSetting(handle, SESSION_SETTING_KEYS.examTarget, "pre-2");
      const settings = readSessionSettings(handle);
      expect(settings.examTarget).toBe("準2");
      expect(settings.rejected).toEqual([{ key: SESSION_SETTING_KEYS.examTarget, value: "pre-2" }]);
    } finally {
      handle.close();
    }
  });

  it("writes, reads back, and reports what it replaced — which is what an undo needs", () => {
    const handle = db();
    try {
      expect(writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "14")).toBeNull();
      expect(readSessionSettings(handle).newLimit).toBe(14);
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
    const handle = db();
    try {
      writeSetting(handle, SESSION_SETTING_KEYS.newLimit, "50");
      expect(buildSession(handle, { newLimit: 0 }).progress().planned).toBe(0);
      expect(buildSession(handle).progress().planned).toBe(0);
      expect(readSessionSettings(handle).newLimit).toBe(50);
    } finally {
      handle.close();
    }
  });
});
