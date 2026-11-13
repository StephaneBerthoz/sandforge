import { describe, expect, it, vi } from 'vitest';
import {
  COPY_SANDBOX,
  copySandboxRefusal,
  DEVELOPER_PRO_DATA_STORAGE_MB,
} from './emptyCopySandbox';

/** `/limits` as an org answers them, its data storage `max` MB. */
function limitsOf(max: number): () => Promise<unknown> {
  return async () => ({
    DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
    DataStorageMB: { Max: max, Remaining: max },
  });
}

describe('copySandboxRefusal', () => {
  it('refuses the whole of a sandbox past a Developer Pro’s data storage — a Partial Copy holds 5 GB, a Full sandbox production’s — sending to the panel, which knows the Staging mark, or to --objects', async () => {
    for (const max of [5_120, 51_200]) {
      const refusal = await copySandboxRefusal({
        target: 'UAT',
        orgType: 'Sandbox',
        limits: limitsOf(max),
      });

      expect(refusal?.code).toBe(COPY_SANDBOX);
      expect(refusal?.message).toContain(`UAT is a Partial Copy or Full sandbox`);
      expect(refusal?.message).toContain(`${max.toLocaleString('en-US')} MB`);
      expect(refusal?.message).toContain('DataOps Cleanup in the panel');
      expect(refusal?.message).toContain('--objects');
      expect(refusal?.message).toContain('No record was read or deleted.');
    }
  });

  it('lets a Developer or Developer Pro sandbox, and a scratch org, be emptied whole', async () => {
    for (const max of [200, 500, DEVELOPER_PRO_DATA_STORAGE_MB]) {
      await expect(
        copySandboxRefusal({ target: 'DEV', orgType: 'Sandbox', limits: limitsOf(max) }),
      ).resolves.toBeUndefined();
    }
  });

  it('refuses a sandbox whose data storage it cannot read, in the org’s words: it cannot be told from a copy', async () => {
    const refusal = await copySandboxRefusal({
      target: 'UAT',
      orgType: 'Sandbox',
      limits: async () => {
        throw new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.');
      },
    });
    const silent = await copySandboxRefusal({
      target: 'UAT',
      orgType: 'Sandbox',
      limits: async () => ({ DailyApiRequests: { Max: 15_000, Remaining: 14_000 } }),
    });

    expect(refusal?.code).toBe(COPY_SANDBOX);
    expect(refusal?.message).toContain('REQUEST_LIMIT_EXCEEDED');
    expect(silent?.code).toBe(COPY_SANDBOX);
  });

  it('reads nothing of an org that is no sandbox: a Developer Edition is emptied whole as before', async () => {
    const limits = vi.fn(limitsOf(5));

    await expect(
      copySandboxRefusal({ target: 'DE', orgType: 'Developer', limits }),
    ).resolves.toBeUndefined();
    expect(limits).not.toHaveBeenCalled();
  });
});
