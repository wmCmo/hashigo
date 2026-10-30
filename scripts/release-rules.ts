/**
 * THE VERSIONING RULES, AS CODE — decision 59. Pure: no git, no files.
 *
 * `scripts/release.ts` makes a release with these and `scripts/release-check.ts`
 * refuses a cloud build without one. They are here, apart from both, so the rules
 * have tests (`test/release.test.ts`) and exactly one definition.
 *
 *   major   0 until 1.0 — RELEASE.md: "he could hand a friend the link and
 *           explain nothing". A bump to 1 must be asked for by name.
 *   minor   a milestone: something new he can do, OR anything both devices must
 *           update for — a change to SCHEMA_VERSION, SYNC_VERSION or
 *           ARCHIVE_VERSION. That second half is checked, not trusted.
 *   patch   a deploy that only fixes things. One per DEPLOY, not per commit: the
 *           build commit in Settings already tells one build from the next; the
 *           version says which release a device is on.
 *
 * WHY ENFORCED. The version sat at 0.5.0 for 35 days and ~100 commits, and the
 * file that was supposed to track it said "none is met today" about criteria
 * three of four had met. A rule only a document states drifts.
 */

export type Bump = "patch" | "minor" | "major";

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseVersion(text: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (match === null) throw new Error(`${text} is not a MAJOR.MINOR.PATCH version`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function nextVersion(current: Version, bump: Bump): Version {
  if (bump === "major") return { major: current.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { ...current, patch: current.patch + 1 };
}

/** The three numbers a device checks before it trusts data from another one. */
export const CONTRACTS = [
  { name: "SCHEMA_VERSION", file: "src/schema/index.ts" },
  { name: "SYNC_VERSION", file: "src/sync/merge.ts" },
  { name: "ARCHIVE_VERSION", file: "src/backup/archive.ts" },
] as const;

/** `export const NAME = 9;` in a file's text, or null if the line is gone. */
export function contractValue(source: string, name: string): number | null {
  const match = new RegExp(`^export const ${name} = (\\d+);`, "m").exec(source);
  return match === null ? null : Number(match[1]);
}

export interface BumpCheck {
  readonly bump: Bump;
  /** Each contract's value at the previous release and now. */
  readonly contracts: readonly { readonly name: string; readonly before: number | null; readonly now: number | null }[];
  /** True only when he asked for 1.0 by name (`--one-point-oh`). */
  readonly confirmedMajor: boolean;
  readonly current: Version;
}

/** Why this bump is not allowed, or null when it is. */
export function refuseBump(check: BumpCheck): string | null {
  if (check.bump === "major" && check.current.major === 0 && !check.confirmedMajor) {
    return (
      "1.0 is RELEASE.md's \"he could hand a friend the link and explain nothing\". " +
      "Pass --one-point-oh if that is what this is."
    );
  }
  if (check.bump === "patch") {
    const moved = check.contracts.filter((c) => c.before !== c.now);
    if (moved.length > 0) {
      const what = moved.map((c) => `${c.name} ${c.before ?? "?"} -> ${c.now ?? "?"}`).join(", ");
      return `${what} since the last release: both devices must update for that, so it is a minor, not a patch.`;
    }
  }
  return null;
}

/**
 * The tag's message: the one line he gives, then every commit since the last
 * release. That list IS the changelog — kept by git, so it cannot go stale.
 */
export function releaseNotes(version: Version, summary: string, subjects: readonly string[]): string {
  const head = `v${formatVersion(version)}${summary.trim() === "" ? "" : ` — ${summary.trim()}`}`;
  const body = subjects.length === 0 ? "(no commits since the last release)" : subjects.map((s) => `- ${s}`).join("\n");
  return `${head}\n\n${body}\n`;
}

export interface DeployState {
  readonly version: string;
  /** Tags pointing at HEAD. */
  readonly headTags: readonly string[];
  /** Tracked files differ from HEAD. */
  readonly dirty: boolean;
}

/** Why this commit may not be built for the cloud, or null when it may. */
export function refuseDeploy(state: DeployState): string | null {
  if (state.dirty) {
    return "the working tree has uncommitted changes, so the build would not be the release it claims to be.";
  }
  const tag = `v${state.version}`;
  if (!state.headTags.includes(tag)) {
    return (
      `HEAD is not release ${tag}. Every deploy is a release (decision 59): ` +
      "`npm run release -- patch` for fixes, `-- minor \"what is new\"` for a milestone."
    );
  }
  return null;
}
