import { describe, it, expect } from 'vitest';
import { ForgeStops, MAX_DISCOVERIES } from './ForgeStops.js';

describe('ForgeStops', () => {
  it('takes the discovery a stop names, and marks it stopped', () => {
    const stops = new ForgeStops();
    const { discovery } = stops.beginDiscovery('wv-a', new AbortController(), 'forge-discover-1');
    stops.beginDiscovery('wv-b', new AbortController(), 'forge-discover-2');

    expect(stops.resolve('wv-a')).toEqual({ stops: { kind: 'discovery', discovery } });
    expect(discovery.stop).toBe('stopped');
    // Taken once: a second stop of it finds nothing.
    expect(stops.resolve('wv-a')).toEqual({ refused: 'none' });
  });

  it('takes a run waiting on the guard by its request, and lets go of it once the guard answered', () => {
    const stops = new ForgeStops();
    const waiting = new AbortController();
    const answered = stops.awaitGuard('wv-run', waiting);

    expect(stops.resolve('wv-run')).toEqual({
      stops: { kind: 'awaiting-guard', controller: waiting },
    });
    answered();
    expect(stops.resolve('wv-run')).toEqual({ refused: 'none' });
  });

  it('takes the run under way by its request, until it ends', () => {
    const stops = new ForgeStops();
    stops.beginRun('wv-run', new AbortController());

    expect(stops.resolve('wv-run')).toEqual({ stops: { kind: 'run' } });
    stops.endRun('wv-run');
    expect(stops.resolve('wv-run')).toEqual({ refused: 'none' });
  });

  it('keeps every discovery up to the number walked at once, then supersedes the oldest', () => {
    const stops = new ForgeStops();
    const begun = Array.from({ length: MAX_DISCOVERIES }, (_unused, i) =>
      stops.beginDiscovery(`wv-${i}`, new AbortController(), `forge-discover-${i}`),
    );
    expect(begun.every(({ superseded }) => superseded.length === 0)).toBe(true);

    const { superseded } = stops.beginDiscovery(
      'wv-new',
      new AbortController(),
      'forge-discover-n',
    );

    expect(superseded).toEqual([begun[0].discovery]);
    expect(begun[0].discovery.stop).toBe('superseded');
    expect(stops.resolve('wv-0')).toEqual({ refused: 'none' });
  });

  it('supersedes a discovery sent again under the same request', () => {
    const stops = new ForgeStops();
    const first = stops.beginDiscovery('wv-a', new AbortController(), 'forge-discover-1');
    const again = stops.beginDiscovery('wv-a', new AbortController(), 'forge-discover-2');

    expect(again.superseded).toEqual([first.discovery]);
    // The first settling leaves the second under the request.
    stops.endDiscovery(first.discovery);
    expect(stops.resolve('wv-a')).toEqual({
      stops: { kind: 'discovery', discovery: again.discovery },
    });
  });

  it('counts a discovery Live Operations stopped as stopping, not against the number walked at once', () => {
    const stops = new ForgeStops(2);
    const cancelled = new AbortController();
    stops.beginDiscovery('wv-a', cancelled, 'forge-discover-1');
    stops.beginDiscovery('wv-b', new AbortController(), 'forge-discover-2');
    cancelled.abort();

    expect(
      stops.beginDiscovery('wv-c', new AbortController(), 'forge-discover-3').superseded,
    ).toEqual([]);
  });

  describe('a stop that names nothing', () => {
    it('takes the one operation under way', () => {
      const stops = new ForgeStops();
      stops.beginRun('wv-run', new AbortController());

      expect(stops.resolve()).toEqual({ stops: { kind: 'run' } });
    });

    it('is refused while several are under way, counting each', () => {
      const stops = new ForgeStops();
      stops.beginRun('wv-run', new AbortController());
      stops.beginDiscovery('wv-a', new AbortController(), 'forge-discover-1');
      stops.awaitGuard('wv-run-b', new AbortController());

      expect(stops.resolve()).toEqual({ refused: 'several', live: 3 });
    });

    it('leaves out what is stopping already', () => {
      const stops = new ForgeStops();
      const stopping = new AbortController();
      stops.beginRun('wv-run', stopping);
      stopping.abort();
      const { discovery } = stops.beginDiscovery('wv-a', new AbortController(), 'forge-discover-1');

      expect(stops.resolve()).toEqual({ stops: { kind: 'discovery', discovery } });
    });

    it('finds nothing when nothing is under way', () => {
      expect(new ForgeStops().resolve()).toEqual({ refused: 'none' });
    });
  });
});
