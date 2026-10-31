/**
 * A run asked to mute the target's automation that could not be muted, in
 * the interface language, by the code the host sends beside its English:
 * `MUTE_PRODUCTION` — the target is a production org, or one that could not
 * be told from one —; `MUTE_NO_RIGHT` — the user the run writes as cannot
 * assign permission sets, or the org would not say —; `MUTE_FAILED` — a set
 * could not be found, assigned or read back —; and a checkpoint's rewind or
 * undo, which says all three as `MUTE`. Nothing was assigned, nothing written.
 *
 * In `common.refusal`, beside the guard's: every page waits on a request
 * that may answer one, and the shell's catalogue holds them. The first two
 * are said whole. A failure keeps the host's own words after
 * the translated sentence, as the guard's reason is kept: what the org
 * answered is the part to act on. A checkpoint's refusal names no kind, and
 * keeps them too.
 */
const MUTE_KEYS: Readonly<Record<string, { key: string; reason: boolean }>> = {
  MUTE_PRODUCTION: { key: 'common.refusal.muteProduction', reason: false },
  MUTE_NO_RIGHT: { key: 'common.refusal.muteNoRight', reason: false },
  MUTE_FAILED: { key: 'common.refusal.muteFailed', reason: true },
  MUTE: { key: 'common.refusal.muteCheckpoint', reason: true },
};

/** Whether `code` is a refused mute's. */
export function isMuteRefusalCode(code: string | null | undefined): boolean {
  return code != null && Object.prototype.hasOwnProperty.call(MUTE_KEYS, code);
}

/**
 * A refused mute's words, or `undefined` for any other code.
 *
 * @param t - Translates a key in the interface language.
 */
export function muteRefusalWords(
  code: string | null | undefined,
  message: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (!isMuteRefusalCode(code) || code == null) return undefined;
  const { key, reason } = MUTE_KEYS[code];
  return reason ? t(key, { reason: message ?? '' }) : t(key);
}
