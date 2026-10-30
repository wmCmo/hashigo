/**
 * Decision 59's versioning rules — `scripts/release-rules.ts`, the one definition
 * `npm run release` and the cloud build's check both use.
 */
import { describe, expect, it } from "vitest";

import {
  contractValue,
  formatVersion,
  nextVersion,
  parseVersion,
  refuseBump,
  refuseDeploy,
  releaseNotes,
} from "../scripts/release-rules.js";

const v = parseVersion;
const unchanged = [
  { name: "SCHEMA_VERSION", before: 9, now: 9 },
  { name: "SYNC_VERSION", before: 1, now: 1 },
];

describe("the next version", () => {
  it("patch, minor and major move the right part and reset the rest", () => {
    expect(formatVersion(nextVersion(v("0.6.3"), "patch"))).toBe("0.6.4");
    expect(formatVersion(nextVersion(v("0.6.3"), "minor"))).toBe("0.7.0");
    expect(formatVersion(nextVersion(v("0.6.3"), "major"))).toBe("1.0.0");
  });

  it("refuses a version that is not three numbers", () => {
    expect(() => v("0.6")).toThrow(/MAJOR.MINOR.PATCH/);
  });
});

describe("which bump is allowed", () => {
  it("a patch that moved a contract both devices check is a minor", () => {
    const refusal = refuseBump({
      bump: "patch",
      current: v("0.6.0"),
      confirmedMajor: false,
      contracts: [...unchanged, { name: "ARCHIVE_VERSION", before: 1, now: 2 }],
    });
    expect(refusal).toMatch(/ARCHIVE_VERSION 1 -> 2.*minor, not a patch/);
    expect(refuseBump({ bump: "minor", current: v("0.6.0"), confirmedMajor: false, contracts: unchanged })).toBeNull();
  });

  it("a patch with no contract moved is fine", () => {
    expect(refuseBump({ bump: "patch", current: v("0.6.0"), confirmedMajor: false, contracts: unchanged })).toBeNull();
  });

  it("1.0 has to be asked for by name", () => {
    const base = { bump: "major" as const, current: v("0.9.2"), contracts: unchanged };
    expect(refuseBump({ ...base, confirmedMajor: false })).toMatch(/--one-point-oh/);
    expect(refuseBump({ ...base, confirmedMajor: true })).toBeNull();
  });
});

describe("the deploy check", () => {
  it("builds only a clean, tagged release", () => {
    expect(refuseDeploy({ version: "0.6.0", headTags: ["v0.6.0"], dirty: false })).toBeNull();
    expect(refuseDeploy({ version: "0.6.0", headTags: [], dirty: false })).toMatch(/not release v0\.6\.0/);
    // A tag for another version is not this release.
    expect(refuseDeploy({ version: "0.6.1", headTags: ["v0.6.0"], dirty: false })).toMatch(/not release/);
    expect(refuseDeploy({ version: "0.6.0", headTags: ["v0.6.0"], dirty: true })).toMatch(/uncommitted/);
  });
});

describe("the pieces read from the repo", () => {
  it("reads a contract constant the way the source declares it", () => {
    expect(contractValue("x\nexport const SYNC_VERSION = 1;\n", "SYNC_VERSION")).toBe(1);
    expect(contractValue("export const SYNC_VERSIONS = 1;", "SYNC_VERSION")).toBeNull();
  });

  it("writes the commits since the last release into the tag", () => {
    expect(releaseNotes(v("0.6.1"), "", ["fix(accent): 助けよう"])).toBe("v0.6.1\n\n- fix(accent): 助けよう\n");
    expect(releaseNotes(v("0.7.0"), "templates from scratch", [])).toContain("v0.7.0 — templates from scratch");
  });
});
