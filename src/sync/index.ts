/**
 * Stage 11 — sync. See `./merge.ts` for the rules and why two of them are not
 * last-write-wins.
 *
 * The TRANSPORT is deliberately not in here. `mergeSync` takes a payload and a
 * database and knows nothing about how the two devices met, which is what makes
 * it testable on one machine against two divergent copies of the real corpus —
 * and what keeps the rendezvous (decision 33) a replaceable choice rather than a
 * rewrite.
 */
export {
  SYNC_VERSION,
  exportSync,
  mergeSync,
  type CardFlags,
  type MergeReport,
  type SyncPayload,
} from "./merge.js";
export {
  deltaPayload,
  exportDelta,
  isDelta,
  maxLocalReviewId,
  type SyncDelta,
} from "./delta.js";
