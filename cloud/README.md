# cloud/ — the app runs from Cloudflare (since 2026-09-26)

`app/` is the Worker serving the live app (<https://hashigo.titan-zp4.workers.dev>);
`mailbox/` is the sync + generation Worker the tailnet build and the laptop scripts use.
`app/` bundles `mailbox/`'s handler, so both serve the same routes over the same KV.

Moved here word for word from `NEXT.md` on 2026-10-30, when that file was retired
(it is at `notes/archive/NEXT-retired-2026-10-30.md`).

**Why:** his apartment wifi drops every Tailscale tunnel packet over ~1,208 bytes (measured
with DF pings; small `/ping` answered, TLS handshakes and assets vanished). Windows will not
take the Tailscale adapter below 1,280 for IPv6, and `TS_DEBUG_MTU=1200` stopped Tailscale
from starting at all (reverted). Decision 49 had already retired "no cloud".

**What runs where:**

| | where | notes |
|---|---|---|
| app + seed + sync + generate | `https://hashigo.titan-zp4.workers.dev` (`cloud/app/`) | one origin; passphrase once per device → signed HttpOnly cookie; everything but `/ping` `/unlock` locked |
| sync + generate for the TAILNET build | `https://hashigo-mailbox.titan-zp4.workers.dev` (`cloud/mailbox/`) | bearer token baked into the tailnet bundle only; same KV |
| mailbox payloads, generations | KV `1d33ef525a084e5b852fb5cb78f72311` | `payload:<device>`, `gen:<key>` |
| seed files | R2 `hashigo-seed` | 674 MB audio store is ONE object via R2 multipart |

**Secrets** (Worker secret store only): `MAILBOX_TOKEN`, `GOOGLE_TTS_SECRET`,
`ANTHROPIC_API_KEY`, and on `hashigo` also `UNLOCK_HASH` + `COOKIE_KEY`. `.env` holds
`VITE_MAILBOX_URL`, `VITE_MAILBOX_TOKEN` and `HASHIGO_UNLOCK_PASSPHRASE` (for him to read).

**Updating the cloud app:** `npm run app:build:cloud`, then `npx wrangler@4 deploy` in
`cloud/app/`. **New seed:** `npm run app:bootstrap` then `npx vite-node
scripts/cloud-seed-upload.ts` (manifest last). **Cloud generations into the laptop DB:**
`npx vite-node scripts/cloud-generated-pull.ts -- --apply`, before any seed rebuild.

**The seed-rebuild order, in full:** pull (above) → `npx vite-node scripts/audio-gc.ts --
--apply` → `npm run app:bootstrap` → `scripts/cloud-seed-upload.ts`. **Bootstrap refuses**
while any clip is unreached by every device or any payload has no row — the check merges
every device's mailbox payload first, because edits made on a device exist nowhere else
(measured 2026-09-28: 2 clips reachable only that way). First run removed 834 superseded
clips + 3,692 row-less payloads, 66.7 MiB, archived to `build/audio-gc/removed-*.db`.
Row-less payloads come from `rm build/hashigo.db` rebuilds: the store is a separate file
and keeps the bytes of rows the rebuild dropped.

**Traps paid for:** stitching seed parts inside a Worker hit the free plan's CPU cap and cut
the download at 108 MB with no Content-Length — serve single R2 objects only. Vitest reads
`.env`, so the suite pins the two `VITE_MAILBOX_*` vars empty (`vitest.config.ts`). The
cloud build must use `--mode cloud` (`.env.cloud` empties the key) — a default build bakes
the mailbox token in.

**Deploying** is Zach's call (CLAUDE.md, "Deploy when Zach asks"). A change under
`src/generate/` or `cloud/mailbox/` reaches the tailnet build and the scripts only when
`hashigo-mailbox` is deployed as well: `npx wrangler@4 deploy` in `cloud/mailbox/`.
Confirm the app in Settings → versions (`app v0.5.0 · <commit>`).
