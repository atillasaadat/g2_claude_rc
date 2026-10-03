// Shared size and time limits. The relay enforces MAX_FRAME_BYTES too.

export const FRAME_VERSION = 1
export const KEY_BYTES = 32
export const NONCE_BYTES = 12
export const MAX_FRAME_BYTES = 64 * 1024

/** Commands to the computer older than this are dropped (replay protection). */
export const COMMAND_MAX_AGE_MS = 60_000
/** Display data to the glasses may be older, because the relay replays history to late joiners. */
export const DISPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Commands stamped this long before the channel started are still accepted (phone clock lag). */
export const RESTART_MARGIN_MS = 5_000
/** Allowed clock skew between the computer and the phone. */
export const MAX_SKEW_MS = 30_000

export const GLANCE_MAX = 120
export const TEXT_MAX = 16_000
export const SHORT_MAX = 500
export const PROMPT_MAX = 4_000
export const QUESTION_OPTIONS_MAX = 4
