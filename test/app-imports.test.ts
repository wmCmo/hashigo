import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const APP = resolve(import.meta.dirname, "..", "app");

function sources(): { name: string; text: string }[] {
  return readdirSync(APP)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(APP, name), "utf8") }));
}

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
    const providers = sources()
      .filter((s) => s.name !== "shell.ts" && /\bprovideShell\s*\(/.test(s.text))
      .map((s) => s.name);
    expect(providers).toEqual(["main.ts"]);
  });
});
