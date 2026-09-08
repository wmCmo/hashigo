/**
 * The content-addressed, refcounted blob store: `src/blobs/*` (the store that
 * owns the bytes) and `src/import/blobs.ts` (what puts the corpus into it).
 *
 * Three halves, really. The unit half proves each rule against hand-built
 * bytes. The corpus half runs the real 657 MB export through it and asserts the
 * oracle: 10,890 live attachments in, 8,983 tombstones out, 10,826 addresses.
 * The third proves THE POINT — that the database holds no location, so the
 * store can be renamed out from under it and every read still resolves. Corpus
 * tests are skipped when exports/ is absent, since exports/ is gitignored.
 *
 * SINCE THE BACKING SWAP there are two implementations of `BlobStore`, and every
 * rule in `store.ts` is asserted against BOTH — `storeImplementations` below. The
 * production one is `SqliteBlobStore` (BLOB rows in a separate `blobs.db`), which
 * is the same class the browser runs; `NodeBlobStore` (one file per payload) is
 * kept for export and interop. Two implementations is what makes it possible to
 * tell a property of the interface from an accident of one backing, and the
 * corpus half now runs through the SQLite one because that is what ships.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  BATCH_FLUSH_BYTES,
  BlobConflictError,
  addressPath,
  assertAddress,
  auditBlobStore,
  BlobMissingError,
  defaultStoreDatabase,
  defaultStoreRoot,
  findLocations,
  isAddress,
  LOCATION_PATTERN,
  MemoryBlobStore,
  Sha256,
  openBlobStore,
  openBlobStoreDatabase,
  openSqliteBlobStore,
  readBlob,
  shardOf,
  sha256Hex,
  STORE_PAGE_SIZE,
  sweepUnreferenced,
  type BlobStore,
  type OpenedSqliteStore,
} from "../src/blobs/index.js";
import { GENERATION_KEY_SCHEME } from "../src/blobs/generation.js";
import { MEMORY, checkIntegrity, openDatabase, type Db } from "../src/db/index.js";
import {
  addBlobRef,
  canonicaliseOptions,
  contentAddress,
  generationIdentity,
  generationKey,
  importBlobs,
  lookupGeneration,
  normaliseLanguageTag,
  normaliseSourceText,
  parseEdnOptions,
  putBlob,
  resolveGeneration,
  removeBlobRef,
  retargetBlobRef,
  sniffMime,
  splitComponentCacheKey,
  type MochiMediaSource,
} from "../src/import/blobs.js";

// ─── throwaway directories ───────────────────────────────────────────────────

const SCRATCH: string[] = [];
const OPEN_STORES: OpenedSqliteStore[] = [];

/** A directory that exists for one test run and is removed afterwards. */
function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hashigo-${label}-`));
  SCRATCH.push(dir);
  return dir;
}

/**
 * A throwaway SQLite blob store. Registered for closing: the store borrows a
 * better-sqlite3 handle it does not own, and on Windows an unclosed handle keeps
 * a lock that makes the scratch directory undeletable — a passing test would then
 * leave 660 MB behind.
 */
function scratchStore(label: string): OpenedSqliteStore {
  const opened = openBlobStoreDatabase(join(scratchDir(label), "hashigo.db.blobs.db"));
  OPEN_STORES.push(opened);
  return opened;
}

afterAll(() => {
  for (const opened of OPEN_STORES) {
    try {
      opened.close();
    } catch {
      /* already closed by the test that opened it */
    }
  }
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A byte string that sniffs as mp3: bare MPEG-1 Layer III frame sync. */
function mp3(seed: string): Uint8Array {
  return Uint8Array.from([0xff, 0xf3, 0xe4, 0xc4, ...Buffer.from(seed, "utf8")]);
}
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * blob_refs.card_id is a foreign key, so the cards have to exist. The real
 * pipeline gets them from the card importer; this is the minimum skeleton.
 */
function seedCards(db: Db, ids: readonly string[]): void {
  db.prepare("INSERT OR IGNORE INTO decks (id, name) VALUES ('d', 'test')").run();
  const insert = db.prepare("INSERT OR IGNORE INTO cards (id, deck_id) VALUES (?, 'd')");
  db.transaction(() => {
    for (const id of ids) insert.run(id);
  })();
}

function fresh(cardIds: readonly string[] = []): Db {
  const db = openDatabase(MEMORY);
  if (cardIds.length > 0) seedCards(db, cardIds);
  return db;
}

/** An in-memory media directory, so the unit tests never touch a disk. */
function memoryMedia(files: Readonly<Record<string, Uint8Array>>) {
  return (_dir: string, name: string): Uint8Array | null => files[name] ?? null;
}

// ─── mime is sniffed, never trusted ──────────────────────────────────────────

describe("mime sniffing", () => {
  it("reads mp3 out of bytes that CLAIM to be text/xml", () => {
    // SPEC: Azure's SSML content-type leaked into Mochi's attachment metadata.
    const record = { size: 31680, type: "text/xml" };
    expect(record.type).toBe("text/xml");
    expect(sniffMime(mp3("audio"))).toBe("audio/mpeg");
  });

  it("does not mistake a JPEG for an mp3 frame", () => {
    // Both start 0xff, and 0xd8 & 0xe0 === 0xc0, so ordering is what saves this.
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
  });

  it("recognises an ID3 container and falls back for unknown bytes", () => {
    expect(sniffMime(Buffer.from("ID3\u0003\u0000", "utf8"))).toBe("audio/mpeg");
    expect(sniffMime(new Uint8Array(0))).toBe("application/octet-stream");
    expect(sniffMime(Buffer.from("hello", "utf8"))).toBe("application/octet-stream");
  });
});

// ─── component-cache keys ────────────────────────────────────────────────────

describe("component-cache keys", () => {
  it("splits the real key shapes", () => {
    expect(
      splitComponentCacheKey('だけに {:lang "ja-JP", :voice "ja-JP-NanamiNeural"}'),
    ).toEqual({
      text: "だけに",
      options: { lang: "ja-JP", voice: "ja-JP-NanamiNeural" },
    });
    expect(splitComponentCacheKey("尽くめ {}")).toEqual({ text: "尽くめ", options: {} });
    expect(splitComponentCacheKey('握る {:from "jp", :to "en"}').options).toEqual({
      from: "jp",
      to: "en",
    });
  });

  it("does not eat a cloze in the source text", () => {
    // {{…}} appears 1,087 times in the corpus; a greedy regex swallows it.
    expect(splitComponentCacheKey('{{食べる}} {:lang "ja-JP"}')).toEqual({
      text: "{{食べる}}",
      options: { lang: "ja-JP" },
    });
    expect(splitComponentCacheKey("{{食べる}}")).toEqual({
      text: "{{食べる}}",
      options: {},
    });
  });

  it("parses unquoted and escaped edn values", () => {
    expect(parseEdnOptions('{:ai-task "custom"}')).toEqual({ "ai-task": "custom" });
    expect(parseEdnOptions('{:n 3, :ok true, :q "a\\"b"}')).toEqual({
      n: "3",
      ok: "true",
      q: 'a"b',
    });
  });
});

// ─── BCP-47 ──────────────────────────────────────────────────────────────────

describe("language codes", () => {
  it("normalises Mochi's inline jp to ja-JP for a voice locale", () => {
    expect(normaliseLanguageTag("jp", true)).toBe("ja-JP");
    expect(normaliseLanguageTag("ja", true)).toBe("ja-JP");
    expect(normaliseLanguageTag("ja-JP", true)).toBe("ja-JP");
    expect(normaliseLanguageTag("en", true)).toBe("en-US");
    expect(normaliseLanguageTag("de-de", true)).toBe("de-DE");
  });

  it("normalises jp to ja for a translation parameter, leaving ja alone", () => {
    // The corpus has :from "jp" returning 404 and :from "ja" succeeding on 握る.
    expect(normaliseLanguageTag("jp", false)).toBe("ja");
    expect(normaliseLanguageTag("ja", false)).toBe("ja");
    expect(canonicaliseOptions({ from: "jp", to: "en" })).toBe('{"from":"ja","to":"en"}');
    expect(canonicaliseOptions({ lang: "jp" })).toBe('{"lang":"ja-JP"}');
  });

  it("strips a combining mark so the corpus's one ่jp does not fall through", () => {
    // U+0E48 THAI CHARACTER MAI EK in front of `jp`. It appears once, on an
    // inline generator, counted from the raw export with codepoints. Before the
    // NFKD strip the lookup key was "่jp", which is in neither alias table,
    // so the tag survived intact all the way into the address — one TTS request
    // for a locale no provider knows, plus a permanent cache miss.
    expect(normaliseLanguageTag("่jp", true)).toBe("ja-JP");
    expect(normaliseLanguageTag("่jp", false)).toBe("ja");
    expect(canonicaliseOptions({ lang: "่jp" })).toBe('{"lang":"ja-JP"}');
    // Nothing legitimate moves: no valid BCP-47 tag contains a mark.
    expect(normaliseLanguageTag("zh-Hant", true)).toBe("zh-Hant");
    expect(normaliseLanguageTag("jp-JP", true)).toBe("jp-JP");
  });

  it("canonicalises option order, so ordering cannot fork the address", () => {
    expect(canonicaliseOptions({ voice: "v", gender: "male" })).toBe(
      canonicaliseOptions({ gender: "male", voice: "v" }),
    );
  });
});

// ─── the key ─────────────────────────────────────────────────────────────────

describe("generation key", () => {
  const base = { kind: "speech", text: "領域", voice: "ja-JP-NanamiNeural" } as const;

  it("is identical for jp and ja-JP", () => {
    expect(generationKey(generationIdentity({ ...base, lang: "jp" }))).toBe(
      generationKey(generationIdentity({ ...base, lang: "ja-JP" })),
    );
  });

  it("ignores invisible edits and whitespace runs, not real ones", () => {
    expect(normaliseSourceText("領​域")).toBe("領域");
    expect(normaliseSourceText("  領  域 ")).toBe("領 域");
    expect(generationKey(generationIdentity({ ...base, text: "領​域" }))).toBe(
      generationKey(generationIdentity({ ...base, text: "領域" })),
    );
    expect(generationKey(generationIdentity({ ...base, text: "領地" }))).not.toBe(
      generationKey(generationIdentity(base)),
    );
  });

  it("keeps :gender, which distinguishes 34 real keys in the corpus", () => {
    expect(
      generationKey(generationIdentity({ ...base, options: { gender: "male" } })),
    ).not.toBe(generationKey(generationIdentity(base)));
  });
});

// ─── the store itself ────────────────────────────────────────────────────────

describe("content addressing and refcounts", () => {
  it("addresses a blob by sha256 of its bytes, verifiably", () => {
    const db = fresh(["c1"]);
    const bytes = mp3("領域");
    const { hash, inserted } = putBlob(db, { bytes, kind: "speech" });
    expect(inserted).toBe(true);
    expect(hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    const row = db.prepare("SELECT bytes, mime, byte_size FROM blobs WHERE hash = ?").get(hash) as {
      bytes: Buffer;
      mime: string;
      byte_size: number;
    };
    expect(contentAddress(row.bytes)).toBe(hash);
    expect(row.mime).toBe("audio/mpeg");
    expect(row.byte_size).toBe(bytes.length);
    db.close();
  });

  it("refcounts by referencing card, and deletes only at zero", () => {
    const db = fresh(["c1", "c2"]);
    const { hash } = putBlob(db, { bytes: mp3("shared"), kind: "speech" });
    addBlobRef(db, { blobHash: hash, cardId: "c1", refKey: "a.mp3" });
    addBlobRef(db, { blobHash: hash, cardId: "c2", refKey: "a.mp3" });
    const refcount = () =>
      db.prepare("SELECT refcount FROM blobs WHERE hash = ?").pluck().get(hash) as number;
    expect(refcount()).toBe(2);

    expect(() => db.prepare("DELETE FROM blobs WHERE hash = ?").run(hash)).toThrow(
      /still referenced/,
    );

    db.prepare("DELETE FROM blob_refs WHERE card_id = 'c1'").run();
    expect(refcount()).toBe(1);
    db.prepare("DELETE FROM blob_refs WHERE card_id = 'c2'").run();
    expect(refcount()).toBe(0);
    db.prepare("DELETE FROM blobs WHERE hash = ?").run(hash);
    expect(db.prepare("SELECT count(*) FROM blobs").pluck().get()).toBe(0);
    db.close();
  });

  it("adding the same reference twice does not inflate the refcount", () => {
    const db = fresh(["c1"]);
    const { hash } = putBlob(db, { bytes: mp3("x"), kind: "speech" });
    expect(addBlobRef(db, { blobHash: hash, cardId: "c1", refKey: "a.mp3" })).toBe(true);
    expect(addBlobRef(db, { blobHash: hash, cardId: "c1", refKey: "a.mp3" })).toBe(false);
    expect(db.prepare("SELECT refcount FROM blobs").pluck().get()).toBe(1);
    db.close();
  });
});

// ─── the fix: identical input is a cache hit ─────────────────────────────────

describe("regenerating identical input", () => {
  const request = {
    kind: "speech",
    text: "スプリント",
    voice: "ja-JP-NanamiNeural",
    lang: "ja-JP",
  } as const;

  it("two identical (text, voice, lang) inputs produce ONE address and ONE call", () => {
    const db = fresh();
    let calls = 0;
    const generate = () => {
      calls += 1;
      return { bytes: mp3(`take-${calls}`) }; // Azure is not bit-reproducible
    };

    const first = resolveGeneration(db, request, generate);
    const second = resolveGeneration(db, request, generate);

    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(second.key).toBe(first.key);
    expect(calls).toBe(1);
    expect(db.prepare("SELECT count(*) FROM blobs").pluck().get()).toBe(1);
    db.close();
  });

  it("hits across the jp / ja-JP spelling split", () => {
    const db = fresh();
    let calls = 0;
    const generate = () => {
      calls += 1;
      return { bytes: mp3("once") };
    };
    const declared = resolveGeneration(db, request, generate);
    const inline = resolveGeneration(db, { ...request, lang: "jp" }, generate);
    expect(inline.hit).toBe(true);
    expect(inline.hash).toBe(declared.hash);
    expect(calls).toBe(1);
    db.close();
  });

  it("a typo and its undo cost nothing and create nothing", () => {
    // SPEC's exact case: sプリント -> スプリント billed five generations.
    const db = fresh();
    let calls = 0;
    const generate = () => {
      calls += 1;
      return { bytes: mp3(`v${calls}`) };
    };
    const before = resolveGeneration(db, request, generate);
    resolveGeneration(db, { ...request, text: "sプリント" }, generate); // the typo
    const after = resolveGeneration(db, request, generate); // undone
    expect(after.hash).toBe(before.hash);
    expect(after.hit).toBe(true);
    expect(calls).toBe(2); // one per DISTINCT input, not one per edit
    db.close();
  });

  it("never serves a zero-byte blob as a cache hit", () => {
    // 10 live attachments in the corpus are failed Azure calls, 0 bytes.
    const db = fresh();
    putBlob(db, {
      bytes: new Uint8Array(0),
      kind: "speech",
      identity: generationIdentity(request),
    });
    expect(lookupGeneration(db, generationIdentity(request))).toBeNull();
    db.close();
  });
});

// ─── importing records ───────────────────────────────────────────────────────

describe("importBlobs", () => {
  it("skips tombstones, dedupes identical bytes, and sniffs past a bad type", () => {
    const files = {
      "live.mp3": mp3("hello"),
      "copy.mp3": mp3("hello"), // byte-identical to live.mp3
      "gone.mp3": mp3("orphan"), // tombstoned: must not be imported
      "pic.jpg": JPEG,
    };
    const sources: MochiMediaSource[] = [
      {
        mediaDir: "/memory",
        cards: [
          {
            id: "c1",
            attachments: {
              "live.mp3": { size: 9, type: "text/xml" }, // the SSML leak
              "gone.mp3": { size: 9, type: "text/xml", "deleted?": true },
              "pic.jpg": { size: 6, type: "" },
            },
            "component-cache": {
              speech: {
                'こんにちは {:lang "jp"}': { attachment: "live.mp3" },
                'さようなら {:lang "jp"}': { attachment: "gone.mp3" },
                'もしもし {:lang "jp"}': { attachment: "never-existed.mp3" },
              },
              ai: { "Describe X using emojis {}": { text: "🎯", date: "2025-05-10" } },
              dictionary: { '握る {:from "jp"}': { error: "Dictionary not found.", status: 404 } },
            },
          },
          { id: "c2", attachments: { "copy.mp3": { size: 9, type: "" } } },
        ],
      },
    ];

    const db = fresh(["c1", "c2"]);
    const report = importBlobs(db, sources, {
      store: "inline",
      readMedia: memoryMedia(files),
    });

    expect(report.liveAttachments).toBe(3);
    expect(report.tombstonesSkipped).toBe(1);
    expect(report.distinctFiles).toBe(3);
    expect(report.dedupedFiles).toBe(1); // live.mp3 and copy.mp3 are one blob
    expect(report.mediaBlobs).toBe(2);
    expect(report.mediaRefs).toBe(3);
    expect(report.cachePointers).toBe(3);
    expect(report.cachePointersLive).toBe(1);
    expect(report.cachePointersTombstoned).toBe(1);
    expect(report.cachePointersDangling).toBe(1);
    expect(report.cacheFailures).toBe(1); // the 404 is not cached
    expect(report.textBlobs).toBe(1); // the ai text generation

    // The tombstoned file has no blob and no reference anywhere.
    const refKeys = db.prepare("SELECT ref_key FROM blob_refs").pluck().all() as string[];
    expect(refKeys).not.toContain("gone.mp3");
    expect(new Set(refKeys).has("live.mp3")).toBe(true);
    expect(contentAddress(files["gone.mp3"])).not.toBe(
      db.prepare("SELECT hash FROM blobs WHERE mime = 'audio/mpeg'").pluck().get(),
    );

    // Type came from the bytes, and lang from BCP-47 normalisation.
    const speech = db
      .prepare("SELECT mime, refcount, source_text, lang FROM blobs WHERE kind = 'speech'")
      .get() as { mime: string; refcount: number; source_text: string; lang: string };
    expect(speech.mime).toBe("audio/mpeg");
    expect(speech.refcount).toBe(2);
    expect(speech.source_text).toBe("こんにちは");
    expect(speech.lang).toBe("ja-JP");

    const image = db.prepare("SELECT kind, mime FROM blobs WHERE mime LIKE 'image/%'").get();
    expect(image).toEqual({ kind: "image", mime: "image/jpeg" });

    // Re-importing changes nothing: refcounts do not drift.
    const second = importBlobs(db, sources, { store: "inline", readMedia: memoryMedia(files) });
    expect(second.mediaBlobs).toBe(0);
    expect(second.mediaRefs).toBe(0);
    expect(db.prepare("SELECT sum(refcount) FROM blobs").pluck().get()).toBe(4);
    expect(checkIntegrity(db)).toEqual([]);
    db.close();
  });

  it("counts rather than forces a reference to a card that was never imported", () => {
    const db = fresh([]); // no cards at all
    const report = importBlobs(
      db,
      [{ mediaDir: "/memory", cards: [{ id: "ghost", attachments: { "a.mp3": { size: 4 } } }] }],
      { store: "inline", readMedia: memoryMedia({ "a.mp3": mp3("a") }) },
    );
    expect(report.refsSkippedUnknownCard).toBe(1);
    expect(report.mediaRefs).toBe(0);
    expect(db.prepare("SELECT refcount FROM blobs").pluck().get()).toBe(0);
    db.close();
  });
});

// ─── the corpus ──────────────────────────────────────────────────────────────


// ─── the store that owns the bytes ───────────────────────────────────────────

describe("addresses", () => {
  it("is 64 lowercase hex characters, and nothing else is", () => {
    const hash = contentAddress(mp3("a"));
    expect(isAddress(hash)).toBe(true);
    expect(isAddress(hash.toUpperCase())).toBe(false);
    expect(isAddress(hash.slice(0, 63))).toBe(false);
    expect(isAddress("../../etc/passwd")).toBe(false);
    expect(() => assertAddress("C:\\DEV\\WEB\\hashigo\\exports\\日本語\\c7EiABp0.mp3")).toThrow(
      /not a content address/,
    );
  });

  it("derives the location from the hash, relative and POSIX", () => {
    const hash = contentAddress(mp3("a"));
    expect(shardOf(hash)).toBe(hash.slice(0, 2));
    expect(addressPath(hash)).toBe(`${hash.slice(0, 2)}/${hash}`);
    // Relative: no drive letter, no leading slash, nothing machine-specific.
    expect(addressPath(hash).startsWith("/")).toBe(false);
    expect(addressPath(hash)).not.toContain(":");
  });

  it("names a database's default store beside it, never inside exports/", () => {
    // The production default is a FILE, `<db>.blobs.db`; the legacy directory
    // store's `<db>.blobs` is still derivable for anything that has one.
    const file = defaultStoreDatabase(join("build", "hashigo.db"));
    expect(file.endsWith(join("build", "hashigo.db.blobs.db"))).toBe(true);
    expect(file).not.toContain("exports");
    // .gitignore's `*.db` covers it, which is what keeps 660 MB out of the repo.
    expect(file.endsWith(".db")).toBe(true);

    const root = defaultStoreRoot(join("build", "hashigo.db"));
    expect(root.endsWith(join("build", "hashigo.db.blobs"))).toBe(true);
    expect(root).not.toContain("exports");
  });
});

// ─── one contract, three implementations ─────────────────────────────────────

/**
 * THE POINT OF RUNNING THIS THREE TIMES. There are now two real backings —
 * `SqliteBlobStore`, which is what ships in Node and in the browser, and
 * `NodeBlobStore`, which is one file per payload and is kept for export and
 * interop — plus the in-memory one. A rule that only one of them happens to
 * satisfy is not a property of `BlobStore`, and the only way to notice that is to
 * assert every rule against every implementation. When the backing was swapped,
 * these are the tests that had to keep passing unchanged.
 */
const storeImplementations: readonly {
  readonly name: string;
  readonly make: (label: string) => BlobStore;
}[] = [
  {
    name: "SqliteBlobStore — BLOB rows, the production backing",
    make: (label) => scratchStore(label).store,
  },
  {
    name: "NodeBlobStore — one file per payload, export/interop",
    make: (label) => openBlobStore(join(scratchDir(label), "blobs")),
  },
  { name: "MemoryBlobStore", make: () => new MemoryBlobStore(contentAddress) },
];

describe.each(storeImplementations)("the blob store: $name", ({ make }) => {
  it("writes once and recognises the second write as already held", () => {
    const store = make("store-unit");
    const bytes = mp3("resumable");
    const hash = contentAddress(bytes);

    const first = store.write(hash, bytes);
    expect(first).toEqual({ hash, written: true, bytes: bytes.length });
    const second = store.write(hash, bytes);
    expect(second).toEqual({ hash, written: false, bytes: bytes.length });

    expect(store.has(hash)).toBe(true);
    expect(store.size(hash)).toBe(bytes.length);
    expect(Buffer.from(store.read(hash))).toEqual(Buffer.from(bytes));
    expect(store.verify(hash)).toBe(true);
    expect([...store.list()]).toEqual([hash]);
  });

  it("refuses to overwrite an address whose payload differs in length", () => {
    const store = make("store-conflict");
    const bytes = mp3("truth");
    const hash = contentAddress(bytes);
    store.write(hash, bytes);
    expect(() => store.write(hash, mp3("a much longer lie"))).toThrow(BlobConflictError);
    // …and the payload that was there is still there, unchanged.
    expect(Buffer.from(store.read(hash))).toEqual(Buffer.from(bytes));
  });

  it("throws for a payload it does not hold rather than returning nothing", () => {
    const store = make("store-missing");
    const hash = contentAddress(mp3("absent"));
    expect(store.has(hash)).toBe(false);
    expect(store.size(hash)).toBeNull();
    expect(() => store.read(hash)).toThrow(BlobMissingError);
    expect(store.verify(hash)).toBe(false);
    expect(store.remove(hash)).toBe(false);
  });

  it("removes a payload and reports whether there was one", () => {
    const store = make("store-remove");
    const bytes = mp3("transient");
    const hash = contentAddress(bytes);
    store.write(hash, bytes);
    expect(store.remove(hash)).toBe(true);
    expect(store.remove(hash)).toBe(false);
    expect(() => store.read(hash)).toThrow(BlobMissingError);
    expect([...store.list()]).toEqual([]);
  });

  it("rejects anything that is not a content address at every entry point", () => {
    const store = make("store-address");
    const B = String.fromCharCode(92);
    const location = `C:${B}exports${B}x.mp3`;
    for (const call of [
      () => store.has(location),
      () => store.size(location),
      () => store.read(location),
      () => store.write(location, mp3("x")),
      () => store.remove(location),
      () => store.verify(location),
    ]) {
      expect(call).toThrow(/not a content address/);
    }
  });

  it("holds every rule inside a batch, whether or not it has one", () => {
    // THE CALL-SITE RULE for the optional member: batch when it exists, run the
    // identical loop when it does not. src/import/blobs.ts and sweepUnreferenced
    // both do exactly this, so the same loop has to work either way.
    const store = make("store-batch");
    const payloads = [mp3("b1"), mp3("b2"), mp3("b3")];
    const run = (): number => {
      let written = 0;
      for (const bytes of payloads) {
        if (store.write(contentAddress(bytes), bytes).written) written += 1;
      }
      return written;
    };
    const written = store.batch === undefined ? run() : store.batch(run);
    expect(written).toBe(3);
    for (const bytes of payloads) {
      expect(Buffer.from(store.read(contentAddress(bytes)))).toEqual(Buffer.from(bytes));
    }
    // A throw inside a batch must not leave the store readable-but-wrong.
    const doomed = mp3("rolled back");
    expect(() => {
      const attempt = (): never => {
        store.write(contentAddress(doomed), doomed);
        throw new Error("interrupted");
      };
      if (store.batch === undefined) attempt();
      else store.batch(attempt);
    }).toThrow(/interrupted/);
    expect(store.verify(contentAddress(payloads[0] as Uint8Array))).toBe(true);
  });
});

describe("the directory store's own rules", () => {
  it("files a payload at its derived location and nowhere else", () => {
    const root = join(scratchDir("store-layout"), "blobs");
    const store = openBlobStore(root);
    const bytes = mp3("layout");
    const hash = store.write(contentAddress(bytes), bytes).hash;
    expect(existsSync(join(root, ...addressPath(hash).split("/")))).toBe(true);
    // The marker and the self-ignore are there; neither is mistaken for a blob.
    expect(existsSync(join(root, "STORE.json"))).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8").trim()).toBe("*");
    expect([...store.list()]).toEqual([hash]);
  });

  it("clears interrupted writes without touching finished ones", () => {
    const root = join(scratchDir("store-temp"), "blobs");
    const store = openBlobStore(root);
    const bytes = mp3("survivor");
    const hash = contentAddress(bytes);
    store.write(hash, bytes);
    writeFileSync(join(root, ".tmp", "half-written.part"), "truncated");
    expect(store.sweepTemp()).toBe(1);
    expect(store.has(hash)).toBe(true);
  });
});

describe("the SQLite store's own rules", () => {
  it("refuses to add itself to a database that already holds tables", () => {
    // The mistake this catches: `--store build/hashigo.db`. Scribbling a payload
    // table into the card database is not a thing that should be recoverable by
    // apology, so it is refused before a single byte is written.
    const file = join(scratchDir("store-wrong-db"), "cards.db");
    const cards = openDatabase(file);
    cards.close();
    expect(() => openBlobStoreDatabase(file)).toThrow(/Refusing to add a blob store/);
  });

  it("refuses a store database stamped with a version it cannot read", () => {
    const opened = scratchStore("store-version");
    opened.store.write(contentAddress(mp3("v")), mp3("v"));
    const file = opened.file;
    opened.close();
    const raw = openDatabase(file, { applySchema: false });
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => openBlobStoreDatabase(file)).toThrow(/user_version = 99/);
  });

  it("will not create a store where one is required to exist", () => {
    const file = join(scratchDir("store-mustexist"), "absent.blobs.db");
    expect(() => openBlobStoreDatabase(file, { mustExist: true })).toThrow(/no blob store/);
    expect(existsSync(file)).toBe(false);
  });

  it("stores the payload and nothing that could be a location", () => {
    const opened = scratchStore("store-columns");
    const bytes = mp3("no location here");
    opened.store.write(contentAddress(bytes), bytes);
    const raw = openDatabase(opened.file, { applySchema: false });
    try {
      // Three columns, and `hash` is CHECK-ed to 64 hex characters, so the only
      // column in the whole file that could hold a path is the payload itself.
      const columns = (
        raw.prepare("PRAGMA table_info('blob_payloads')").all() as { name: string }[]
      ).map((column) => column.name);
      expect(columns).toEqual(["hash", "byte_size", "bytes"]);
      const insert = raw.prepare(
        "INSERT INTO blob_payloads (hash, byte_size, bytes) VALUES (?, ?, ?)",
      );
      expect(() => insert.run("C:/exports/x.mp3", 1, Buffer.from("x"))).toThrow(
        /CHECK constraint failed/,
      );
      // …and byte_size cannot lie about the payload either.
      expect(() => insert.run("a".repeat(64), 999, Buffer.from("x"))).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      raw.close();
    }
  });

  it("creates itself with the page size and auto_vacuum it says it does", () => {
    const opened = scratchStore("store-pragmas");
    const stats = opened.store.stats();
    expect(stats.pageSize).toBe(STORE_PAGE_SIZE);
    // 2 = incremental. Chosen so a sweep can return pages without rewriting a
    // 660 MB file; see the option's comment in src/blobs/sqlite.ts.
    expect(stats.autoVacuum).toBe(2);
    expect(stats.journalMode).toBe("delete");
    expect(opened.store.checkIntegrity()).toEqual([]);
  });

  it("honours auto_vacuum: none when asked, and then cannot reclaim", () => {
    const file = join(scratchDir("store-novacuum"), "s.blobs.db");
    const opened = openBlobStoreDatabase(file, { autoVacuum: "none" });
    try {
      const bytes = Uint8Array.from({ length: 40_000 }, (_, i) => i & 0xff);
      const hash = contentAddress(bytes);
      opened.store.write(hash, bytes);
      expect(opened.store.stats().autoVacuum).toBe(0);
      opened.store.remove(hash);
      expect(opened.store.stats().freelistPages).toBeGreaterThan(0);
      // incremental_vacuum is a no-op without auto_vacuum, and reports as one.
      expect(opened.store.reclaim()).toBe(0);
      expect(opened.store.stats().freelistPages).toBeGreaterThan(0);
      // A full VACUUM still works, at the cost of rewriting the whole file.
      opened.store.vacuum();
      expect(opened.store.stats().freelistPages).toBe(0);
    } finally {
      opened.close();
    }
  });

  it("reuses free pages instead of growing, and gives them back on request", () => {
    const opened = scratchStore("store-freepages");
    const store = opened.store;
    const payload = (seed: number): Uint8Array =>
      Uint8Array.from({ length: 50_000 }, (_, i) => (i * 31 + seed) & 0xff);

    const first: string[] = [];
    store.batch(() => {
      for (let i = 0; i < 40; i += 1) {
        const bytes = payload(i);
        const hash = contentAddress(bytes);
        store.write(hash, bytes);
        first.push(hash);
      }
    });
    const grown = store.stats();
    expect(grown.payloads).toBe(40);

    // Delete half. The pages go on the freelist; the file does not shrink yet.
    store.batch(() => {
      for (const hash of first.slice(0, 20)) store.remove(hash);
    });
    const emptied = store.stats();
    expect(emptied.payloads).toBe(20);
    expect(emptied.freelistPages).toBeGreaterThan(0);
    expect(emptied.pageCount).toBe(grown.pageCount);

    // FREE-PAGE REUSE: 20 new payloads must come out of the freelist rather than
    // off the end of the file. This is the property that keeps a phone's blob
    // store from growing without bound as cards are edited and audio regenerated.
    store.batch(() => {
      for (let i = 100; i < 120; i += 1) {
        const bytes = payload(i);
        store.write(contentAddress(bytes), bytes);
      }
    });
    const reused = store.stats();
    expect(reused.payloads).toBe(40);
    // MEASURED, not assumed: 20 payloads of 50,000 B need ~123 pages of 8,192 B,
    // and the file grew by 1 page (a pointer-map page, which auto_vacuum needs).
    // So reuse is real and the residual growth is a constant, not a fraction of
    // the data. Asserting "did not grow at all" would be asserting that
    // auto_vacuum has no bookkeeping, which it does.
    const wouldHaveNeeded = Math.ceil((20 * 50_000) / grown.pageSize);
    const grewBy = reused.pageCount - grown.pageCount;
    console.log(
      `free-page reuse: 20 payloads (${wouldHaveNeeded} pages' worth) reused the ` +
        `freelist; the file grew by ${grewBy} page(s)`,
    );
    expect(grewBy).toBeLessThan(wouldHaveNeeded / 10);

    // And the freelist can be handed back without a full rewrite.
    store.batch(() => {
      for (const hash of first.slice(20)) store.remove(hash);
    });
    const before = store.stats();
    const returned = store.reclaim();
    const after = store.stats();
    expect(returned).toBeGreaterThan(0);
    expect(after.freelistPages).toBe(0);
    expect(after.pageCount).toBeLessThan(before.pageCount);
    expect(store.checkIntegrity()).toEqual([]);
  });

  it("commits a long batch in chunks, so an interrupted import keeps its work", () => {
    // The batch is deliberately NOT one transaction: it flushes every
    // BATCH_FLUSH_BYTES so a 625 MB first import loses at most that much. Proved
    // by throwing after the threshold is crossed and finding the early payloads
    // still there — and then resuming, which writes only what is missing.
    const opened = scratchStore("store-flush");
    const store = opened.store;
    const chunk = 4 << 20;
    // One base buffer, copied and stamped. `Uint8Array.from({length}, fn)` over
    // 68 MB is seconds of JS on its own and would be measuring the test.
    const base = new Uint8Array(chunk);
    for (let i = 0; i < chunk; i += 1) base[i] = i & 0xff;
    const payload = (seed: number): Uint8Array => {
      const bytes = base.slice();
      new DataView(bytes.buffer).setUint32(0, seed >>> 0);
      return bytes;
    };
    const needed = Math.ceil(BATCH_FLUSH_BYTES / chunk) + 2;

    expect(() =>
      store.batch(() => {
        for (let i = 0; i < needed; i += 1) {
          const bytes = payload(i);
          store.write(contentAddress(bytes), bytes);
        }
        throw new Error("power cut");
      }),
    ).toThrow(/power cut/);

    expect(store.batchFlushes).toBeGreaterThanOrEqual(1);
    const survived = [...store.list()].length;
    // Everything up to the last flush survived; the tail rolled back. Neither
    // number is 0 and neither is `needed` — that is the whole claim.
    expect(survived).toBeGreaterThan(0);
    expect(survived).toBeLessThan(needed);
    // Whatever survived is intact, not truncated: content addressing says so.
    for (const hash of store.list()) expect(store.verify(hash)).toBe(true);

    let rewritten = 0;
    store.batch(() => {
      for (let i = 0; i < needed; i += 1) {
        const bytes = payload(i);
        if (store.write(contentAddress(bytes), bytes).written) rewritten += 1;
      }
    });
    expect(rewritten).toBe(needed - survived);
    expect([...store.list()].length).toBe(needed);
  }, 120_000);

  it("is the same class over any handle: no Node in it, so the browser runs it", () => {
    // openSqliteBlobStore takes a handle satisfying the SqliteHandle contract in
    // src/db/browser.ts. In the browser that handle comes from
    // openDatabaseBrowser() over opfs-sahpool; here it is better-sqlite3 over a
    // file. The store code cannot tell, which is the entire reason there is one
    // implementation instead of two.
    const raw = openDatabase(join(scratchDir("store-handle"), "any.db"), { applySchema: false });
    try {
      const store = openSqliteBlobStore(raw);
      const bytes = mp3("one class");
      const hash = contentAddress(bytes);
      expect(store.write(hash, bytes).written).toBe(true);
      expect(store.verify(hash)).toBe(true);
      expect(store.describe.startsWith("sqlite:")).toBe(true);
      // The default digest is the pure-TS one — the browser has no node:crypto —
      // and it agrees with OpenSSL on the same bytes.
      expect(sha256Hex(bytes)).toBe(hash);
    } finally {
      raw.close();
    }
  });
});

describe("sha256, synchronously and without a platform", () => {
  it("matches the FIPS vectors and the empty string", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // The empty digest is load-bearing: the corpus's 10 zero-byte mp3s all live
    // at that address, which is how they collapse into one blob at refcount 10.
    expect(contentAddress(new Uint8Array(0))).toBe(sha256Hex(new Uint8Array(0)));
  });

  it("agrees with node:crypto at every length across a block boundary", () => {
    // 0..200 covers the empty case, the one-block case, the length-56 padding
    // boundary that needs an extra block, and several whole blocks.
    for (let n = 0; n <= 200; n += 1) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    for (const n of [255, 256, 257, 511, 512, 513, 4096, 65_535]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 131) & 0xff);
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("gives the same answer fed in arbitrary chunks as fed whole", () => {
    const whole = Uint8Array.from({ length: 5_000 }, (_, i) => (i * 7) & 0xff);
    const streamed = new Sha256();
    for (let at = 0; at < whole.length; at += 37) {
      streamed.update(whole.subarray(at, Math.min(at + 37, whole.length)));
    }
    expect(streamed.hex()).toBe(sha256Hex(whole));
  });

  it("refuses to be reused, because a reused digest is a wrong address", () => {
    const digest = new Sha256();
    digest.update(Uint8Array.from([1, 2, 3]));
    expect(digest.hex()).toHaveLength(64);
    expect(() => digest.hex()).toThrow(/twice/);
    expect(() => digest.update(Uint8Array.from([4]))).toThrow(/after hex/);
  });
});

describe("moving the store", () => {
  it("keeps every reference working, because no row ever said where the bytes were", () => {
    const db = fresh(["card-move"]);
    const first = join(scratchDir("store-before"), "blobs");
    const store = openBlobStore(first);
    const bytes = mp3("relocatable");
    const hash = contentAddress(bytes);
    store.write(hash, bytes);
    db.prepare(
      "INSERT INTO blobs (hash, kind, mime, byte_size) VALUES (?, 'speech', 'audio/mpeg', ?)",
    ).run(hash, bytes.length);
    addBlobRef(db, { blobHash: hash, cardId: "card-move", refKey: "x.mp3" });

    expect(Buffer.from(readBlob(db, hash, store))).toEqual(Buffer.from(bytes));

    // Move it. This is the operation the old design could not survive.
    const second = join(scratchDir("store-after"), "moved-somewhere-else");
    renameSync(first, second);
    expect(existsSync(first)).toBe(false);

    const relocated = openBlobStore(second, { create: false });
    expect(Buffer.from(readBlob(db, hash, relocated))).toEqual(Buffer.from(bytes));
    // Nothing was migrated, updated or rewritten in the database.
    expect(db.prepare("SELECT path FROM blobs WHERE hash = ?").pluck().get(hash)).toBeNull();
  });
});

describe("refcounts, not tombstones", () => {
  it("reclaims a payload only after the last reference drops", () => {
    const db = fresh(["c1", "c2"]);
    const store = openBlobStore(join(scratchDir("store-sweep"), "blobs"));
    const bytes = mp3("shared");
    const hash = contentAddress(bytes);
    store.write(hash, bytes);
    db.prepare(
      "INSERT INTO blobs (hash, kind, mime, byte_size) VALUES (?, 'speech', 'audio/mpeg', ?)",
    ).run(hash, bytes.length);
    addBlobRef(db, { blobHash: hash, cardId: "c1", refKey: "a.mp3" });
    addBlobRef(db, { blobHash: hash, cardId: "c2", refKey: "a.mp3" });
    expect(db.prepare("SELECT refcount FROM blobs WHERE hash = ?").pluck().get(hash)).toBe(2);

    // One card goes: still referenced, so the payload stays.
    db.prepare("DELETE FROM cards WHERE id = 'c1'").run();
    expect(sweepUnreferenced(db, store, { graceDays: 0 })).toEqual({
      rowsDeleted: 0,
      payloadsRemoved: 0,
      bytesReclaimed: 0,
      heldByGrace: 0,
      bytesHeldByGrace: 0,
    });
    expect(store.has(hash)).toBe(true);

    db.prepare("DELETE FROM cards WHERE id = 'c2'").run();
    const dry = sweepUnreferenced(db, store, { dryRun: true, graceDays: 0 });
    expect(dry.rowsDeleted).toBe(0);
    expect(dry.bytesReclaimed).toBe(bytes.length);

    const swept = sweepUnreferenced(db, store, { graceDays: 0 });
    expect(swept).toEqual({
      rowsDeleted: 1,
      payloadsRemoved: 1,
      bytesReclaimed: bytes.length,
      heldByGrace: 0,
      bytesHeldByGrace: 0,
    });
    expect(store.has(hash)).toBe(false);
    expect(db.prepare("SELECT count(*) FROM blobs").pluck().get()).toBe(0);
  });

  it("HOLDS an unreferenced payload for the grace period, so a voice A/B is free", () => {
    // The gap this closes: with an immediate sweep, generating two voices and
    // pointing the card at one destroyed the loser's payload the instant the
    // winner was chosen, so changing your mind cost another billed request. That
    // is Mochi's attachment behaviour rebuilt by accident.
    const db = fresh(["c1"]);
    const store = openBlobStore(join(scratchDir("store-grace"), "blobs"));
    const bytes = mp3("the losing voice");
    const hash = contentAddress(bytes);
    store.write(hash, bytes);
    db.prepare(
      "INSERT INTO blobs (hash, kind, mime, byte_size) VALUES (?, 'speech', 'audio/mpeg', ?)",
    ).run(hash, bytes.length);
    addBlobRef(db, { blobHash: hash, cardId: "c1", refKey: "a.mp3" });
    removeBlobRef(db, { cardId: "c1", refKey: "a.mp3" });

    // Trigger-maintained, in the same statement as refcount so they cannot drift.
    const row = db
      .prepare("SELECT refcount, unreferenced_at FROM blobs WHERE hash = ?")
      .get(hash) as { refcount: number; unreferenced_at: string | null };
    expect(row.refcount).toBe(0);
    expect(row.unreferenced_at).not.toBeNull();

    const held = sweepUnreferenced(db, store, {});
    expect(held.rowsDeleted).toBe(0);
    expect(held.heldByGrace).toBe(1);
    expect(held.bytesHeldByGrace).toBe(bytes.length);
    expect(store.has(hash)).toBe(true);

    // Past the grace period it goes. `now` rather than a real clock so the test
    // asserts the boundary instead of waiting a week for it.
    const later = new Date(Date.now() + 8 * 86_400_000).toISOString();
    const gone = sweepUnreferenced(db, store, { now: later });
    expect(gone.rowsDeleted).toBe(1);
    expect(gone.heldByGrace).toBe(0);
    expect(store.has(hash)).toBe(false);
  });

  it("retargets a reference instead of deleting and re-adding it", () => {
    // The `blob_refs_au` trigger has existed since stage 1 and nothing called
    // it, which is exactly "I cannot delete the audio I do not want".
    const db = fresh(["c1"]);
    const nanami = mp3("nanami");
    const neural2 = mp3("neural2-c");
    const from = contentAddress(nanami);
    const to = contentAddress(neural2);
    for (const [hash, bytes] of [
      [from, nanami],
      [to, neural2],
    ] as const) {
      db.prepare(
        "INSERT INTO blobs (hash, kind, mime, byte_size) VALUES (?, 'speech', 'audio/mpeg', ?)",
      ).run(hash, bytes.length);
    }
    addBlobRef(db, { blobHash: from, cardId: "c1", fieldId: "spk", refKey: "k" });

    expect(retargetBlobRef(db, { cardId: "c1", fieldId: "spk", refKey: "k" }, to)).toBe(true);
    const counts = db.prepare("SELECT hash, refcount, unreferenced_at FROM blobs").all() as {
      hash: string;
      refcount: number;
      unreferenced_at: string | null;
    }[];
    const old = counts.find((r) => r.hash === from);
    const now = counts.find((r) => r.hash === to);
    expect(old?.refcount).toBe(0);
    // Stamped, so the old clip is a sweep candidate only after the grace period.
    expect(old?.unreferenced_at).not.toBeNull();
    expect(now?.refcount).toBe(1);
    // And gaining a reference CLEARS the stamp: it must not look like a candidate.
    expect(now?.unreferenced_at).toBeNull();

    // Nothing to retarget reports false rather than inventing a row.
    expect(retargetBlobRef(db, { cardId: "c1", fieldId: "spk", refKey: "nope" }, to)).toBe(false);
  });

  /**
   * `refcount = 0` WITH `unreferenced_at` NULL IS IMMEDIATELY ELIGIBLE, AND THAT
   * IS DELIBERATE. Pinned because it looks like an oversight and is not.
   *
   * The triggers stamp `unreferenced_at` only on a 1 -> 0 refcount transition, so
   * a row that started at 0 keeps NULL, and the eligibility test requires a
   * non-NULL stamp to hold anything back. On the real store 48 rows are in that
   * state, and they are permanently unreferenced rather than mid-write -- see the
   * corpus test below and the note in `src/blobs/db.ts`.
   *
   * A session tried making eligibility fall back to `created_at` on the theory
   * that a just-inserted row might be mid-write. It is not: rows and refs are
   * written in one transaction. The change held genuine debris for a week and
   * turned the corpus assertion red. This test exists so the next reader sees the
   * property is chosen, not accidental.
   */
  it("treats a blob that was NEVER referenced as immediately reclaimable", () => {
    const db = fresh(["c1"]);
    const store = openBlobStore(join(scratchDir("store-never-ref"), "blobs"));
    const bytes = mp3("nothing ever pointed at this");
    store.write(sha256Hex(bytes), bytes);
    db.prepare(
      "INSERT INTO blobs (hash, kind, mime, byte_size) VALUES (?, 'speech', 'audio/mpeg', ?)",
    ).run(sha256Hex(bytes), bytes.length);

    const row = db
      .prepare("SELECT refcount, unreferenced_at FROM blobs WHERE hash = ?")
      .get(sha256Hex(bytes)) as { refcount: number; unreferenced_at: string | null };
    expect(row).toEqual({ refcount: 0, unreferenced_at: null });

    // Swept even with a long grace period, BECAUSE the stamp is absent. Contrast
    // the test above, where a blob that LOST its last reference is held.
    const swept = sweepUnreferenced(db, store, { graceDays: 3_650 });
    expect(swept.heldByGrace).toBe(0);
    expect(swept.rowsDeleted).toBe(1);
  });

  it("audits both sides, and says which missing payloads can regenerate themselves", () => {
    const db = fresh(["c1"]);
    const store = openBlobStore(join(scratchDir("store-audit"), "blobs"));
    const provenanced = mp3("regenerable");
    const anonymous = mp3("lost");
    const orphan = mp3("nobody asked for this");

    for (const [bytes, identity] of [
      [provenanced, { sourceText: "だけに", voice: "ja-JP-NanamiNeural", lang: "ja-JP", options: "{}" }],
      [anonymous, undefined],
    ] as const) {
      const hash = contentAddress(bytes);
      store.write(hash, bytes);
      db.prepare(
        `INSERT INTO blobs (hash, kind, mime, byte_size, source_text, voice, lang)
         VALUES (?, 'speech', 'audio/mpeg', ?, ?, ?, ?)`,
      ).run(hash, bytes.length, identity?.sourceText ?? null, identity?.voice ?? null, identity?.lang ?? null);
      addBlobRef(db, { blobHash: hash, cardId: "c1", refKey: `${hash.slice(0, 4)}.mp3` });
    }
    store.write(contentAddress(orphan), orphan);

    const clean = auditBlobStore(db, store);
    expect(clean.blobs).toBe(2);
    expect(clean.present).toBe(2);
    expect(clean.missing).toBe(0);
    expect(clean.orphaned).toBe(1);

    // Now break the store the way Mochi broke: a payload simply disappears.
    store.remove(contentAddress(provenanced));
    store.remove(contentAddress(anonymous));
    const broken = auditBlobStore(db, store);
    expect(broken.missing).toBe(2);
    expect(broken.missingRegenerable).toBe(1);
    expect(broken.missingLost).toBe(1);
    // Detectable, and one of the two can be rebuilt without asking the user.
    expect(broken.missingHashes).toHaveLength(2);
  });
});

describe("importBlobs and where the payloads go", () => {
  it("defaults to the content-addressed store and writes no location", () => {
    const db = fresh(["a"]);
    const store = openBlobStore(join(scratchDir("store-import"), "blobs"));
    const files = { "one.mp3": mp3("one"), "two.mp3": mp3("two") };
    const report = importBlobs(
      db,
      [
        {
          mediaDir: "C:\\DEV\\WEB\\hashigo\\exports\\日本語",
          cards: [{ id: "a", attachments: { "one.mp3": { type: "text/xml" }, "two.mp3": {} } }],
        },
      ],
      { blobStore: store, readMedia: memoryMedia(files) },
    );

    expect(report.payloadStore).toBe("content-addressed");
    expect(report.storeFilesWritten).toBe(2);
    expect(report.storeFilesPresent).toBe(0);
    expect(report.storeWarnings).toEqual([]);
    // The mediaDir was an absolute Windows path into exports/. None of it stuck.
    expect(db.prepare("SELECT count(*) FROM blobs WHERE path IS NOT NULL").pluck().get()).toBe(0);
    for (const bytes of Object.values(files)) {
      expect(Buffer.from(readBlob(db, contentAddress(bytes), store))).toEqual(Buffer.from(bytes));
    }
  });

  it("re-running copies nothing: the store already holds every address", () => {
    const store = openBlobStore(join(scratchDir("store-resume"), "blobs"));
    const files = { "one.mp3": mp3("one"), "two.mp3": mp3("two"), "dupe.mp3": mp3("one") };
    const sources: MochiMediaSource[] = [
      {
        mediaDir: "media",
        cards: [
          { id: "a", attachments: { "one.mp3": {}, "two.mp3": {}, "dupe.mp3": {} } },
        ],
      },
    ];

    const first = importBlobs(fresh(["a"]), sources, {
      blobStore: store,
      readMedia: memoryMedia(files),
    });
    // 3 files, 2 addresses: the duplicate is recognised, not copied twice.
    expect(first.storeFilesWritten).toBe(2);
    expect(first.storeFilesPresent).toBe(1);

    const second = importBlobs(fresh(["a"]), sources, {
      blobStore: store,
      readMedia: memoryMedia(files),
    });
    expect(second.storeFilesWritten).toBe(0);
    expect(second.storeBytesWritten).toBe(0);
    expect(second.storeFilesPresent).toBe(3);
  });

  it("degrades to address-only for an in-memory database, and says so", () => {
    const db = fresh(["a"]);
    const report = importBlobs(
      db,
      [{ mediaDir: "media", cards: [{ id: "a", attachments: { "one.mp3": {} } }] }],
      { readMedia: memoryMedia({ "one.mp3": mp3("one") }) },
    );
    expect(report.payloadStore).toBe("address-only");
    expect(report.storeRoot).toBeNull();
    expect(report.storeWarnings.join(" ")).toMatch(/nowhere durable/);
    // The row is still right: address, size, type, provenance. Just no bytes.
    const row = db.prepare("SELECT hash, byte_size, path, bytes FROM blobs").get() as {
      hash: string;
      byte_size: number;
      path: string | null;
      bytes: Buffer | null;
    };
    expect(row.hash).toBe(contentAddress(mp3("one")));
    expect(row.path).toBeNull();
    expect(row.bytes).toBeNull();
  });

  it("puts the store beside the database when nothing says otherwise", () => {
    const dir = scratchDir("store-derived");
    const file = join(dir, "hashigo.db");
    const db = openDatabase(file);
    seedCards(db, ["a"]);
    const bytes = mp3("derived");
    const report = importBlobs(
      db,
      [{ mediaDir: "media", cards: [{ id: "a", attachments: { "one.mp3": {} } }] }],
      { readMedia: memoryMedia({ "one.mp3": bytes }) },
    );
    db.close();

    // A SQLITE DATABASE beside the card database, not a directory of 10,826
    // files: `notes/archive/browser-feasibility.md` §4. The importer opened it, so the
    // importer closed it — hence this test can reopen it and read the payload.
    expect(report.payloadStore).toBe("content-addressed");
    expect(report.storeRoot).toBe(`sqlite:${defaultStoreDatabase(file)}`);
    expect(existsSync(defaultStoreDatabase(file))).toBe(true);
    expect(existsSync(defaultStoreRoot(file))).toBe(false);

    const reopened = openBlobStoreDatabase(defaultStoreDatabase(file), { mustExist: true });
    try {
      expect(reopened.store.size(contentAddress(bytes))).toBe(bytes.length);
      expect(Buffer.from(reopened.store.read(contentAddress(bytes)))).toEqual(Buffer.from(bytes));
    } finally {
      reopened.close();
    }
  });

  it("opens the legacy directory store when a directory is named, and says so", () => {
    const db = fresh(["a"]);
    const root = join(scratchDir("store-legacy-dir"), "blobs");
    const bytes = mp3("legacy");
    const report = importBlobs(
      db,
      [{ mediaDir: "media", cards: [{ id: "a", attachments: { "one.mp3": {} } }] }],
      { storeRoot: root, readMedia: memoryMedia({ "one.mp3": bytes }) },
    );
    expect(report.payloadStore).toBe("content-addressed");
    expect(report.storeWarnings.join(" ")).toMatch(/legacy one-file-per-payload/);
    // It really is a directory of files, at the derived location.
    const filed = join(root, ...addressPath(contentAddress(bytes)).split("/"));
    expect(statSync(filed).size).toBe(bytes.length);
  });

  it('accepts the retired store: "path" and refuses to write one', () => {
    const db = fresh(["a"]);
    const store = openBlobStore(join(scratchDir("store-legacy"), "blobs"));
    const report = importBlobs(
      db,
      [{ mediaDir: "C:\\DEV\\WEB\\hashigo\\exports\\日本語", cards: [{ id: "a", attachments: { "one.mp3": {} } }] }],
      { store: "path", blobStore: store, readMedia: memoryMedia({ "one.mp3": mp3("one") }) },
    );
    expect(report.payloadStore).toBe("content-addressed");
    expect(report.storeWarnings.join(" ")).toMatch(/is gone/);
    expect(db.prepare("SELECT count(*) FROM blobs WHERE path IS NOT NULL").pluck().get()).toBe(0);
  });
});

// ─── the real export ─────────────────────────────────────────────────────────

const EXPORTS = join(import.meta.dirname, "..", "exports");
const DECKS = ["日本語", "English", "基本情報"];
const haveCorpus = DECKS.every((deck) => existsSync(join(EXPORTS, deck, "data.json")));

/**
 * Transit decode, mirroring tools/mochi.py. A STOPGAP: src/import owns the real
 * reader, which does not exist yet, and blobs.ts deliberately takes already
 * decoded cards so it never duplicates a decoder.
 *
 * One deliberate difference from mochi.py, which its docstring does not cover:
 * map KEYS also carry the `~~` escape for a literal leading `~`, and mochi.py
 * only unescapes it on values. Card 4nKAg2kH's neighbour ～に越したことはない
 * stores its cache keys as "~~に越したことはない {…}"; leaving that alone imports a
 * doubled tilde as the cached source text, and the input would then never hit.
 */
function untransit(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(untransit);
  if (typeof node === "object" && node !== null) {
    const entries = Object.entries(node as Record<string, unknown>);
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only !== undefined) {
      const [key, value] = only;
      if (key === "~#list" || key === "~#set") return (value as unknown[]).map(untransit);
      if (key === "~#dt") return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) out[decodeKey(key)] = untransit(value);
    return out;
  }
  if (typeof node === "string") {
    if (node.startsWith("~:")) return node.slice(2);
    if (node.startsWith("~t")) return node.slice(2);
    if (node.startsWith("~~")) return node.slice(1);
  }
  return node;
}

function decodeKey(key: string): string {
  if (key.startsWith("~:")) return key.slice(2);
  if (key.startsWith("~~")) return key.slice(1);
  return key;
}

/** Every card exactly once. A naive recursive walk returns each one twice. */
function walkCards(root: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const take = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const card of value) {
      if (typeof card !== "object" || card === null || seen.has(card)) continue;
      seen.add(card);
      out.push(card as Record<string, unknown>);
    }
  };
  const visit = (node: Record<string, unknown>): void => {
    const decks = node["decks"];
    if (Array.isArray(decks)) {
      for (const deck of decks) {
        if (typeof deck !== "object" || deck === null) continue;
        take((deck as Record<string, unknown>)["cards"]);
        visit(deck as Record<string, unknown>);
      }
    }
    take(node["cards"]);
  };
  visit(root);
  return out;
}

describe.skipIf(!existsSync(join("build", "hashigo.db")))(
  "the generation key after the move to src/blobs/generation.ts",
  () => {
    it("is BYTE-IDENTICAL to the node:crypto digest it replaced, over the whole corpus", async () => {
      // THE ASSERTION THE MOVE RESTS ON. `generationKey` used to hash through
      // `createHash("sha256").update(string)`; it now hashes
      // `new TextEncoder().encode(string)` through the portable `sha256Hex`,
      // which is what let `src/generate` become browser-loadable without any
      // signature changing.
      //
      // A one-bit difference here raises NO error anywhere. It turns every
      // cached generation into a permanent miss and re-bills the corpus — 617.9
      // MiB of speech, generated once. So this recomputes both digests over
      // every distinct identity the real database holds and demands they agree.
      // ASCII agreeing proves nothing: the inputs are Japanese head words, and
      // the two paths differ precisely in how a string becomes bytes.
      const { createHash } = await import("node:crypto");
      const db = openDatabase(join("build", "hashigo.db"), {
        readOnly: true,
        applySchema: false,
      });
      try {
        const rows = db
          .prepare(
            `SELECT DISTINCT kind, source_text, voice, lang, options FROM blobs
              WHERE source_text IS NOT NULL`,
          )
          .all() as {
          kind: string;
          source_text: string;
          voice: string | null;
          lang: string | null;
          options: string;
        }[];

        let checked = 0;
        let nonAscii = 0;
        const differing: string[] = [];
        for (const row of rows) {
          const identity = {
            kind: row.kind as Parameters<typeof generationKey>[0]["kind"],
            sourceText: row.source_text,
            voice: row.voice,
            lang: row.lang,
            options: row.options,
          };
          const joined = [
            // The LITERAL, not the imported constant. Using
            // `GENERATION_KEY_SCHEME` here made this test compare the new
            // implementation against itself: changing the constant moved both
            // sides and the test stayed green. Caught by injecting exactly that
            // fault. The scheme is versioned so it CAN be changed — but then
            // this literal is what forces the change to be deliberate.
            "hashigo/blob-identity/1",
            identity.kind,
            identity.sourceText,
            identity.voice ?? "",
            identity.lang ?? "",
            identity.options,
          // `\u0000` rather than a raw NUL byte: identical at runtime, and it keeps
          // this file TEXT. Two raw control bytes used to sit here and on the regex
          // below, which is enough for tooling to treat an 89.9 KB test file as
          // binary and stop showing its matches -- and `git diff` is this repo's
          // stated review control. Do not put the raw bytes back.
          ].join("\u0000");
          const legacy = createHash("sha256").update(joined).digest("hex");
          const current = generationKey(identity);
          if (legacy !== current) differing.push(`${row.kind}/${row.source_text}`);
          // eslint-disable-next-line no-control-regex
          if (/[^\u0000-\u007f]/.test(joined)) nonAscii += 1;
          checked += 1;
        }

        // Three real keys, pinned as literals. The sweep above proves the two
        // implementations agree with EACH OTHER; these prove the answer is the
        // one the 42,569 existing cache rows were filed under. A change to the
        // separator, the field order, the scheme or the encoding moves them.
        expect(
          generationKey({
            kind: "speech",
            sourceText: "...にも程がある",
            voice: "ja-JP-NanamiNeural",
            lang: "ja-JP",
            options: "{}",
          }),
        ).toBe("311fe0e387af929523ddd37d1ae37b0b3b2073fedbb1812132ff3c98c55b4f0f");
        expect(
          generationKey({
            kind: "speech",
            sourceText: "...は...に限る",
            voice: "ja-JP-NanamiNeural",
            lang: "ja-JP",
            options: "{}",
          }),
        ).toBe("5c89f47bd2fab7dbcb0b67cca2aadf5e01defbfdf945334f4310a7e659b92b26");
        expect(
          generationKey({
            kind: "speech",
            sourceText: "124,652,706",
            voice: null,
            lang: "ja-JP",
            options: '{"gender":"female"}',
          }),
        ).toBe("9aa722e3b08f3e708ab9787652ae950e48802aded4af7abe233976df8a86c2c0");

        // eslint-disable-next-line no-console
        console.log(
          `generation key: ${checked} distinct identities, ${nonAscii} with non-ASCII text, ` +
            `${differing.length} differing`,
        );
        expect(differing.slice(0, 5)).toEqual([]);
        // The constant is still exported and still versioned; asserting it here
        // is what ties the literal above to it, so changing one without the
        // other fails rather than silently diverging.
        expect(GENERATION_KEY_SCHEME).toBe("hashigo/blob-identity/1");
        // The corpus has to actually contain the hard case, or agreeing is cheap.
        expect(nonAscii).toBeGreaterThan(1_000);
        expect(checked).toBeGreaterThan(30_000);
      } finally {
        db.close();
      }
    }, 120_000);
  },
);

describe.skipIf(!haveCorpus)("the real export", () => {
  const sources: MochiMediaSource[] = DECKS.map((deck) => {
    const mediaDir = join(EXPORTS, deck);
    const root = untransit(
      JSON.parse(readFileSync(join(mediaDir, "data.json"), "utf8")),
    ) as Record<string, unknown>;
    return { mediaDir, cards: walkCards(root) };
  });

  const cardIds = sources.flatMap((source) =>
    source.cards.map((card) => card.id).filter((id): id is string => typeof id === "string"),
  );

  // A REAL store, at real scale: 654,917,364 bytes of mp3 into a real SQLite
  // database, as 10,826 BLOB rows. A throwaway file, so the run is honest about
  // first-write cost, and it is renamed later to prove the database never
  // depended on where it was.
  const opened = scratchStore("store");
  const store = opened.store;

  const db = openDatabase(MEMORY);
  seedCards(db, cardIds);
  const started = Date.now();
  const report = importBlobs(db, sources, { blobStore: store });
  const elapsed = Date.now() - started;

  it(
    "imports 10,890 live blobs and 0 tombstones",
    () => {
      console.log(
        `cards ${cardIds.length}  imported in ${(elapsed / 1000).toFixed(1)}s  ` +
          `${(report.bytesHashed / 1024 / 1024).toFixed(0)} MB hashed`,
      );
      console.log(report);

      // THE PASS CONDITION.
      expect(report.liveAttachments).toBe(10_890);
      expect(report.mediaRefs).toBe(10_890);
      expect(report.tombstonesSkipped).toBe(8_983);
      expect(report.filesMissing).toBe(0);

      // Not one tombstoned filename reached the store. Collected independently
      // of the importer, straight from the decoded records.
      const tombstoned = new Set<string>();
      const liveNames = new Set<string>();
      for (const source of sources) {
        for (const card of source.cards) {
          const attachments = card["attachments"];
          if (typeof attachments !== "object" || attachments === null) continue;
          for (const [name, record] of Object.entries(attachments as Record<string, unknown>)) {
            if (typeof record !== "object" || record === null) continue;
            if ((record as Record<string, unknown>)["deleted?"] === true) tombstoned.add(name);
            else liveNames.add(name);
          }
        }
      }
      expect(tombstoned.size).toBe(8_983);
      const imported = new Set(
        db
          .prepare(
            `SELECT ref_key FROM blob_refs r JOIN blobs b ON b.hash = r.blob_hash
              WHERE b.kind IN ('speech', 'image', 'file')`,
          )
          .pluck()
          .all() as string[],
      );
      expect(imported.size).toBe(10_890);
      expect([...imported].filter((name) => !liveNames.has(name))).toEqual([]);
      expect([...tombstoned].filter((name) => imported.has(name))).toEqual([]);
    },
    600_000,
  );

  it("collapses 10,890 files onto 10,826 addresses, and the sum of refs is exact", () => {
    const media = db
      .prepare(
        `SELECT count(*) AS blobs, sum(refcount) AS refs, sum(byte_size) AS bytes
           FROM blobs WHERE kind IN ('speech', 'image', 'file')`,
      )
      .get() as { blobs: number; refs: number; bytes: number };
    console.log("media blobs", media, "deduped", report.dedupedFiles);
    expect(media.blobs).toBe(10_826);
    expect(media.refs).toBe(10_890);
    expect(report.dedupedFiles).toBe(64);
    expect(report.emptyFiles).toBe(3);
    // The 3 failed generations share sha256("") — one blob, three references.
    expect(
      db.prepare("SELECT refcount FROM blobs WHERE byte_size = 0").pluck().get(),
    ).toBe(3);
    expect(checkIntegrity(db)).toEqual([]);
  });

  it("writes 657 MB into the store as BLOB rows, and reports what that cost", () => {
    const stats = store.stats();
    console.log(
      `store ${report.payloadStore} at ${report.storeRoot}\n` +
        `  wrote ${report.storeFilesWritten} payloads / ` +
        `${(report.storeBytesWritten / 1024 / 1024).toFixed(1)} MiB in ` +
        `${report.storeSeconds.toFixed(1)}s = ${report.storeMbPerSecond} MiB/s ` +
        `(${report.storeFilesPresent} already present) ` +
        `— includes reading exports/ and hashing every byte\n` +
        `  file ${(stats.fileBytes / 1024 / 1024).toFixed(1)} MiB over ` +
        `${stats.pageCount} pages of ${stats.pageSize}; overhead ` +
        `${(((stats.fileBytes - stats.bytes) / stats.bytes) * 100).toFixed(2)}%; ` +
        `free pages ${stats.freelistPages}; auto_vacuum ${stats.autoVacuum}; ` +
        `journal ${stats.journalMode}`,
    );
    expect(report.payloadStore).toBe("content-addressed");
    expect(report.storeWarnings).toEqual([]);
    // 10,890 live files collapse to 10,826 addresses; the 64 duplicates are
    // recognised as already-present rather than written twice.
    expect(report.storeFilesWritten).toBe(10_826);
    expect(report.storeFilesPresent).toBe(64);
    expect(report.storeFilesWritten + report.storeFilesPresent).toBe(10_890);
    expect(report.storeBytesWritten).toBeGreaterThan(600 * 1024 * 1024);

    // The store agrees with the database about what it is holding, and the file
    // is a modest constant over the payloads rather than a multiple of them.
    expect(stats.payloads).toBe(10_826);
    expect(stats.bytes).toBe(report.storeBytesWritten);
    expect(stats.pageSize).toBe(STORE_PAGE_SIZE);
    // 2.85% measured, of which the pointer-map pages auto_vacuum needs are the
    // bulk; see the report for the `none` comparison. The claim being asserted is
    // "a small constant factor", not a specific number of pages.
    expect(stats.fileBytes).toBeLessThan(stats.bytes * 1.05);
    expect(store.checkIntegrity()).toEqual([]);
  });

  it(
    "inserts the whole corpus into a fresh store at a measured rate",
    () => {
      // THE COMPARABLE NUMBER. notes/archive/browser-feasibility.md §4 measured 4.9 s to
      // insert 624.6 MiB as BLOB rows in a browser, against 322.1 s for the same
      // bytes as 10,826 OPFS files. That figure is INSERT ONLY, so this one has
      // to be too: the reads out of the populated store are timed separately and
      // subtracted, leaving write() plus the batch's commits.
      const hashes = [...store.list()];
      expect(hashes).toHaveLength(10_826);

      const target = openBlobStoreDatabase(join(scratchDir("store-insert"), "fresh.blobs.db"));
      try {
        let readNs = 0n;
        let bytes = 0;
        const wall = process.hrtime.bigint();
        target.store.batch(() => {
          for (const hash of hashes) {
            const started = process.hrtime.bigint();
            const payload = store.read(hash);
            readNs += process.hrtime.bigint() - started;
            bytes += payload.length;
            target.store.write(hash, payload);
          }
        });
        const totalNs = process.hrtime.bigint() - wall;
        const insertSeconds = Number(totalNs - readNs) / 1e9;
        const readSeconds = Number(readNs) / 1e9;
        const mib = bytes / 1024 / 1024;
        console.log(
          `NODE INSERT: ${hashes.length} BLOBs / ${mib.toFixed(1)} MiB in ` +
            `${insertSeconds.toFixed(1)}s = ${(mib / insertSeconds).toFixed(0)} MiB/s, ` +
            `${((insertSeconds * 1000) / hashes.length).toFixed(2)} ms/blob ` +
            `(${target.store.batchFlushes} intermediate commits; ` +
            `sequential reads out of the source store cost ${readSeconds.toFixed(1)}s, excluded)`,
        );
        expect(target.store.stats().payloads).toBe(10_826);
        expect(target.store.stats().bytes).toBe(report.storeBytesWritten);
      } finally {
        target.close();
        // 660 MB of throwaway: released now rather than at the end of the run.
        rmSync(dirname(target.file), { recursive: true, force: true });
      }
    },
    600_000,
  );

  it("answers a random read in a fraction of a millisecond", () => {
    // The other half of §4's measurement: 0.54 ms per random BLOB read in the
    // browser against 10.60 ms per random OPFS file. This is the Node number for
    // the same store class, and it is what the renderer's audio path will pay.
    const hashes = [...store.list()];
    let seed = 20260819;
    const picks: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      picks.push(hashes[seed % hashes.length] as string);
    }
    let ns = 0n;
    let bytes = 0;
    for (const hash of picks) {
      const started = process.hrtime.bigint();
      const payload = store.read(hash);
      ns += process.hrtime.bigint() - started;
      bytes += payload.length;
    }
    const ms = Number(ns) / 1e6 / picks.length;
    console.log(
      `NODE RANDOM READ: ${picks.length} reads, avg ${ms.toFixed(2)} ms/blob ` +
        `(avg ${Math.round(bytes / picks.length)} B)`,
    );
    // Not a benchmark assertion — a sanity floor. A regression to per-file
    // behaviour would be tens of milliseconds, not fractions.
    expect(ms).toBeLessThan(5);
    expect(bytes).toBeGreaterThan(0);
  });

  it("stores NO location: every media row is address, size, type and nothing else", () => {
    // THE DEFECT THIS TASK EXISTS TO REMOVE. The old default wrote
    // `C:\DEV\WEB\hashigo\exports\日本語\c7EiABp0.mp3` into 10,826 rows.
    expect(db.prepare("SELECT count(*) FROM blobs WHERE path IS NOT NULL").pluck().get()).toBe(0);
    // Media rows keep the payload out of the database; text rows keep it in.
    expect(
      db
        .prepare(
          `SELECT count(*) FROM blobs
             WHERE kind IN ('speech', 'image', 'file') AND bytes IS NOT NULL`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("resolves every address through the store, and the bytes rehash to it", () => {
    const sample = db
      .prepare(
        `SELECT hash, byte_size FROM blobs
           WHERE kind IN ('speech', 'image', 'file') ORDER BY hash LIMIT 8`,
      )
      .all() as { hash: string; byte_size: number }[];
    expect(sample).toHaveLength(8);
    for (const blob of sample) {
      // Nothing here knows a path. The hash is the whole query — and with the
      // SQLite backing there is not even a filename to know: `addressPath` is
      // still what a directory store would derive, and nothing consults it.
      const bytes = readBlob(db, blob.hash, store);
      expect(contentAddress(bytes)).toBe(blob.hash);
      expect(bytes.length).toBe(blob.byte_size);
      expect(addressPath(blob.hash)).toBe(`${blob.hash.slice(0, 2)}/${blob.hash}`);
    }
  });

  it(
    "rehashes ALL 10,826 payloads: zero missing, zero orphaned, zero mismatched",
    () => {
      const audit = auditBlobStore(db, store, { verify: true });
      console.log("audit", {
        blobs: audit.blobs,
        inline: audit.inline,
        present: audit.present,
        missing: audit.missing,
        orphaned: audit.orphaned,
        unreferenced: audit.unreferenced,
        sizeMismatched: audit.sizeMismatched,
      });
      expect(audit.present).toBe(10_826);
      expect(audit.missing).toBe(0);
      expect(audit.missingHashes).toEqual([]);
      expect(audit.orphaned).toBe(0);
      expect(audit.sizeMismatched).toBe(0);
      expect(audit.inline).toBe(audit.blobs - 10_826);

      // NOT ONE MEDIA BLOB is unreferenced: every payload in the store is
      // reachable from a card. The 48 that are unreferenced are inline text
      // generations (778 bytes in total), and they are a pre-existing
      // consequence of keying a text reference by generation key: where ONE
      // card cached two different outputs under the same normalised key, the
      // second reference is absorbed by blob_refs_scope and its blob lands at
      // refcount 0. 45 of the 48 have an identity sibling that IS referenced.
      // Refcounting is why this is visible and reclaimable rather than debris.
      const unreferencedMedia = db
        .prepare(
          `SELECT count(*) FROM blobs
             WHERE refcount = 0 AND kind IN ('speech', 'image', 'file')`,
        )
        .pluck()
        .get();
      expect(unreferencedMedia).toBe(0);
      expect(audit.unreferenced).toBe(48);
      expect(sweepUnreferenced(db, store, { dryRun: true }).bytesReclaimed).toBe(778);
    },
    600_000,
  );

  it("holds no absolute path and no reference to exports/ ANYWHERE in the database", () => {
    // Every column of every real table, through `findLocations` — the SAME
    // predicate `src/blobs/cli.ts paths` runs. It used to be a copy here and a
    // copy there, and both copies were blind to the same four path shapes; the
    // test below pins every shape so the pair cannot go half-blind again.
    const { offenders, columns, tables } = findLocations(db);
    console.log(`swept ${columns} columns across ${tables} tables; offenders:`, offenders);
    expect(offenders).toEqual([]);
    // And the narrower, unambiguous claim, stated separately: not one blob row
    // carries a location of any kind. (This database holds skeleton cards, so
    // the tariff card's prose is not in it; `src/blobs/cli.ts paths` runs the
    // same sweep over a fully imported database, where it is.)
    expect(db.prepare("SELECT count(*) FROM blobs WHERE path IS NOT NULL").pluck().get()).toBe(0);
  });

  it("catches every shape a location can take, and none of the corpus's prose", () => {
    // The check has to be able to FAIL, and it has to fail on all eight shapes.
    // The previous LIKE-chain caught four: it missed drive letters written with
    // forward slashes (which is the form this CLI's own --store example uses),
    // UNC shares, and both forms of file:// URL.
    const B = String.fromCharCode(92);
    const locations = [
      ["windows backslash", `C:${B}DEV${B}WEB${B}hashigo${B}media${B}x.mp3`],
      ["windows forward slash", "C:/Users/Zach/media/x.mp3"],
      ["posix absolute", "/home/zach/media/x.mp3"],
      ["UNC share", `${B}${B}NAS${B}media${B}x.mp3`],
      ["file URL, drive", "file:///D:/media/x.mp3"],
      ["file URL, posix", "file:///home/zach/x.mp3"],
      ["exports, relative", "exports/日本語/c7EiABp0.mp3"],
      ["drive root", `D:${B}x.mp3`],
    ] as const;
    // Real text from the corpus that must stay green forever.
    const innocent = [
      ["tariff card BE2i4rWu", "a tax or duty to be paid on a particular class of imports or exports."],
      ["jisho link", "https://jisho.org/search/%E8%A8%80"],
      ["takoboto link", "https://takoboto.jp/?q=1234"],
      ["a ratio", "3:4 and 16:9"],
      ["a time of day", "9:30 to 17:00"],
      ["an attachment name", "c7EiABp0.mp3"],
    ] as const;

    const probe = openDatabase(MEMORY, { applySchema: false });
    probe.exec("CREATE TABLE t (v TEXT)");
    const put = probe.prepare("INSERT INTO t (v) VALUES (?)");
    const wipe = probe.prepare("DELETE FROM t");
    const missed: string[] = [];
    const falsePositives: string[] = [];
    for (const [label, value] of locations) {
      wipe.run();
      put.run(value);
      if (findLocations(probe).offenders.length === 0) missed.push(`${label}: ${value}`);
    }
    for (const [label, value] of innocent) {
      wipe.run();
      put.run(value);
      if (findLocations(probe).offenders.length > 0) falsePositives.push(`${label}: ${value}`);
    }
    console.log(`location shapes ${locations.length} | missed`, missed);
    console.log(`innocent strings ${innocent.length} | false positives`, falsePositives);
    expect(missed).toEqual([]);
    expect(falsePositives).toEqual([]);

    // BLOB-typed columns are swept too — the old version filtered them out by
    // declared type, which left blobs.bytes (26,947 inline payloads) unread.
    probe.exec("CREATE TABLE b (v BLOB)");
    probe.prepare("INSERT INTO b (v) VALUES (?)").run(Buffer.from("C:/Users/Zach/x.mp3", "utf8"));
    expect(findLocations(probe).offenders).toContain("b.v: 1 row(s)");
    probe.close();
  });

  it("takes the mime from the bytes: only 41 of 10,890 declared types were right", () => {
    console.log("declared", report.declaredTypes);
    console.log("sniffed ", report.sniffedMimes);
    expect(report.mimeCorrected).toBe(10_849);
    expect(report.declaredTypes["text/xml"]).toBe(3_431);
    expect(report.declaredTypes[""]).toBe(2_414);
    expect(report.sniffedMimes["audio/mpeg"]).toBe(10_877);
    expect(report.sniffedMimes["image/jpeg"]).toBe(9);
    expect(report.sniffedMimes["image/png"]).toBe(1);
    expect(db.prepare("SELECT count(*) FROM blobs WHERE mime = 'text/xml'").pluck().get()).toBe(0);
  });

  it("drops every cache pointer that does not name a live file", () => {
    expect(report.cachePointers).toBe(24_517);
    expect(report.cachePointersLive).toBe(10_860);
    expect(report.cachePointersTombstoned).toBe(5_684);
    expect(report.cachePointersDangling).toBe(7_973);
    expect(report.cacheTextOnly).toBe(31_837);
    expect(report.cacheFailures).toBe(323);
    // 78 cached generations produced the empty string. A subset of
    // cacheTextOnly, and not imported: sha256("") is already the address of the
    // 10 zero-byte mp3s, so importing them would file text under kind 'speech'.
    expect(report.textPayloadsEmpty).toBe(78);
    expect(report.cacheUnusable).toBe(133);
    // Every one of the 56,767 cache leaves is accounted for.
    expect(
      report.cachePointers + report.cacheTextOnly + report.cacheFailures + report.cacheUnusable,
    ).toBe(56_810);
    expect(report.generationKeys).toBe(10_837);
    expect(report.generationEdges).toBe(10_851);
    // The cost of having no generation_cache table: see the module header.
    expect(report.generationEdgesDropped).toBe(42);
    // 30 live files carry no cache entry; 13 of them dedupe onto an address that
    // another, provenanced file also reaches, so 17 blobs hold no identity tuple
    // and are addressable only by their bytes. Counted independently above.
    expect(report.blobsWithoutProvenance).toBe(17);
  });

  it("a cached input from the real export is a HIT, however the lang is spelled", () => {
    // 日本語 card FiW5S4Yg: 'だけに {:lang "ja-JP", :voice "ja-JP-NanamiNeural"}'
    // -> c7EiABp0.mp3. The address must be that file's bytes, and asking again
    // must not generate.
    const expected = contentAddress(readFileSync(join(EXPORTS, "日本語", "c7EiABp0.mp3")));
    const request = {
      kind: "speech",
      text: "だけに",
      voice: "ja-JP-NanamiNeural",
    } as const;
    const explode = () => {
      throw new Error("regenerated an input that was already in the cache");
    };
    const declared = resolveGeneration(db, { ...request, lang: "ja-JP" }, explode);
    const inline = resolveGeneration(db, { ...request, lang: "jp" }, explode);
    console.log("だけに ->", declared.hash, "hit", declared.hit, "key", declared.key);
    expect(declared.hash).toBe(expected);
    expect(declared.hit).toBe(true);
    expect(inline.hash).toBe(expected);
    expect(inline.hit).toBe(true);
    expect(
      db.prepare("SELECT ref_key FROM blob_refs WHERE blob_hash = ?").pluck().all(declared.hash),
    ).toContain("c7EiABp0.mp3");
  });

  it("keeps the tilde on ～に越したことはない, which transit escapes in map keys", () => {
    const doubled = db
      .prepare("SELECT count(*) FROM blobs WHERE source_text LIKE '~~%'")
      .pluck()
      .get();
    expect(doubled).toBe(0);
    expect(
      db
        .prepare("SELECT count(*) FROM blobs WHERE source_text = ?")
        .pluck()
        .get("~に越したことはない"),
    ).toBeGreaterThan(0);
  });

  it("also caches the text generations, so ai and translate do not re-bill", () => {
    const text = db
      .prepare(
        `SELECT kind, count(*) AS n FROM blobs
           WHERE kind IN ('ai', 'translate', 'furigana', 'dictionary')
           GROUP BY kind ORDER BY kind`,
      )
      .all();
    console.log("text-generation blobs", text, "refs", report.textRefs);
    expect(report.textBlobs).toBeGreaterThan(0);
    const ai = db
      .prepare("SELECT source_text, bytes FROM blobs WHERE kind = 'ai' LIMIT 1")
      .get() as { source_text: string; bytes: Buffer };
    expect(ai.source_text.length).toBeGreaterThan(0);
    expect(ai.bytes.length).toBeGreaterThan(0);
  });

  // LAST, because it invalidates `store`: the root is renamed out from under a
  // database that has 10,826 references into it.
  it(
    "survives the store being renamed: 10,826 references still resolve",
    () => {
      const hashes = db
        .prepare(
          `SELECT hash, byte_size FROM blobs
             WHERE kind IN ('speech', 'image', 'file') ORDER BY hash`,
        )
        .all() as { hash: string; byte_size: number }[];
      expect(hashes).toHaveLength(10_826);

      // The handle has to be released before the file can be renamed on Windows;
      // that is the only thing the SQLite backing changes about this test. The
      // property under test is unchanged and is now sharper: the store is ONE
      // file, and moving it is a rename of that file.
      const from = opened.file;
      const moved = join(dirname(from), "renamed-and-somewhere-else-entirely.db");
      opened.close();
      renameSync(from, moved);
      expect(existsSync(from)).toBe(false);
      // The old location is now nothing, which is the situation the old
      // `path`-column design put the whole database in permanently.
      expect(() => openBlobStoreDatabase(from, { mustExist: true })).toThrow(/no blob store/);

      // Nothing is migrated. A new store, a new file name, the same rows.
      const relocatedHandle = openBlobStoreDatabase(moved, { mustExist: true, create: false });
      OPEN_STORES.push(relocatedHandle);
      const relocated = relocatedHandle.store;
      let bytesRead = 0;
      for (const blob of hashes) {
        const size = relocated.size(blob.hash);
        expect(size).toBe(blob.byte_size);
        bytesRead += size ?? 0;
      }
      // Rehash a deterministic sample through the database's own read path.
      for (const blob of hashes.filter((_, index) => index % 1_000 === 0)) {
        expect(contentAddress(readBlob(db, blob.hash, relocated))).toBe(blob.hash);
      }
      console.log(
        `renamed the store file to ${moved}; all 10,826 addresses still resolve ` +
          `(${(bytesRead / 1024 / 1024).toFixed(0)} MB), and not one row changed`,
      );
      expect(auditBlobStore(db, relocated).missing).toBe(0);
      expect(db.prepare("SELECT count(*) FROM blobs WHERE path IS NOT NULL").pluck().get()).toBe(0);

      // AND THE STORE FILE ITSELF HOLDS NO LOCATION. The card database is swept
      // by the test above; this is the second file the acceptance check now has
      // to answer for. `hash` is CHECK-ed to 64 hex characters and `byte_size` is
      // an integer, so the sweep is really asking about one column: the payload.
      const storeDb = openDatabase(moved, { applySchema: false, readOnly: true });
      try {
        const sweep = findLocations(storeDb, { exclude: ["blob_payloads.bytes"] });
        console.log(
          `store file swept: ${sweep.columns} columns across ${sweep.tables} tables; ` +
            `offenders ${JSON.stringify(sweep.offenders)}; ` +
            `excluded ${JSON.stringify(sweep.excluded)}`,
        );
        // Two tables (blob_payloads, blob_store_meta), five columns, and nothing
        // addressable holds a location.
        expect(sweep.tables).toBe(2);
        expect(sweep.columns).toBe(5);
        expect(sweep.offenders).toEqual([]);

        // THE MEASURED REASON THE PAYLOAD COLUMN IS EXCLUDED, asserted so the
        // exclusion cannot quietly become unnecessary or quietly hide something.
        // 559 of 10,826 mp3s have a byte sequence in their first 4 KB that
        // decodes to something LOCATION_PATTERN matches. Compressed audio
        // contains every byte pair eventually; `C:/` is two bytes and a slash.
        // A check that fires on 5% of a corpus of correct data is not a check.
        const unfiltered = findLocations(storeDb);
        expect(unfiltered.offenders).toEqual([`blob_payloads.bytes: 559 row(s)`]);
        expect(sweep.excluded).toEqual([`blob_payloads.bytes: 559 row(s)`]);
      } finally {
        storeDb.close();
      }
    },
    600_000,
  );
});

describe("LOCATION_PATTERN — the gate that keeps absolute paths out of the DB", () => {
  // The POSIX branch used to be anchored at ^, so a path embedded mid-string
  // slipped through. Found by the completeness critic poisoning
  // template_fields.options and cards.content: 2 of 5 shapes passed the gate.
  const B = String.fromCharCode(92); // a single backslash, no escaping to misread

  const MUST_FLAG: ReadonlyArray<readonly [string, string]> = [
    ["/home/zach/a.mp3", "posix at start"],
    ["see /home/zach/a.mp3 here", "posix EMBEDDED - the hole"],
    ["note: /usr/local/lib", "posix after a space"],
    ['"/var/tmp/x"', "posix after a quote"],
    [`C:${B}DEV${B}WEB${B}x.mp3`, "windows drive"],
    ["exports/日本語/x.mp3", "the exports dir itself"],
    ["file:///c/tmp", "file url"],
  ];

  // A false positive here flags the user's own content as a path.
  const MUST_NOT_FLAG: ReadonlyArray<readonly [string, string]> = [
    ["https://jpdb.io/search?q=x", "his JPDB links"],
    ["https://www.immersionkit.com/dictionary?keyword=y", "his IKD links"],
    [`変動費率＝変動費 ${B} 売上`, "基本情報 division - 45 rows of his arithmetic"],
    [`a ${B}times b`, "LaTeX"],
    ["and/or", "a bare slash"],
    ["日本語/単語", "a deck path"],
    ["意味/読み/例文", "a multi-segment deck path"],
  ];

  it.each(MUST_FLAG)("flags %s (%s)", (text) => {
    expect(LOCATION_PATTERN.test(text)).toBe(true);
  });

  it.each(MUST_NOT_FLAG)("does not flag %s (%s)", (text) => {
    expect(LOCATION_PATTERN.test(text)).toBe(false);
  });
});
