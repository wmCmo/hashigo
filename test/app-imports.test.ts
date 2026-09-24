import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE TWO RULES THE 2026-09-25 SPLIT OF `app/main.ts` DEPENDS ON.
 *
 * Zach, that day: *"how many lines do we have in main.ts...? few thousands line?
 * is this even healthy...?"* — 7,386 lines, 46 shared mutable variables, touched
 * by 73 commits. It was split along its own section banners into feature modules,
 * and the split holds only while two things stay true. Both are the kind of rule a
 * comment states and a later edit quietly breaks, so they are pinned here.
 *
 *   1. NOTHING IMPORTS `main.ts`. It is the entry point and the review screen, and
 *      the one module with side effects at load. A feature that needs something it
 *      still owns goes through `app/shell.ts`, the port `main.ts` provides once at
 *      boot. A cycle through the entry works only while no module reads an import
 *      during evaluation — true today, and not something anyone would check.
 *   2. THE WORKER IS CREATED ONCE, in `app/worker-client.ts`. Two workers means two
 *      sqlite-wasm instances contending for one OPFS SAH pool, and the second one
 *      fails with "this page is already open in another tab" — the exact error a
 *      stale tab produced during the split, which is how its shape is known.
 *
 * Plain text reads of the sources, because `test/` cannot import `app/` modules
 * that touch the DOM at load — which is most of them.
 */

const APP = resolve(import.meta.dirname, "..", "app");

function sources(): { name: string; text: string }[] {
  return readdirSync(APP)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(APP, name), "utf8") }));
}

/** Every module specifier a file imports, static or dynamic. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
    out.push(m[1] as string);
  }
  for (const m of text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) out.push(m[1] as string);
  return out;
}

describe("the split of app/main.ts", () => {
  it("found the modules it is about — this is not a test of an empty directory", () => {
    const names = sources().map((s) => s.name);
    for (const expected of ["main.ts", "shell.ts", "worker-client.ts", "layers.ts", "ops.ts"]) {
      expect(names).toContain(expected);
    }
  });

  it("NOTHING imports main.ts — features reach back through app/shell.ts", () => {
    const offenders = sources()
      .filter((s) => s.name !== "main.ts")
      .flatMap((s) =>
        specifiers(s.text)
          .filter((spec) => /(^|\/)main(\.js|\.ts)?$/.test(spec))
          .map((spec) => `${s.name} imports ${spec}`),
      );
    expect(offenders).toEqual([]);
  });

  it("the specifier scan would have caught one, so the test above has teeth", () => {
    expect(specifiers('import { x } from "./main.js";')).toEqual(["./main.js"]);
    expect(specifiers('const m = await import("./main.js");')).toEqual(["./main.js"]);
    expect(specifiers("import {\n  a,\n  b,\n} from \"./main.js\";")).toEqual(["./main.js"]);
  });

  it("creates the database worker exactly once, in worker-client.ts", () => {
    const creators = sources()
      .filter((s) => /new\s+Worker\s*\(/.test(s.text))
      .map((s) => s.name);
    expect(creators).toEqual(["worker-client.ts"]);
  });

  it("keeps main.ts the only caller of provideShell", () => {
    // The port is provided ONCE, by the entry point. A second provider would
    // silently replace the first and a feature would call into whichever won.
    const providers = sources()
      .filter((s) => s.name !== "shell.ts" && /\bprovideShell\s*\(/.test(s.text))
      .map((s) => s.name);
    expect(providers).toEqual(["main.ts"]);
  });
});
