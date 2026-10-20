/**
 * How long a page waits for the answer of a write run it started: a Sync, a
 * Seed, a CSV import or a clone. The extension runs it in the background and
 * answers once it ends; its progress events never reset the wait. A paused
 * run waits on a person, for as long as that person takes, and a run of tens
 * of thousands of records takes as long as the org does: held to the two
 * minutes a run used to be given, a long run lost its page — the bar and its
 * Cancel — and said "Try again" while it went on writing, which wrote its
 * records twice.
 *
 * A module of its own, so that a test standing in for the bridge hooks does
 * not take the number away with them.
 */
export const WRITE_RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;
