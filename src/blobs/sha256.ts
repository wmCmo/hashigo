const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";

export class Sha256 {
  readonly #h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  readonly #w = new Uint32Array(64);
  readonly #tail = new Uint8Array(64);
  #tailLength = 0;
  #length = 0;
  #done = false;

  update(bytes: Uint8Array): this {
    if (this.#done) throw new Error("Sha256: update() after hex()");
    this.#length += bytes.length;
    let offset = 0;

    if (this.#tailLength > 0) {
      const want = Math.min(64 - this.#tailLength, bytes.length);
      this.#tail.set(bytes.subarray(0, want), this.#tailLength);
      this.#tailLength += want;
      offset = want;
      if (this.#tailLength < 64) return this;
      this.#block(this.#tail, 0);
      this.#tailLength = 0;
    }

    const end = bytes.length - 63;
    for (; offset < end; offset += 64) this.#block(bytes, offset);

    if (offset < bytes.length) {
      this.#tail.set(bytes.subarray(offset), 0);
      this.#tailLength = bytes.length - offset;
    }
    return this;
  }

  hex(): string {
    if (this.#done) throw new Error("Sha256: hex() called twice");
    this.#done = true;

    const bitsHigh = Math.floor(this.#length / 0x20000000);
    const bitsLow = (this.#length << 3) >>> 0;

    const pad = this.#tail;
    let n = this.#tailLength;
    pad[n] = 0x80;
    n += 1;
    if (n > 56) {
      pad.fill(0, n);
      this.#block(pad, 0);
      n = 0;
    }
    pad.fill(0, n, 56);
    pad[56] = (bitsHigh >>> 24) & 0xff;
    pad[57] = (bitsHigh >>> 16) & 0xff;
    pad[58] = (bitsHigh >>> 8) & 0xff;
    pad[59] = bitsHigh & 0xff;
    pad[60] = (bitsLow >>> 24) & 0xff;
    pad[61] = (bitsLow >>> 16) & 0xff;
    pad[62] = (bitsLow >>> 8) & 0xff;
    pad[63] = bitsLow & 0xff;
    this.#block(pad, 0);

    let out = "";
    for (let i = 0; i < 8; i += 1) {
      const word = this.#h[i] as number;
      for (let shift = 28; shift >= 0; shift -= 4) {
        out += HEX[(word >>> shift) & 0xf];
      }
    }
    return out;
  }

  #block(bytes: Uint8Array, at: number): void {
    const w = this.#w;
    const h = this.#h;

    for (let i = 0; i < 16; i += 1) {
      const j = at + i * 4;
      w[i] =
        (((bytes[j] as number) << 24) |
          ((bytes[j + 1] as number) << 16) |
          ((bytes[j + 2] as number) << 8) |
          (bytes[j + 3] as number)) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex();
}
