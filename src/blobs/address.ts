export const ADDRESS_PATTERN = /^[0-9a-f]{64}$/;

export const SHARD_LENGTH = 2;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function assertAddress(value: unknown): string {
  if (!isAddress(value)) {
    throw new TypeError(
      `not a content address: ${JSON.stringify(value)} ` +
        `(expected 64 lowercase hex characters of sha256)`,
    );
  }
  return value;
}

export function shardOf(hash: string): string {
  return assertAddress(hash).slice(0, SHARD_LENGTH);
}

export function addressPath(hash: string): string {
  return `${shardOf(hash)}/${hash}`;
}
