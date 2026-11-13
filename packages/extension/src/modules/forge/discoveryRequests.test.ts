import { describe, expect, it } from 'vitest';
import { countingDiscovery, discoveryRequestSent, discoveryRequestsOf } from './discoveryRequests';

describe('countingDiscovery', () => {
  it('counts for a discovery the requests its reads send, by org, and none another discovery sends meanwhile', async () => {
    const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const first = countingDiscovery(async () => {
      discoveryRequestSent('SRC');
      await later(5);
      discoveryRequestSent('SRC', 2);
      discoveryRequestSent('TGT');
      return 'first';
    });
    const second = countingDiscovery(async () => {
      await later(1);
      discoveryRequestSent('SRC', 10);
      return 'second';
    });

    const [a, b] = await Promise.all([first, second]);

    expect(a.result).toBe('first');
    expect([...a.sent]).toEqual([
      ['SRC', 3],
      ['TGT', 1],
    ]);
    expect([...b.sent]).toEqual([['SRC', 10]]);
  });

  it('counts nothing for a read sent outside any discovery', async () => {
    discoveryRequestSent('SRC');
    const { sent } = await countingDiscovery(async () => undefined);
    expect(sent.size).toBe(0);
  });
});

describe('discoveryRequestsOf', () => {
  const orgs = { sourceOrgId: 'SRC', targetOrgId: 'TGT' };

  it('says what each of the run’s two orgs was sent, and nothing for a discovery that sent nothing', () => {
    expect(discoveryRequestsOf(new Map([['SRC', 12]]), orgs)).toEqual({ source: 12, target: 0 });
    expect(
      discoveryRequestsOf(
        new Map([
          ['SRC', 240],
          ['TGT', 6],
        ]),
        orgs,
      ),
    ).toEqual({ source: 240, target: 6 });
    expect(discoveryRequestsOf(new Map(), orgs)).toBeUndefined();
  });
});
