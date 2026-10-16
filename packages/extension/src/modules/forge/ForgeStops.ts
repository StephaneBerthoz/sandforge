/**
 * The Forge operations under way in one window, by the request that started
 * each, and what a stop takes among them.
 *
 * One handler serves every panel of the window. A stop named nothing, and
 * stopped everything at once: the run of one panel with the discovery of
 * another, or a run waiting on Production Guard's question with the run
 * writing beside it. And a discovery stopped every discovery before it, so a
 * second panel's silenced the first, whose page waited for an answer that
 * never came. Each operation is kept here under the id of its request — ids
 * no two panels share — so that a stop takes the one it names, and a
 * discovery stopped for another one is known as such, to be answered so.
 *
 * Bookkeeping only: the handler aborts what a stop takes, through the
 * background registry and the controllers kept here.
 */

/** Why a discovery under way was stopped, which its answer says. */
export type DiscoveryStop = 'stopped' | 'superseded';

/**
 * The most discoveries walked at once. Each walks the source org's schema
 * describe by describe; past this many, the oldest is stopped for the newest
 * and answered as such, rather than every page waiting on a walk the org
 * spreads its API calls over.
 */
export const MAX_DISCOVERIES = 3;

/** A discovery under way. */
export interface LiveDiscovery {
  /** The `forge:discover` request it answers. */
  readonly requestId: string;
  /** What its walk follows. */
  readonly controller: AbortController;
  /** The id the background registry and Live Operations know it by. */
  readonly operationId: string;
  /** Set once a stop took it, with why. */
  stop?: DiscoveryStop;
}

/** What a stop takes. */
export type StopTarget =
  | { kind: 'discovery'; discovery: LiveDiscovery }
  /** A run waiting on Production Guard's question: it does not start once answered. */
  | { kind: 'awaiting-guard'; controller: AbortController }
  /** The run the executor holds. */
  | { kind: 'run' };

/** What became of a stop. */
export type StopResolution =
  | { stops: StopTarget }
  /** A stop that named nothing, with several operations under way: it takes none. */
  | { refused: 'several'; live: number }
  /** Nothing under way answers it: what it named has ended, or nothing runs. */
  | { refused: 'none' };

/** The Forge operations under way, by request, and what a stop takes. */
export class ForgeStops {
  /** The discoveries under way, oldest first. */
  private readonly discoveries = new Map<string, LiveDiscovery>();
  /** The runs waiting on Production Guard's question, by request. */
  private readonly awaitingGuard = new Map<string, AbortController>();
  /** The run the executor holds — one at a time — by its request. */
  private run: { requestId: string; controller: AbortController } | null = null;

  /** @param maxDiscoveries - The most discoveries walked at once. */
  constructor(private readonly maxDiscoveries: number = MAX_DISCOVERIES) {}

  /**
   * Keep a discovery that starts, and give back the ones it supersedes: a
   * discovery sent again under the same request, and the oldest past the
   * number walked at once. Those are taken off the list, marked superseded,
   * for the caller to abort.
   */
  beginDiscovery(
    requestId: string,
    controller: AbortController,
    operationId: string,
  ): { discovery: LiveDiscovery; superseded: LiveDiscovery[] } {
    const superseded: LiveDiscovery[] = [];
    const take = (old: LiveDiscovery): void => {
      this.discoveries.delete(old.requestId);
      old.stop = 'superseded';
      superseded.push(old);
    };
    const again = this.discoveries.get(requestId);
    if (again) take(again);
    const walking = [...this.discoveries.values()].filter((d) => !d.controller.signal.aborted);
    while (walking.length >= this.maxDiscoveries) {
      const oldest = walking.shift();
      if (oldest) take(oldest);
    }
    const discovery: LiveDiscovery = { requestId, controller, operationId };
    this.discoveries.set(requestId, discovery);
    return { discovery, superseded };
  }

  /** A discovery settled: off the list, unless a newer one took its request since. */
  endDiscovery(discovery: LiveDiscovery): void {
    if (this.discoveries.get(discovery.requestId) === discovery) {
      this.discoveries.delete(discovery.requestId);
    }
  }

  /**
   * Keep a run while Production Guard's question waits on a person.
   *
   * @returns Call once the guard has answered.
   */
  awaitGuard(requestId: string, controller: AbortController): () => void {
    this.awaitingGuard.set(requestId, controller);
    return () => {
      if (this.awaitingGuard.get(requestId) === controller) this.awaitingGuard.delete(requestId);
    };
  }

  /** The run handed to the executor, under its request. */
  beginRun(requestId: string, controller: AbortController): void {
    this.run = { requestId, controller };
  }

  /** The run under `requestId` settled. */
  endRun(requestId: string): void {
    if (this.run?.requestId === requestId) this.run = null;
  }

  /**
   * What a stop takes: the operation of the request it names, or — naming
   * none — the one operation under way, never one of several. A discovery it
   * takes is taken off the list and marked stopped.
   *
   * @param requestId - The request of the operation to stop, when named.
   */
  resolve(requestId?: string): StopResolution {
    const target = requestId === undefined ? this.onlyLive() : this.named(requestId);
    if ('refused' in target) return target;
    if (target.kind === 'discovery') {
      this.discoveries.delete(target.discovery.requestId);
      target.discovery.stop = 'stopped';
    }
    return { stops: target };
  }

  /** What answers `requestId`, stopping or not. */
  private named(requestId: string): StopTarget | { refused: 'none' } {
    const discovery = this.discoveries.get(requestId);
    if (discovery) return { kind: 'discovery', discovery };
    const waiting = this.awaitingGuard.get(requestId);
    if (waiting) return { kind: 'awaiting-guard', controller: waiting };
    if (this.run?.requestId === requestId) return { kind: 'run' };
    return { refused: 'none' };
  }

  /**
   * The one operation under way that no stop took yet. A discovery or a run
   * stopped by Live Operations, still settling, is not one: it is stopping.
   */
  private onlyLive(): StopTarget | { refused: 'several'; live: number } | { refused: 'none' } {
    const live: StopTarget[] = [
      ...[...this.discoveries.values()]
        .filter((d) => !d.controller.signal.aborted)
        .map((discovery): StopTarget => ({ kind: 'discovery', discovery })),
      ...[...this.awaitingGuard.values()]
        .filter((c) => !c.signal.aborted)
        .map((controller): StopTarget => ({ kind: 'awaiting-guard', controller })),
      ...(this.run && !this.run.controller.signal.aborted ? [{ kind: 'run' } as const] : []),
    ];
    if (live.length === 0) return { refused: 'none' };
    if (live.length > 1) return { refused: 'several', live: live.length };
    return live[0];
  }
}
