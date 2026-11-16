export function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function intArg(name: string, fallback?: number): number {
  const raw = arg(name, fallback === undefined ? undefined : String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, not ${JSON.stringify(raw)}`);
  }
  return value;
}
