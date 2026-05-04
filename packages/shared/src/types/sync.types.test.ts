import { describe, it, expect } from 'vitest';
import type {
  SyncConfig,
  SyncObjectConfig,
  SyncObjectResult,
  SyncExecutionResult,
  DeltaResult,
  CDCEvent,
  RealTimeSyncConfig,
  RealTimeSyncMetrics,
  CDCConflict,
  ConflictRecord,
  UIConflict,
  SyncHistoryEntry,
  SyncScheduleEntry,
} from './sync.types.js';
import type { ExportFormat } from './reporting.types.js';

describe('sync.types', () => {
  describe('SyncConfig', () => {
    it('should accept a valid SyncConfig object', () => {
      const config: SyncConfig = {
        id: 'cfg-001',
        name: 'Accounts Full Sync',
        description: 'Synchronize all Account records from prod to sandbox',
        sourceOrgId: 'org-source-001',
        targetOrgId: 'org-target-001',
        direction: 'source_to_target',
        mode: 'full',
        objects: [],
        conflictStrategy: 'source_wins',
        enableRollback: true,
        dryRun: false,
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-01-15T10:00:00Z',
      };

      expect(config.id).toBe('cfg-001');
      expect(config.direction).toBe('source_to_target');
      expect(config.mode).toBe('full');
      expect(config.enableRollback).toBe(true);
      expect(config.dryRun).toBe(false);
    });

    it('should accept optional fields like schedule and scripts', () => {
      const config: SyncConfig = {
        id: 'cfg-002',
        name: 'Incremental Contacts',
        description: 'Nightly incremental sync of Contacts',
        sourceOrgId: 'org-source-002',
        targetOrgId: 'org-target-002',
        direction: 'bidirectional',
        mode: 'incremental',
        objects: [],
        conflictStrategy: 'newest_wins',
        enableRollback: false,
        dryRun: true,
        preScript: 'SELECT Id FROM Account LIMIT 1',
        postScript: 'UPDATE Account SET Status__c = "Synced"',
        schedule: {
          enabled: true,
          cron: '0 2 * * *',
          timezone: 'America/New_York',
          maxRetries: 3,
          notifyOnFailure: true,
        },
        createdAt: '2026-02-01T08:30:00Z',
        updatedAt: '2026-02-10T14:00:00Z',
      };

      expect(config.schedule?.enabled).toBe(true);
      expect(config.preScript).toBeDefined();
      expect(config.postScript).toBeDefined();
    });
  });

  describe('SyncObjectConfig', () => {
    it('should accept a valid SyncObjectConfig with all required fields', () => {
      const objectConfig: SyncObjectConfig = {
        objectApiName: 'Account',
        operation: 'upsert',
        externalIdField: 'External_Id__c',
        fieldMappings: [
          { sourceField: 'Name', targetField: 'Name', type: 'direct' },
          { sourceField: 'Industry', targetField: 'Sector__c', type: 'rename' },
        ],
        transformRules: [{ type: 'uppercase', config: {} }],
        excludedFields: ['CreatedDate', 'LastModifiedDate'],
        addOnFields: [
          { fieldApiName: 'SyncSource__c', value: 'SandForge', overwriteExisting: true },
        ],
        batchSize: 200,
        insertOrder: 1,
        where: "Industry = 'Technology'",
        orderBy: 'Name ASC',
      };

      expect(objectConfig.objectApiName).toBe('Account');
      expect(objectConfig.operation).toBe('upsert');
      expect(objectConfig.fieldMappings).toHaveLength(2);
      expect(objectConfig.addOnFields[0].value).toBe('SandForge');
      expect(objectConfig.batchSize).toBe(200);
    });
  });

  describe('SyncExecutionResult', () => {
    it('should accept a valid SyncExecutionResult with object results', () => {
      const result: SyncExecutionResult = {
        configId: 'cfg-001',
        operationId: 'op-001',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 500,
            success: 498,
            failed: 2,
            skipped: 0,
            conflictCount: 0,
            errors: ['DUPLICATE_VALUE: duplicate found for field External_Id__c'],
          },
        ],
        totalProcessed: 500,
        totalSuccess: 498,
        totalFailed: 2,
        totalSkipped: 0,
        duration: 12500,
        timestamp: '2026-02-15T16:30:00Z',
      };

      expect(result.status).toBe('success');
      expect(result.totalProcessed).toBe(500);
      expect(result.objectResults).toHaveLength(1);
      expect(result.objectResults[0].errors).toHaveLength(1);
    });

    it('should accept partial and failure statuses', () => {
      const failedResult: SyncExecutionResult = {
        configId: 'cfg-003',
        operationId: 'op-003',
        status: 'failure',
        objectResults: [],
        totalProcessed: 0,
        totalSuccess: 0,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 150,
        timestamp: '2026-02-15T17:00:00Z',
      };

      expect(failedResult.status).toBe('failure');
      expect(failedResult.totalProcessed).toBe(0);
    });
  });

  describe('DeltaResult', () => {
    it('should accept a valid DeltaResult with change counts', () => {
      const delta: DeltaResult = {
        objectApiName: 'Contact',
        newRecords: 25,
        modifiedRecords: 143,
        deletedRecords: 3,
        unchangedRecords: 8420,
        lastSyncTimestamp: '2026-02-14T22:00:00Z',
      };

      expect(delta.objectApiName).toBe('Contact');
      expect(delta.newRecords).toBe(25);
      expect(delta.modifiedRecords).toBe(143);
      expect(delta.deletedRecords).toBe(3);
      expect(delta.unchangedRecords).toBe(8420);
      expect(delta.lastSyncTimestamp).toBeDefined();
    });

    it('should accept a DeltaResult without optional lastSyncTimestamp', () => {
      const delta: DeltaResult = {
        objectApiName: 'Opportunity',
        newRecords: 0,
        modifiedRecords: 0,
        deletedRecords: 0,
        unchangedRecords: 1500,
      };

      expect(delta.lastSyncTimestamp).toBeUndefined();
      expect(delta.unchangedRecords).toBe(1500);
    });
  });

  describe('CDCEvent', () => {
    it('should accept a valid CDCEvent with all required fields', () => {
      const event: CDCEvent = {
        replayId: 42,
        objectApiName: 'Account',
        changeType: 'UPDATE',
        recordIds: ['001xx0000001234'],
        changedFields: { Name: 'Acme Corp', Industry: 'Technology' },
        commitTimestamp: '2026-03-13T10:00:00Z',
        commitUser: '005xx0000001111',
        transactionKey: 'txn-abc-123',
      };

      expect(event.replayId).toBe(42);
      expect(event.changeType).toBe('UPDATE');
      expect(event.recordIds).toHaveLength(1);
      expect(event.changedFields.Name).toBe('Acme Corp');
    });

    it('should support all CDC change types', () => {
      const types: CDCEvent['changeType'][] = ['CREATE', 'UPDATE', 'DELETE', 'UNDELETE'];
      for (const changeType of types) {
        const event: CDCEvent = {
          replayId: 1,
          objectApiName: 'Contact',
          changeType,
          recordIds: ['003xx0000001111'],
          changedFields: {},
          commitTimestamp: '2026-03-13T10:00:00Z',
          commitUser: '005xx0000001111',
          transactionKey: 'txn-001',
        };
        expect(event.changeType).toBe(changeType);
      }
    });
  });

  describe('RealTimeSyncConfig', () => {
    it('should accept a valid RealTimeSyncConfig', () => {
      const config: RealTimeSyncConfig = {
        sessionId: 'session-001',
        sourceOrgId: 'org-source-001',
        targetOrgId: 'org-target-001',
        watchedObjects: ['Account', 'Contact'],
        conflictStrategy: 'source_wins',
        flushIntervalMs: 5000,
        maxBatchSize: 100,
      };

      expect(config.sessionId).toBe('session-001');
      expect(config.watchedObjects).toHaveLength(2);
      expect(config.flushIntervalMs).toBe(5000);
    });
  });

  describe('RealTimeSyncMetrics', () => {
    it('should accept a valid RealTimeSyncMetrics with all fields', () => {
      const metrics: RealTimeSyncMetrics = {
        eventsReceived: 150,
        eventsApplied: 145,
        eventsFailed: 5,
        eventsPerMinute: 30,
        averageLagMs: 250,
        currentLagMs: 100,
        errorRate: 3.3,
        startedAt: '2026-03-13T09:00:00Z',
        lastEventAt: '2026-03-13T09:05:00Z',
      };

      expect(metrics.eventsReceived).toBe(150);
      expect(metrics.errorRate).toBe(3.3);
      expect(metrics.lastEventAt).toBeDefined();
    });

    it('should accept metrics without optional lastEventAt', () => {
      const metrics: RealTimeSyncMetrics = {
        eventsReceived: 0,
        eventsApplied: 0,
        eventsFailed: 0,
        eventsPerMinute: 0,
        averageLagMs: 0,
        currentLagMs: 0,
        errorRate: 0,
        startedAt: '2026-03-13T09:00:00Z',
      };

      expect(metrics.lastEventAt).toBeUndefined();
    });
  });

  describe('CDCConflict', () => {
    it('should accept a valid CDCConflict', () => {
      const conflict: CDCConflict = {
        event: {
          replayId: 42,
          objectApiName: 'Account',
          changeType: 'UPDATE',
          recordIds: ['001xx0000001234'],
          changedFields: { Name: 'New Name' },
          commitTimestamp: '2026-03-13T10:00:00Z',
          commitUser: '005xx0000001111',
          transactionKey: 'txn-abc-123',
        },
        targetValues: { Name: 'Old Name', LastModifiedDate: '2026-03-13T10:01:00Z' },
        targetLastModified: '2026-03-13T10:01:00Z',
        resolved: false,
      };

      expect(conflict.resolved).toBe(false);
      expect(conflict.resolution).toBeUndefined();
    });

    it('should accept a resolved conflict with strategy', () => {
      const conflict: CDCConflict = {
        event: {
          replayId: 43,
          objectApiName: 'Contact',
          changeType: 'UPDATE',
          recordIds: ['003xx0000001111'],
          changedFields: { Email: 'new@example.com' },
          commitTimestamp: '2026-03-13T10:00:00Z',
          commitUser: '005xx0000001111',
          transactionKey: 'txn-def-456',
        },
        targetValues: { Email: 'old@example.com' },
        targetLastModified: '2026-03-13T10:01:00Z',
        resolved: true,
        resolution: 'source_wins',
      };

      expect(conflict.resolved).toBe(true);
      expect(conflict.resolution).toBe('source_wins');
    });
  });

  describe('SyncHistoryEntry', () => {
    it('should accept a valid SyncHistoryEntry with all required fields', () => {
      const entry: SyncHistoryEntry = {
        id: 'hist-001',
        configSnapshot: {
          id: 'cfg-001',
          name: 'Account Sync',
          description: 'Sync accounts',
          sourceOrgId: 'org-src',
          targetOrgId: 'org-tgt',
          direction: 'source_to_target',
          mode: 'full',
          objects: [],
          conflictStrategy: 'source_wins',
          enableRollback: false,
          dryRun: false,
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
        },
        result: {
          configId: 'cfg-001',
          operationId: 'op-001',
          status: 'success',
          objectResults: [],
          totalProcessed: 100,
          totalSuccess: 100,
          totalFailed: 0,
          totalSkipped: 0,
          duration: 5000,
          timestamp: '2026-03-15T10:00:05Z',
        },
        startTime: '2026-03-15T10:00:00Z',
        endTime: '2026-03-15T10:00:05Z',
        triggeredBy: 'manual',
      };

      expect(entry.id).toBe('hist-001');
      expect(entry.triggeredBy).toBe('manual');
      expect(entry.scheduleId).toBeUndefined();
    });

    it('should accept a schedule-triggered entry with scheduleId', () => {
      const entry: SyncHistoryEntry = {
        id: 'hist-002',
        configSnapshot: {
          id: 'cfg-002',
          name: 'Nightly Sync',
          description: 'Scheduled nightly',
          sourceOrgId: 'org-src',
          targetOrgId: 'org-tgt',
          direction: 'source_to_target',
          mode: 'incremental',
          objects: [],
          conflictStrategy: 'newest_wins',
          enableRollback: false,
          dryRun: false,
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
        },
        result: {
          configId: 'cfg-002',
          operationId: 'op-002',
          status: 'partial',
          objectResults: [],
          totalProcessed: 50,
          totalSuccess: 45,
          totalFailed: 5,
          totalSkipped: 0,
          duration: 3000,
          timestamp: '2026-03-15T02:00:03Z',
        },
        startTime: '2026-03-15T02:00:00Z',
        endTime: '2026-03-15T02:00:03Z',
        triggeredBy: 'schedule',
        scheduleId: 'sched-001',
      };

      expect(entry.triggeredBy).toBe('schedule');
      expect(entry.scheduleId).toBe('sched-001');
    });

    it('should support rerun triggeredBy', () => {
      const entry: SyncHistoryEntry = {
        id: 'hist-003',
        configSnapshot: {
          id: 'cfg-001',
          name: 'Re-run',
          description: 'Re-run from history',
          sourceOrgId: 'org-src',
          targetOrgId: 'org-tgt',
          direction: 'source_to_target',
          mode: 'full',
          objects: [],
          conflictStrategy: 'source_wins',
          enableRollback: false,
          dryRun: false,
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
        },
        result: {
          configId: 'cfg-001',
          operationId: 'op-003',
          status: 'success',
          objectResults: [],
          totalProcessed: 200,
          totalSuccess: 200,
          totalFailed: 0,
          totalSkipped: 0,
          duration: 8000,
          timestamp: '2026-03-15T12:00:08Z',
        },
        startTime: '2026-03-15T12:00:00Z',
        endTime: '2026-03-15T12:00:08Z',
        triggeredBy: 'rerun',
      };

      expect(entry.triggeredBy).toBe('rerun');
    });
  });

  describe('SyncScheduleEntry', () => {
    it('should accept a valid SyncScheduleEntry with all required fields', () => {
      const schedule: SyncScheduleEntry = {
        id: 'sched-001',
        name: 'Nightly Account Sync',
        configId: 'cfg-001',
        cron: '0 2 * * *',
        timezone: 'America/New_York',
        enabled: true,
        maxRetries: 3,
        notifyOnComplete: false,
        notifyOnFailure: true,
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-15T00:00:00Z',
        version: 1,
      };

      expect(schedule.id).toBe('sched-001');
      expect(schedule.cron).toBe('0 2 * * *');
      expect(schedule.enabled).toBe(true);
      expect(schedule.version).toBe(1);
    });

    it('should accept optional runtime fields', () => {
      const schedule: SyncScheduleEntry = {
        id: 'sched-002',
        name: 'Weekly Contacts Sync',
        configId: 'cfg-002',
        cron: '0 3 * * 0',
        timezone: 'Europe/Paris',
        enabled: false,
        maxRetries: 1,
        notifyOnComplete: true,
        notifyOnFailure: true,
        nextRunAt: '2026-03-22T03:00:00Z',
        lastRunAt: '2026-03-15T03:00:00Z',
        lastResult: 'success',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-15T03:01:00Z',
        version: 1,
      };

      expect(schedule.nextRunAt).toBeDefined();
      expect(schedule.lastRunAt).toBeDefined();
      expect(schedule.lastResult).toBe('success');
    });

    it('should support all lastResult values', () => {
      const results: SyncScheduleEntry['lastResult'][] = ['success', 'partial', 'failure'];
      for (const result of results) {
        const schedule: SyncScheduleEntry = {
          id: 'sched-003',
          name: 'Test',
          configId: 'cfg-003',
          cron: '0 0 * * *',
          timezone: 'UTC',
          enabled: true,
          maxRetries: 0,
          notifyOnComplete: false,
          notifyOnFailure: false,
          lastResult: result,
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-01T00:00:00Z',
          version: 1,
        };
        expect(schedule.lastResult).toBe(result);
      }
    });
  });

  describe('UIConflict', () => {
    it('should accept a valid UIConflict with all required fields', () => {
      const conflict: UIConflict = {
        id: 'Account:001xx:2026-03-27T10:00:00Z',
        objectApiName: 'Account',
        recordId: '001xx0000001234',
        conflictType: 'edit/edit',
        sourceValues: { Name: 'Source' },
        targetValues: { Name: 'Target' },
        conflictFields: ['Name'],
        timestamp: '2026-03-27T10:00:00Z',
        resolved: false,
      };

      expect(conflict.id).toBe('Account:001xx:2026-03-27T10:00:00Z');
      expect(conflict.conflictType).toBe('edit/edit');
      expect(conflict.resolved).toBe(false);
      expect(conflict.resolution).toBeUndefined();
      expect(conflict.baseValues).toBeUndefined();
      expect(conflict.fieldResolutions).toBeUndefined();
    });

    it('should accept a resolved UIConflict with baseValues and fieldResolutions', () => {
      const conflict: UIConflict = {
        id: 'Contact:003xx:2026-03-27T10:00:00Z',
        objectApiName: 'Contact',
        recordId: '003xx0000001111',
        conflictType: 'edit/edit',
        sourceValues: { Email: 'src@example.com' },
        targetValues: { Email: 'tgt@example.com' },
        baseValues: { Email: 'base@example.com' },
        conflictFields: ['Email'],
        timestamp: '2026-03-27T10:00:00Z',
        resolved: true,
        resolution: 'manual',
        fieldResolutions: {
          Email: { value: 'chosen@example.com', source: 'manual' },
        },
      };

      expect(conflict.baseValues).toBeDefined();
      expect(conflict.fieldResolutions?.Email.source).toBe('manual');
    });
  });

  describe('SyncObjectResult extended', () => {
    it('should include conflictCount field', () => {
      const result: SyncObjectResult = {
        objectApiName: 'Account',
        operation: 'upsert',
        processed: 100,
        success: 95,
        failed: 5,
        skipped: 0,
        conflictCount: 3,
        errors: [],
      };

      expect(result.conflictCount).toBe(3);
    });
  });

  describe('ConflictRecord extended', () => {
    it('should accept optional baseValues field', () => {
      const record: ConflictRecord = {
        objectApiName: 'Account',
        recordId: '001xx',
        sourceValues: { Name: 'Src' },
        targetValues: { Name: 'Tgt' },
        baseValues: { Name: 'Base' },
        conflictFields: ['Name'],
      };

      expect(record.baseValues).toEqual({ Name: 'Base' });
    });

    it('should work without baseValues', () => {
      const record: ConflictRecord = {
        objectApiName: 'Account',
        recordId: '001xx',
        sourceValues: { Name: 'Src' },
        targetValues: { Name: 'Tgt' },
        conflictFields: ['Name'],
      };

      expect(record.baseValues).toBeUndefined();
    });
  });

  describe('ExportFormat', () => {
    it('should accept csv and json values', () => {
      const csv: ExportFormat = 'csv';
      const json: ExportFormat = 'json';
      expect(csv).toBe('csv');
      expect(json).toBe('json');
    });
  });
});
