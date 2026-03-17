/**
 * HintTracker manages contextual hints that display once per user.
 * Each hint has a unique ID and is marked as seen after the user dismisses it.
 */
export class HintTracker {
  private static PREFIX = 'sandforge.hint.';

  private readonly globalStateGet: (key: string) => string | undefined;
  private readonly globalStateUpdate: (key: string, value: string) => Thenable<void>;

  constructor(globalState: {
    get: (key: string) => string | undefined;
    update: (key: string, value: string) => Thenable<void>;
  }) {
    this.globalStateGet = (key: string) => globalState.get(key);
    this.globalStateUpdate = (key: string, value: string) => globalState.update(key, value);
  }

  /** Check if a hint has already been seen by the user. */
  isHintSeen(hintId: string): boolean {
    return this.globalStateGet(HintTracker.PREFIX + hintId) === 'true';
  }

  /** Mark a hint as seen (dismissed). */
  async markHintSeen(hintId: string): Promise<void> {
    await this.globalStateUpdate(HintTracker.PREFIX + hintId, 'true');
  }

  /** Reset all hints so they appear again. */
  async resetAllHints(hintIds: string[]): Promise<void> {
    for (const id of hintIds) {
      await this.globalStateUpdate(HintTracker.PREFIX + id, '');
    }
  }
}
