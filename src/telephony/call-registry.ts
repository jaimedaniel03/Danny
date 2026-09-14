/**
 * Pending-call registry.
 *
 * Between `placeCall()` and the media stream connecting there is a gap of a few
 * seconds, and the media server needs to turn the `callRecordId` in the stream
 * URL back into everything a `CallSession` needs — the authorization, the
 * synthesis port, the callbacks.
 *
 * Rebuilding that from the database on every connection would mean a round trip
 * inside the window where the caller is already listening, and would still not
 * carry the live objects (the Fish client, the completion callbacks). So the
 * dialer registers the deps and the media server claims them.
 *
 * ── Why entries expire ──────────────────────────────────────────────────────
 * A registered call that is never claimed is a leak — the callee did not answer,
 * Twilio gave up, and nobody will ever connect. Each entry holds a
 * `DialAuthorization`, which is itself short-lived, so the TTL here is set just
 * past Twilio's ring timeout: long enough for a slow answer, short enough that
 * an abandoned entry cannot be claimed later with a stale authorization.
 */

import type { CallSessionDeps } from './media-server';

/** Twilio's dial timeout is 25s; allow generous margin for connect + stream setup. */
const ENTRY_TTL_MS = 120_000;

interface Entry {
  readonly deps: CallSessionDeps;
  readonly registeredAt: number;
  claimed: boolean;
}

const pending = new Map<string, Entry>();

/** Drop entries nobody claimed. Called on every write and read. */
function sweep(now = Date.now()): void {
  for (const [id, entry] of pending) {
    if (now - entry.registeredAt > ENTRY_TTL_MS) pending.delete(id);
  }
}

export function registerPendingCall(callRecordId: string, deps: CallSessionDeps): void {
  sweep();
  pending.set(callRecordId, { deps, registeredAt: Date.now(), claimed: false });
}

/**
 * Claim a registered call.
 *
 * Single-use. A second connection for the same id returns null rather than
 * starting a second `CallSession` against one authorization — two sessions
 * speaking into the same leg would interleave audio, and the duplicate would
 * be an unaudited use of a single-use authorization.
 */
export function claimPendingCall(callRecordId: string): CallSessionDeps | null {
  sweep();
  const entry = pending.get(callRecordId);
  if (!entry || entry.claimed) return null;

  entry.claimed = true;
  // Keep the claimed entry until it expires so a duplicate connection is
  // distinguishable from an unknown id in the logs.
  return entry.deps;
}

export function releasePendingCall(callRecordId: string): void {
  pending.delete(callRecordId);
}

/**
 * How many calls are registered and still waiting for a media stream.
 *
 * Claimed entries are deliberately excluded. They stay in the map until they
 * expire — that is what lets a duplicate connection be logged as a duplicate
 * rather than as an unknown id — but they are not *pending* any more, and a
 * health check or a dry run that counted them would report a leak on every
 * call that connected normally.
 */
export function pendingCallCount(): number {
  sweep();
  let count = 0;
  for (const entry of pending.values()) if (!entry.claimed) count += 1;
  return count;
}

/** Entries kept only so a duplicate connection is distinguishable from an unknown id. */
export function claimedCallCount(): number {
  sweep();
  let count = 0;
  for (const entry of pending.values()) if (entry.claimed) count += 1;
  return count;
}

/** Test seam — the registry is module-level state. */
export function resetRegistry(): void {
  pending.clear();
}
