// Relay limits. Kept free of Workers imports so tests can read them.

export const MAX_FRAME_BYTES = 64 * 1024
export const HISTORY_MAX = 100
export const PENDING_MAX = 20
export const PENDING_MAX_AGE_MS = 60_000
/** A newcomer beyond this evicts the oldest socket of its role. */
export const MAX_SOCKETS_PER_ROLE = 8
// Token bucket per room: sustained RATE frames/s, bursts up to BURST.
export const RATE_PER_SEC = 20
export const BURST = 60
/** History to glasses is also capped by total bytes. */
export const HISTORY_MAX_BYTES = 1024 * 1024
/** History is pruned every N inserts to keep free-tier row writes near one per frame. */
export const PRUNE_EVERY = 10
/** A room nobody connects to for this long is wiped. */
export const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000
