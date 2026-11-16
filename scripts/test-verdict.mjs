export function plainText(output) {
  return output.replace(/?\[[0-9;]*m/g, "");
}

export function testVerdict(output, exitStatus) {
  const plain = plainText(output);
  const passed = /Tests\s+(?:.*?\| )?(\d[\d,]*) passed/.exec(plain);
  const failed = /Tests\s+(\d[\d,]*) failed/.exec(plain);
  const files = /Test Files\s+(?:.*?\| )?(\d+) passed/.exec(plain);
  const skipped = /(\d[\d,]*) skipped/.exec(plain);
  const rpcTimeouts = (plain.match(/Timeout calling "onTaskUpdate"/g) ?? []).length;

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
