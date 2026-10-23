/**
 * The orgs the runs of one handler write to now, as a checkpoint of one asks
 * (`CheckpointHandler`'s refusal of a run writing to the org).
 *
 * A Sync or a Seed run names the org it writes to in its file, which the
 * checkpoint reads. A Frozen load and its removal, a DataOps restore, masking
 * run or erasure write to the org their request names, and nothing kept on
 * disk says so while they run: their handler is the only one that knows. A
 * checkpoint taken meanwhile held a load's records half written, and a rewind
 * or an undo run meanwhile wrote under it.
 */
export class WritingOrgs {
  /** Runs under way, by the registered id of the org they write to. */
  private readonly runs = new Map<string, number>();

  /**
   * Run `run` with `orgId` held as written to until it settles, however it
   * ends. Nothing is held for no org: a request that names none, or a
   * simulation, which writes to none.
   */
  async during<T>(orgId: string | undefined, run: () => Promise<T>): Promise<T> {
    if (orgId === undefined) return run();
    this.runs.set(orgId, (this.runs.get(orgId) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const left = (this.runs.get(orgId) ?? 1) - 1;
      if (left > 0) this.runs.set(orgId, left);
      else this.runs.delete(orgId);
    }
  }

  /** Whether a run writes to the registered org `orgId` now. */
  has(orgId: string): boolean {
    return this.runs.has(orgId);
  }
}

/**
 * The text a request's payload holds under `field`, read before the payload
 * is validated: the org a run is about to write to, held from the moment its
 * request arrives. The handler then validates the payload as it always did.
 */
export function payloadText(msg: object, field: string): string | undefined {
  const payload = 'payload' in msg ? msg.payload : undefined;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
