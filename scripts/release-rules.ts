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

export const CONTRACTS = [
  { name: "SCHEMA_VERSION", file: "src/schema/index.ts" },
  { name: "SYNC_VERSION", file: "src/sync/merge.ts" },
  { name: "ARCHIVE_VERSION", file: "src/backup/archive.ts" },
] as const;

export function contractValue(source: string, name: string): number | null {
  const match = new RegExp(`^export const ${name} = (\\d+);`, "m").exec(source);
  return match === null ? null : Number(match[1]);
}

export interface BumpCheck {
  readonly bump: Bump;
  readonly contracts: readonly { readonly name: string; readonly before: number | null; readonly now: number | null }[];
  readonly confirmedMajor: boolean;
  readonly current: Version;
}

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

export function releaseNotes(version: Version, summary: string, subjects: readonly string[]): string {
  const head = `v${formatVersion(version)}${summary.trim() === "" ? "" : ` — ${summary.trim()}`}`;
  const body = subjects.length === 0 ? "(no commits since the last release)" : subjects.map((s) => `- ${s}`).join("\n");
  return `${head}\n\n${body}\n`;
}

export interface DeployState {
  readonly version: string;
  readonly headTags: readonly string[];
  readonly dirty: boolean;
}

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
