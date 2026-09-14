/**
 * Decide whether a vitest run PASSED, from its summary rather than its exit code.
 *
 * ─── WHY THE EXIT CODE IS NOT USABLE HERE ───────────────────────────────────
 *
 * `npm test` exits 1 on a fully passing run of this suite, every time. birpc's RPC
 * timeout is a hard-coded 60,000 ms that vitest never overrides, `onTaskUpdate` is
 * an AWAITED call, and exactly the files that run longer than 60 s of their own
 * wall clock throw one `Timeout calling "onTaskUpdate"` each. Vitest counts that as
 * an unhandled error and exits non-zero while reporting every test as passed.
 *
 * It is not the reporter and not load: cutting workers changes nothing, quieting
 * the reporter changes nothing, and `--no-isolate` makes it worse. **`pool:
 * "threads"` is NOT the fix** — it removes the errors and then SEGFAULTS on the
 * third run, because `better-sqlite3` is a native addon and six threads in one
 * process crash it. It passes twice first, so two green runs are not evidence.
 *
 * ─── AND THIS IS STRICTER THAN THE EXIT CODE, NOT LOOSER ────────────────────
 *
 * Two conditions, both required: a summary line must EXIST, and it must report zero
 * failures. A crash prints no summary and therefore cannot pass — which is exactly
 * what caught the `pool: "threads"` segfault, where the exit code alone would have
 * said "1, same as always" and been ignored.
 *
 * ─── ONE COPY, TWO CALLERS ──────────────────────────────────────────────────
 *
 * `npm run gates` decided this correctly and `npm test` did not, so the two
 * disagreed about the same run — the honest answer was reachable only by knowing
 * which command to type. Both import this now. A rule with two implementations is
 * a rule that drifts (`NEXT.md`'s SSOT section is about exactly this).
 */

/** Strip ANSI so the summary can be matched. */
export function plainText(output) {
  return output.replace(/?\[[0-9;]*m/g, "");
}

/**
 * @returns {{ ok: boolean, detail: string, passed: number|null, failed: number|null,
 *             files: number|null, skipped: number|null, rpcTimeouts: number,
 *             slowFiles: string[] }}
 */
export function testVerdict(output, exitStatus) {
  const plain = plainText(output);
  const passed = /Tests\s+(?:.*?\| )?(\d[\d,]*) passed/.exec(plain);
  const failed = /Tests\s+(\d[\d,]*) failed/.exec(plain);
  const files = /Test Files\s+(?:.*?\| )?(\d+) passed/.exec(plain);
  const skipped = /(\d[\d,]*) skipped/.exec(plain);
  const rpcTimeouts = (plain.match(/Timeout calling "onTaskUpdate"/g) ?? []).length;

  // Named so the message can say WHICH file is over the ceiling. That is the only
  // actionable part: the fix is no file needing 60 s of its own wall clock.
  const slowFiles = [...plain.matchAll(/(test\/\S+\.test\.ts) \((\d+) tests?[^)]*\) (\d+)ms/g)]
    .map((m) => ({ file: m[1], ms: Number(m[3]) }))
    .filter((f) => f.ms > 60_000)
    .map((f) => `${f.file} (${(f.ms / 1000).toFixed(1)}s)`);

  const asNumber = (m) => (m === null ? null : Number(m[1].replace(/,/g, "")));

  if (passed === null) {
    return {
      ok: false,
      detail:
        `THE SUITE DID NOT FINISH — no summary line was printed, exit ${exitStatus}` +
        (exitStatus === 139 ? " (SIGSEGV)" : "") +
        `. This is a crash, not a failing test. Do not re-run and hope.`,
      passed: null,
      failed: null,
      files: null,
      skipped: null,
      rpcTimeouts,
      slowFiles,
    };
  }

  if (failed !== null) {
    return {
      ok: false,
      detail: `${files?.[1] ?? "?"} files, ${passed[1]} passed, ${failed[1]} FAILED`,
      passed: asNumber(passed),
      failed: asNumber(failed),
      files: asNumber(files),
      skipped: asNumber(skipped),
      rpcTimeouts,
      slowFiles,
    };
  }

  let detail = `${files?.[1] ?? "?"} files, ${passed[1]} passed`;
  if (skipped) detail += `, ${skipped[1]} skipped`;
  if (rpcTimeouts > 0) {
    detail +=
      `  [exit ${exitStatus}: ${rpcTimeouts} × onTaskUpdate timeout — birpc's ceiling is a` +
      ` hard-coded 60s and vitest does not expose it` +
      (slowFiles.length > 0 ? `; over 60s: ${slowFiles.join(", ")}` : "") +
      (exitStatus === 0
        ? `. Reported by the summary, which is what this reads.]`
        : `. The suite passed; raw vitest could not say so.]`);
  }
  return {
    ok: true,
    detail,
    passed: asNumber(passed),
    failed: null,
    files: asNumber(files),
    skipped: asNumber(skipped),
    rpcTimeouts,
    slowFiles,
  };
}
