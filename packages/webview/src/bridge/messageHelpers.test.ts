import { describe, it, expect, beforeEach } from 'vitest';
import { buildMessage, resetMessageCounter } from './messageHelpers';

describe('messageHelpers', () => {
  beforeEach(() => {
    resetMessageCounter();
  });

  describe('buildMessage', () => {
    it('should create a message with auto-generated id', () => {
      const msg = buildMessage('org:list');

      expect(msg.id).toMatch(/^wv-\d+-1$/);
      expect(msg.type).toBe('org:list');
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it('should increment the id counter', () => {
      const msg1 = buildMessage('org:list');
      const msg2 = buildMessage('settings:get');

      expect(msg1.id).toMatch(/^wv-\d+-1$/);
      expect(msg2.id).toMatch(/^wv-\d+-2$/);
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

    it('should reset counter correctly', () => {
      buildMessage('test');
      buildMessage('test');
      resetMessageCounter();
      const msg = buildMessage('test');

      expect(msg.id).toMatch(/^wv-\d+-1$/);
    });
  });
});
