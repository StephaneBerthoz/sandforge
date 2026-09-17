import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DESCRIBE_CACHE_TTL_MS, clearDescribeCache, describeCached } from './describeCache.js';

describe('describeCached', () => {
  beforeEach(() => {
    clearDescribeCache();
  });

  it('asks the org once for the same object', async () => {
    const describe = vi.fn().mockResolvedValue({ fields: [] });

    await describeCached('org-1', 'Account', describe);
    await describeCached('org-1', 'Account', describe);

    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('keeps each org and each object apart', async () => {
    const describe = vi.fn().mockResolvedValue({ fields: [] });

    await describeCached('org-1', 'Account', describe);
    await describeCached('org-2', 'Account', describe);
    await describeCached('org-1', 'Contact', describe);

    expect(describe).toHaveBeenCalledTimes(3);
  });

  it('shares one request between callers asking at the same time', async () => {
    let settle: (value: unknown) => void = () => {};
    const describe = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    const both = Promise.all([
      describeCached('org-1', 'Account', describe),
      describeCached('org-1', 'Account', describe),
    ]);
    settle({ fields: [] });
    await both;

    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('never remembers a failure', async () => {
    // A describe that timed out is the one case where the next caller most
    // needs to reach the org: caching the rejection would end every later run
    // on an error that may already be over.
    const describe = vi
      .fn()
      .mockRejectedValueOnce(new Error('describe-source-Account timed out'))
      .mockResolvedValue({ fields: [] });

    await expect(describeCached('org-1', 'Account', describe)).rejects.toThrow('timed out');
    await expect(describeCached('org-1', 'Account', describe)).resolves.toEqual({ fields: [] });
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it('asks again once the entry is stale', async () => {
    const describe = vi.fn().mockResolvedValue({ fields: [] });
    let now = 1_000;
    const clock = (): number => now;

    await describeCached('org-1', 'Account', describe, clock);
    now += DESCRIBE_CACHE_TTL_MS - 1;
    await describeCached('org-1', 'Account', describe, clock);
    expect(describe).toHaveBeenCalledTimes(1);

    now += 2;
    await describeCached('org-1', 'Account', describe, clock);
    expect(describe).toHaveBeenCalledTimes(2);
  });
});
