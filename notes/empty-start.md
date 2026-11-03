# Starting from an empty database — the plan for RELEASE.md's beta criterion 2

Written 2026-11-04 from a read of the code, not a run. File:line references are as of
`1763a6e`. Criterion: *a friend starts from an empty database without help.*

## Why it cannot happen today

| What assumes Zach's data | Where | On an empty device |
|---|---|---|
| The seed exists in R2 | `app/db.worker.ts` `ensureFile` (306-355) throws on a non-OK fetch; `cloud/app/src/app.ts` 180-191 returns 404 | **boot dies** |
| At least one card | `app/db.worker.ts:772` "refusing to start a review over nothing" | **boot dies** |
| The audio store exists | `SqliteBlobStore` opened with `create: false` (`db.worker.ts:740`) | **boot dies** |
| One passphrase | `cloud/app/src/app.ts` 115-124 / 155-164: one `UNLOCK_HASH`, one `COOKIE_KEY`, the cookie holds only an expiry | a friend gets everything, his seed included |
| One mailbox | `cloud/mailbox/src/mailbox.ts:72` `PREFIX = "payload:"`; `listPeers` lists every key; each device merges all peers | **a friend's device merges into his collection, and his into theirs** — reviews union, templates and `local = 1` cards upsert, settings last-write-wins |
| `優先`, the 日本語 exam tier, 漢字-first, `queue.exam-target` | `src/scheduler/queue.ts` | harmless: name lookups find nothing, the target defaults |
| Making templates and decks | `src/cards/create.ts` `createTemplate` (since `e71c51b`); the deck insert in `db.worker.ts` | already possible from the UI |

What already works: `openDatabaseBrowser` applies the schema when the file is new and the
schema text is passed (`src/db/browser.ts:336-350`, recipe in its error message), and
`SqliteBlobStore` creates itself when `create` is not `false` (`src/blobs/sqlite.ts:215-233`).
So the database half of "empty" is a branch, not a project.

## The phases

**Phase 1 — a second deployment that starts empty, with no sync to anyone.** Risk to Zach: **low.**
- A second Worker with its own name, origin, KV namespace, R2 bucket (empty or absent) and
  its own `UNLOCK_HASH` / `COOKIE_KEY`. OPFS is keyed by origin, so nothing on that origin
  can touch his devices' databases, and its mailbox is a different namespace.
- `app/db.worker.ts` `open()`: behind a build flag (`VITE_EMPTY_START`), when the card
  database is absent, skip the manifest and `ensureFile`, open `CARD_DB` with the schema and
  views text, create the blob store, and allow 0 cards.
- `app/main.ts`: an empty plan needs a first screen that offers "make a deck / make a
  template" instead of the refusal. Not read yet: how the session view renders with nothing.
- **Zach's part:** creating the Cloudflare resources and secrets (`wrangler kv namespace
  create`, `wrangler r2 bucket create`, `wrangler secret put`), and choosing the second
  passphrase. An agent should not create billable resources or set secrets unasked.

**Phase 2 — several people on one origin.** Risk to Zach: **high.**
- A user map of unlock hashes in `cloud/app/src/app.ts`; the user written into the cookie
  (`<user>.<expires>.<hmac>`) and passed to the mailbox handler, which prefixes `payload:`
  keys and the `/generated/` listing by user. The `generate:` cache can stay shared — it is
  content-addressed.
- Zach's existing keys stay unprefixed (or move under his tag in one step). A prefix
  mistake makes his devices see no peers, or a friend see his — so test against a copy of
  the KV on a staging Worker before it goes near his.

**Phase 3 — starter templates.** A generic front/back template and a Japanese 単語-like one,
offered on the first screen; his seed becomes something only his user fetches. Risk:
**medium** — it touches the boot branch he runs every day.

**Phase 4 — onboarding** (sign-up, licence, cost). Needs accounts, which exist nowhere in the
code; it is release gate 3's territory.

## Where this stopped

2026-11-04: plan only. No code was written, because phase 1's code cannot be tried without
the second Worker, and the boot path is the one he runs daily — a branch landed untried in
`open()` is a risk to every review he does, for no gain until the resources exist.
