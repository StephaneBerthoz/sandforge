import type { ConfigStore } from '../../core/storage/ConfigStore.js';

/** Key prefix of the stored resume points, one entry per source org. */
const REPLAY_KEY_PREFIX = 'realtime:replay:';

/** Config store category of the stored resume points. */
const REPLAY_CATEGORY = 'realtime';

/**
 * Where each change event channel of a source org was last read to.
 *
 * A session stores the replay id of the last event it finished with — written,
 * refused, held or skipped — so the next session on the same org resumes right
 * after it, and the changes made while nothing was listening are replayed
 * instead of lost. The org keeps them three days.
 */
export class ReplayStore {
  /**
   * @param configStore - Persistence that outlives the editor session.
   * @param sourceOrgId - The registered org the channels belong to.
   */
  constructor(
    private readonly configStore: Pick<ConfigStore, 'get' | 'set' | 'delete'>,
    private readonly sourceOrgId: string,
  ) {}

  private get key(): string {
    return `${REPLAY_KEY_PREFIX}${this.sourceOrgId}`;
  }

  private read(): Record<string, number> {
    const stored = this.configStore.get<Record<string, unknown>>(this.key);
    const positions: Record<string, number> = {};
    if (!stored || typeof stored !== 'object') return positions;
    for (const [channel, replayId] of Object.entries(stored)) {
      if (typeof replayId === 'number' && Number.isFinite(replayId)) positions[channel] = replayId;
    }
    return positions;
  }

  /** The replay id `channel` was last read to, or `undefined` when it never was. */
  get(channel: string): number | undefined {
    return this.read()[channel];
  }

  /** Record how far each channel has been read, keeping the other channels as they were. */
  save(positions: ReadonlyMap<string, number>): void {
    if (positions.size === 0) return;
    this.configStore.set(
      this.key,
      { ...this.read(), ...Object.fromEntries(positions) },
      REPLAY_CATEGORY,
    );
  }

  /** Forget every resume point of the org, as after a sandbox refresh made it another org. */
  forget(): void {
    this.configStore.delete(this.key);
  }
}
