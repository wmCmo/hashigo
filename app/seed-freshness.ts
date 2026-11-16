export function audioIsStale(serving: string | undefined, held: string | undefined): boolean {
  if (serving === undefined || serving === "") return false;
  return serving !== (held ?? "");
}
