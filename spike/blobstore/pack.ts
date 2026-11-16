export interface PackHeader {
  readonly count: number;
  readonly totalBytes: number;
  readonly entries: readonly (readonly [string, number])[];
}

const MAGIC = "HSGPACK1";

export type PackVisitor = (hash: string, bytes: Uint8Array, index: number) => void;

export interface PackResult {
  readonly header: PackHeader;
  readonly bytes: number;
  readonly networkMs: number;
}

export async function readPack(url: string, visit: PackVisitor): Promise<PackResult> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (response.body === null) throw new Error(`${url}: no response body to stream`);
  const reader = response.body.getReader();

  let networkMs = 0;
  let tail: Uint8Array = new Uint8Array(0);
  let done = false;

  const pull = async (): Promise<Uint8Array | null> => {
    const started = performance.now();
    const next = await reader.read();
    networkMs += performance.now() - started;
    if (next.done) {
      done = true;
      return null;
    }
    return next.value;
  };

  const fill = async (want: number): Promise<void> => {
    while (tail.length < want && !done) {
      const chunk = await pull();
      if (chunk === null) break;
      const merged = new Uint8Array(tail.length + chunk.length);
      merged.set(tail, 0);
      merged.set(chunk, tail.length);
      tail = merged;
    }
  };

  await fill(12);
  if (tail.length < 12) throw new Error(`${url}: shorter than a pack prefix`);
  const magic = String.fromCharCode(...tail.subarray(0, 8));
  if (magic !== MAGIC) throw new Error(`${url}: magic is ${JSON.stringify(magic)}, not ${MAGIC}`);
  const headerLength = new DataView(tail.buffer, tail.byteOffset, 12).getUint32(8, true);
  await fill(12 + headerLength);
  if (tail.length < 12 + headerLength) throw new Error(`${url}: truncated header`);
  const header = JSON.parse(
    new TextDecoder().decode(tail.subarray(12, 12 + headerLength)),
  ) as PackHeader;
  tail = tail.slice(12 + headerLength);

  let bytes = 0;
  for (let index = 0; index < header.entries.length; index += 1) {
    const entry = header.entries[index] as readonly [string, number];
    const [hash, size] = entry;
    const payload = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (tail.length === 0) {
        const chunk = await pull();
        if (chunk === null) throw new Error(`${url}: ran out at payload ${index} (${hash})`);
        tail = chunk;
      }
      const take = Math.min(size - filled, tail.length);
      payload.set(tail.subarray(0, take), filled);
      filled += take;
      tail = tail.subarray(take);
    }
    bytes += size;
    visit(hash, payload, index);
  }

  return { header, bytes, networkMs };
}
