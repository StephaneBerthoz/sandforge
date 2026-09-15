import { describe, it, expect, vi } from 'vitest';
import { buildMessage } from './messageHelpers';

const RANDOM_ID = /^wv-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('messageHelpers', () => {
  describe('buildMessage', () => {
    it('should create a message with a random id', () => {
      const msg = buildMessage('org:list');

      expect(msg.id).toMatch(RANDOM_ID);
      expect(msg.type).toBe('org:list');
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it('gives two panels sending at the same instant different ids', async () => {
      // The id used to be the time plus a module counter. Every panel loads its
      // own copy of this module and every reply reaches every panel, so two
      // panels sending their first message in the same millisecond minted the
      // same id — and a sync whose id repeats is refused as a duplicate.
      const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      vi.resetModules();
      const panelA = await import('./messageHelpers');
      vi.resetModules();
      const panelB = await import('./messageHelpers');

      const a = panelA.buildMessage('sync:execute');
      const b = panelB.buildMessage('sync:execute');
      spy.mockRestore();

      expect(a.id).not.toBe(b.id);
    });

    it('should attach payload when provided', () => {
      const msg = buildMessage<{ orgId: string }>('org:disconnect', { orgId: '123' });

      expect(msg.type).toBe('org:disconnect');
      expect((msg as { payload: { orgId: string } }).payload.orgId).toBe('123');
    });

    it('should not have payload when not provided', () => {
      const msg = buildMessage('org:list');

      expect('payload' in msg).toBe(false);
    });
  });
});
