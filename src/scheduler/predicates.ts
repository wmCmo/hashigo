export function liveTrack(track = "t", card = "c"): string {
  return `${track}.dormant = 0 AND ${card}.archived = 0`;
}

export function dueOnOrBefore(track = "t", param = "?"): string {
  return `substr(${track}.due_at, 1, 10) <= ${param}`;
}

export function dueBefore(track = "t", param = "?"): string {
  return `substr(${track}.due_at, 1, 10) < ${param}`;
}

export function dueAfter(track = "t", param = "?"): string {
  return `substr(${track}.due_at, 1, 10) > ${param}`;
}

export function isNewTrack(track = "t"): string {
  return `${track}.due_at IS NULL AND ${track}.reps = 0`;
}
