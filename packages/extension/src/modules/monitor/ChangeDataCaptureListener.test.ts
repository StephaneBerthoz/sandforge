import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChangeDataCaptureListener } from './ChangeDataCaptureListener';
import type { CdcEvent, CdcSubscribeFn } from './ChangeDataCaptureListener';

function createMockEvent(overrides?: Partial<CdcEvent>): CdcEvent {
  return {
    entityName: 'Account',
    changeType: 'CREATE',
    recordIds: ['001xx000003DGb1'],
    timestamp: '2026-01-01T10:00:00Z',
    ...overrides,
  };
}

describe('ChangeDataCaptureListener', () => {
  let listener: ChangeDataCaptureListener;
  let subscribe: CdcSubscribeFn;
  let capturedHandlers: Map<string, (event: CdcEvent) => void>;

  beforeEach(() => {
    capturedHandlers = new Map();
    subscribe = vi.fn((channel: string, handler: (event: CdcEvent) => void) => {
      capturedHandlers.set(channel, handler);
      return vi.fn();
    });
    listener = new ChangeDataCaptureListener(subscribe);
  });

  describe('watch', () => {
    it('should subscribe to the CDC channel for a standard entity', () => {
      listener.watch('Account');
      expect(subscribe).toHaveBeenCalledWith(
        '/data/AccountChangeEvent',
        expect.any(Function)
      );
    });

    it('should subscribe to the CDC channel for a custom object', () => {
      listener.watch('MyObject__c');
      expect(subscribe).toHaveBeenCalledWith(
        '/data/MyObject__ChangeEvent',
        expect.any(Function)
      );
    });

    it('should not re-subscribe if already watching an entity', () => {
      listener.watch('Account');
      listener.watch('Account');
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it('should track the entity as watched', () => {
      listener.watch('Account');
      expect(listener.getWatchedEntities()).toContain('Account');
    });
  });

  describe('unwatch', () => {
    it('should call the unsubscribe function', () => {
      const unsub = vi.fn();
      vi.mocked(subscribe).mockReturnValue(unsub);

      listener.watch('Account');
      listener.unwatch('Account');

      expect(unsub).toHaveBeenCalled();
    });

    it('should remove the entity from watched list', () => {
      listener.watch('Account');
      listener.unwatch('Account');
      expect(listener.getWatchedEntities()).not.toContain('Account');
    });

    it('should not throw for an unwatched entity', () => {
      expect(() => listener.unwatch('Unknown')).not.toThrow();
    });
  });

  describe('getWatchedEntities', () => {
    it('should return an empty array initially', () => {
      expect(listener.getWatchedEntities()).toEqual([]);
    });

    it('should return all watched entities', () => {
      listener.watch('Account');
      listener.watch('Contact');
      const entities = listener.getWatchedEntities();
      expect(entities).toContain('Account');
      expect(entities).toContain('Contact');
    });
  });

  describe('getRecentEvents', () => {
    it('should return an empty array when no events received', () => {
      expect(listener.getRecentEvents()).toEqual([]);
    });

    it('should store events received via subscription handler', () => {
      listener.watch('Account');
      const handler = capturedHandlers.get('/data/AccountChangeEvent');
      handler!(createMockEvent());

      expect(listener.getRecentEvents()).toHaveLength(1);
    });

    it('should filter events by entity name when specified', () => {
      listener.watch('Account');
      listener.watch('Contact');

      const accountHandler = capturedHandlers.get('/data/AccountChangeEvent');
      const contactHandler = capturedHandlers.get('/data/ContactChangeEvent');

      accountHandler!(createMockEvent({ entityName: 'Account' }));
      contactHandler!(createMockEvent({ entityName: 'Contact' }));

      expect(listener.getRecentEvents('Account')).toHaveLength(1);
      expect(listener.getRecentEvents('Contact')).toHaveLength(1);
    });

    it('should return all events when no filter is specified', () => {
      listener.watch('Account');
      const handler = capturedHandlers.get('/data/AccountChangeEvent');
      handler!(createMockEvent({ entityName: 'Account' }));
      handler!(createMockEvent({ entityName: 'Account', changeType: 'UPDATE' }));

      expect(listener.getRecentEvents()).toHaveLength(2);
    });

    it('should respect the circular buffer limit of 200 events', () => {
      listener.watch('Account');
      const handler = capturedHandlers.get('/data/AccountChangeEvent');

      for (let i = 0; i < 210; i++) {
        handler!(createMockEvent({ recordIds: [`id-${i}`] }));
      }

      const events = listener.getRecentEvents();
      expect(events).toHaveLength(200);
      expect(events[0].recordIds[0]).toBe('id-10');
    });

    it('should return a copy of events array', () => {
      listener.watch('Account');
      const handler = capturedHandlers.get('/data/AccountChangeEvent');
      handler!(createMockEvent());

      const events1 = listener.getRecentEvents();
      const events2 = listener.getRecentEvents();
      expect(events1).not.toBe(events2);
    });
  });
});
