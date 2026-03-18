import { describe, it, expect } from 'vitest';
import type {
  BaseMessage,
  OperationProgress,
  NotificationMessage,
  GrappeStarted,
  RealTimeStartRequest,
  RealTimeStopRequest,
  RealTimeStartedResponse,
  RealTimeCDCEventMessage,
  RealTimeMetricsResponse,
  RealTimeConflictDetected,
} from './messages.types.js';

describe('messages.types', () => {
  describe('BaseMessage', () => {
    it('should accept a valid BaseMessage with id, type, and timestamp', () => {
      const message: BaseMessage = {
        id: 'msg-001',
        type: 'test:message',
        timestamp: Date.now(),
      };

      expect(message.id).toBe('msg-001');
      expect(message.type).toBe('test:message');
      expect(typeof message.timestamp).toBe('number');
    });

    it('should use numeric timestamps for all messages', () => {
      const now = 1740052800000;
      const message: BaseMessage = {
        id: 'msg-002',
        type: 'custom:event',
        timestamp: now,
      };

      expect(message.timestamp).toBe(1740052800000);
    });

    it('should accept an optional correlationId linking response to request', () => {
      const response: BaseMessage = {
        id: 'resp-001',
        type: 'org:list:response',
        timestamp: Date.now(),
        correlationId: 'req-001',
      };

      expect(response.correlationId).toBe('req-001');
    });

    it('should allow correlationId to be omitted', () => {
      const message: BaseMessage = {
        id: 'msg-003',
        type: 'test:message',
        timestamp: Date.now(),
      };

      expect(message.correlationId).toBeUndefined();
    });
  });

  describe('OperationProgress', () => {
    it('should extend BaseMessage with operation:progress type and payload', () => {
      const progress: OperationProgress = {
        id: 'msg-progress-001',
        type: 'operation:progress',
        timestamp: Date.now(),
        payload: {
          operationId: 'op-seed-001',
          percentage: 45,
          processedRecords: 450,
          totalRecords: 1000,
          currentStep: 'Inserting Account records',
        },
      };

      expect(progress.type).toBe('operation:progress');
      expect(progress.payload.operationId).toBe('op-seed-001');
      expect(progress.payload.percentage).toBe(45);
      expect(progress.payload.processedRecords).toBe(450);
      expect(progress.payload.totalRecords).toBe(1000);
      expect(progress.payload.currentStep).toBe('Inserting Account records');
    });

    it('should represent completed progress with 100 percentage', () => {
      const completed: OperationProgress = {
        id: 'msg-progress-002',
        type: 'operation:progress',
        timestamp: Date.now(),
        payload: {
          operationId: 'op-sync-042',
          percentage: 100,
          processedRecords: 2000,
          totalRecords: 2000,
          currentStep: 'Finalizing',
        },
      };

      expect(completed.payload.percentage).toBe(100);
      expect(completed.payload.processedRecords).toBe(completed.payload.totalRecords);
    });
  });

  describe('NotificationMessage', () => {
    it('should extend BaseMessage with notification type and required payload fields', () => {
      const notification: NotificationMessage = {
        id: 'msg-notif-001',
        type: 'notification',
        timestamp: Date.now(),
        payload: {
          level: 'success',
          title: 'Seed Complete',
          message: 'Successfully seeded 500 records into sandbox.',
        },
      };

      expect(notification.type).toBe('notification');
      expect(notification.payload.level).toBe('success');
      expect(notification.payload.title).toBe('Seed Complete');
      expect(notification.payload.actions).toBeUndefined();
      expect(notification.payload.autoDismissMs).toBeUndefined();
    });

    it('should accept optional actions and autoDismissMs', () => {
      const notification: NotificationMessage = {
        id: 'msg-notif-002',
        type: 'notification',
        timestamp: Date.now(),
        payload: {
          level: 'error',
          title: 'Sync Failed',
          message: 'API limit exceeded during sync operation.',
          actions: [
            { label: 'Retry', command: 'sync:retry' },
            { label: 'View Logs', command: 'logs:open', args: { module: 'sync' } },
          ],
          autoDismissMs: 10000,
        },
      };

      expect(notification.payload.level).toBe('error');
      expect(notification.payload.actions).toHaveLength(2);
      expect(notification.payload.actions?.[0].label).toBe('Retry');
      expect(notification.payload.actions?.[1].args).toEqual({ module: 'sync' });
      expect(notification.payload.autoDismissMs).toBe(10000);
    });
  });

  describe('GrappeStarted', () => {
    it('should extend BaseMessage with grappe:started type and partition info', () => {
      const grappeStarted: GrappeStarted = {
        id: 'msg-grappe-001',
        type: 'grappe:started',
        timestamp: Date.now(),
        payload: {
          operationId: 'op-bulk-001',
          totalPartitions: 8,
          totalRecords: 50000,
        },
      };

      expect(grappeStarted.type).toBe('grappe:started');
      expect(grappeStarted.payload.operationId).toBe('op-bulk-001');
      expect(grappeStarted.payload.totalPartitions).toBe(8);
      expect(grappeStarted.payload.totalRecords).toBe(50000);
    });

    it('should allow single-partition grappe operations', () => {
      const singlePartition: GrappeStarted = {
        id: 'msg-grappe-002',
        type: 'grappe:started',
        timestamp: Date.now(),
        payload: {
          operationId: 'op-small-001',
          totalPartitions: 1,
          totalRecords: 150,
        },
      };

      expect(singlePartition.payload.totalPartitions).toBe(1);
      expect(singlePartition.payload.totalRecords).toBe(150);
    });
  });

  describe('RealTimeStartRequest', () => {
    it('should accept a valid start request with all fields', () => {
      const request: RealTimeStartRequest = {
        id: 'msg-rt-001',
        type: 'realtime:start',
        timestamp: Date.now(),
        payload: {
          sourceOrgId: 'org-src-001',
          targetOrgId: 'org-tgt-001',
          watchedObjects: ['Account', 'Contact'],
          conflictStrategy: 'source_wins',
          flushIntervalMs: 5000,
          maxBatchSize: 100,
        },
      };

      expect(request.type).toBe('realtime:start');
      expect(request.payload.watchedObjects).toHaveLength(2);
      expect(request.payload.flushIntervalMs).toBe(5000);
    });
  });

  describe('RealTimeStopRequest', () => {
    it('should accept a valid stop request', () => {
      const request: RealTimeStopRequest = {
        id: 'msg-rt-002',
        type: 'realtime:stop',
        timestamp: Date.now(),
        payload: { sessionId: 'session-001' },
      };

      expect(request.type).toBe('realtime:stop');
      expect(request.payload.sessionId).toBe('session-001');
    });
  });

  describe('RealTimeStartedResponse', () => {
    it('should accept a valid started response', () => {
      const response: RealTimeStartedResponse = {
        id: 'msg-rt-003',
        type: 'realtime:started',
        timestamp: Date.now(),
        payload: {
          sessionId: 'session-001',
          watchedObjects: ['Account', 'Contact'],
        },
      };

      expect(response.type).toBe('realtime:started');
      expect(response.payload.sessionId).toBe('session-001');
    });
  });

  describe('RealTimeCDCEventMessage', () => {
    it('should accept a successful event message', () => {
      const event: RealTimeCDCEventMessage = {
        id: 'msg-rt-004',
        type: 'realtime:event',
        timestamp: Date.now(),
        payload: {
          replayId: 42,
          objectApiName: 'Account',
          changeType: 'UPDATE',
          recordIds: ['001xx0000001234'],
          commitTimestamp: '2026-03-13T10:00:00Z',
          applied: true,
        },
      };

      expect(event.type).toBe('realtime:event');
      expect(event.payload.applied).toBe(true);
      expect(event.payload.error).toBeUndefined();
    });

    it('should accept a failed event message with error', () => {
      const event: RealTimeCDCEventMessage = {
        id: 'msg-rt-005',
        type: 'realtime:event',
        timestamp: Date.now(),
        payload: {
          replayId: 43,
          objectApiName: 'Contact',
          changeType: 'CREATE',
          recordIds: ['003xx0000001111'],
          commitTimestamp: '2026-03-13T10:00:00Z',
          applied: false,
          error: 'FIELD_INTEGRITY_EXCEPTION',
        },
      };

      expect(event.payload.applied).toBe(false);
      expect(event.payload.error).toBe('FIELD_INTEGRITY_EXCEPTION');
    });
  });

  describe('RealTimeMetricsResponse', () => {
    it('should accept a valid metrics response', () => {
      const metrics: RealTimeMetricsResponse = {
        id: 'msg-rt-006',
        type: 'realtime:metrics:response',
        timestamp: Date.now(),
        payload: {
          eventsReceived: 150,
          eventsApplied: 145,
          eventsFailed: 5,
          eventsPerMinute: 30,
          averageLagMs: 250,
          currentLagMs: 100,
          errorRate: 3.3,
          startedAt: '2026-03-13T09:00:00Z',
          lastEventAt: '2026-03-13T09:05:00Z',
        },
      };

      expect(metrics.type).toBe('realtime:metrics:response');
      expect(metrics.payload.eventsReceived).toBe(150);
      expect(metrics.payload.errorRate).toBe(3.3);
    });
  });

  describe('RealTimeConflictDetected', () => {
    it('should accept a valid conflict event', () => {
      const conflict: RealTimeConflictDetected = {
        id: 'msg-rt-007',
        type: 'realtime:conflict',
        timestamp: Date.now(),
        payload: {
          replayId: 42,
          objectApiName: 'Account',
          recordIds: ['001xx0000001234'],
          changeType: 'UPDATE',
          sourceValues: { Name: 'New Name' },
          targetValues: { Name: 'Old Name' },
          targetLastModified: '2026-03-13T10:01:00Z',
        },
      };

      expect(conflict.type).toBe('realtime:conflict');
      expect(conflict.payload.sourceValues).toEqual({ Name: 'New Name' });
      expect(conflict.payload.targetValues).toEqual({ Name: 'Old Name' });
    });
  });
});
