/**
 * IS WHAT THIS DEVICE HOLDS STILL WHAT THE SERVER IS SERVING?
 *
 * Two files, two questions, and getting the SECOND one wrong cost Zach three
 * reports of the same defect.
 *
 * ─── THE CARD DATABASE ──────────────────────────────────────────────────────
 *
 * Compared on `seedReviews` — reviews whose `source <> 'local'`. That is the one
 * number local grading cannot move, so the comparison stays correct once he is
 * reviewing here; `count(*)` would report a mismatch the moment he answered his
 * first card, and "re-fetch" there means "delete his grades". The refuse-loudly
 * branch lives in `db.worker.ts` because it needs to count local reviews.
 *
 * ─── THE AUDIO FILE, WHICH HAD NO CHECK AT ALL ──────────────────────────────
 *
 * Zach, 2026-09-12, having said it three times: *"i don't know what to tell you
 * but the example sentence audio is not there😭 … you don't have ears... so i
 * can't prove it to you... but it's literally not there"*.
 *
 * He was right, and the first two answers were only half the diagnosis. The clip
 * genuinely was not in the shipped subset — `app-bootstrap` spends its budget on
 * each card's CHEAPEST clip first, and a card's second clip is the example
 * sentence. **But rebuilding with a bigger budget would not have reached him
 * either.** `seedReviews` is a property of the CARD database; a seed carrying
 * three times the audio has exactly the same count. `ensureFile` then skips any
 * file OPFS already holds, and the boot log says "already in OPFS — not
 * re-fetching" in green. Both devices would have played the old subset for ever.
 *
 * So the audio gets its own comparison, on `blob_store_meta.created` — one row,
 * written fresh by the blob store's own DDL on every bootstrap, so it changes
 * exactly when the file does and never when it does not. `count(*)` over
 * `blob_payloads` answers the same question by walking every overflow page of a
 * 640 MB file.
 *
 * **Replacing the audio destroys nothing** — it is content-addressed, the worker
 * opens it `{ create: false }` and only ever reads it, and no grade or card lives
 * in it. That is why this half needs none of the card database's machinery.
 *
 * NO IMPORTS — same rule as `./review-boundary.ts`: the root `tsconfig.json`
 * excludes `app/`, so an import-free module is reachable from `test/` and one
 * that touches the worker is not.
 */

/**
 * Should the audio file be fetched again?
 *
 * `serving` is `SeedManifest.storeCreated`; `held` is `blob_store_meta.created`
 * read out of the copy in OPFS. Both are opaque strings — this compares them and
 * makes no claim about which is newer, because a rebuild at a smaller budget is
 * a legitimate thing to want and "older" is not "wrong".
 */
export function audioIsStale(serving: string | undefined, held: string | undefined): boolean {
  // AN ABSENT `serving` MEANS AN OLDER MANIFEST, NOT A MISMATCH. Manifests
  // written before 2026-09-12 carry no such field, and a static host serving one
  // must keep working — treating "" as a mismatch re-downloads 640 MB on every
  // single boot, for ever, with no way for the user to tell why.
  if (serving === undefined || serving === "") return false;
  return serving !== (held ?? "");
}
