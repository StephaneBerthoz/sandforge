/**
 * The most records a checkpoint holds of one object, whatever limit it is
 * given (`OBJECT_ROWS_MAX` in the extension's takeCheckpoint): Records at
 * most goes no higher, and an object past it is held by no checkpoint.
 *
 * A module of its own, which renders nothing: the pages that read it load no
 * catalogue for it.
 */
export const CHECKPOINT_OBJECT_ROWS_MAX = 1_000_000;
