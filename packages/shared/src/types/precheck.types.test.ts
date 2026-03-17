import { describe, it, expect } from 'vitest';
import type {
  PreCheckResult,
  PreCheckItem,
  PreCheckEstimations,
  ConfirmationItem,
} from './precheck.types.js';

describe('precheck.types', () => {
  describe('PreCheckResult', () => {
    it('should accept a passing PreCheckResult with all required fields', () => {
      const check: PreCheckItem = {
        id: 'chk-perm-001',
        category: 'permissions',
        name: 'CRUD Access',
        description: 'Verify CRUD permissions on Account',
        severity: 'info',
        passed: true,
        message: 'All CRUD permissions granted.',
        autoFixable: false,
      };

      const estimations: PreCheckEstimations = {
        duration: 30000,
        apiCalls: 250,
        dataStorageImpact: 1024,
        fileStorageImpact: 0,
        bulkJobs: 2,
        grappeRecommendation: false,
      };

      const result: PreCheckResult = {
        status: 'pass',
        score: 100,
        checks: [check],
        estimations,
        canProceed: true,
        requiresConfirmation: [],
        autoFixable: [],
      };

      expect(result.status).toBe('pass');
      expect(result.score).toBe(100);
      expect(result.canProceed).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.requiresConfirmation).toHaveLength(0);
      expect(result.autoFixable).toHaveLength(0);
    });

    it('should accept a failing PreCheckResult with confirmations and auto-fixable items', () => {
      const failedCheck: PreCheckItem = {
        id: 'chk-schema-001',
        category: 'schema',
        name: 'Field Existence',
        description: 'Verify target fields exist in sandbox',
        severity: 'error',
        passed: false,
        message: 'Missing field Custom__c on Account.',
        autoFixable: true,
        fixDescription: 'Create the missing field via Metadata API.',
      };

      const warningCheck: PreCheckItem = {
        id: 'chk-api-001',
        category: 'api_limits',
        name: 'API Usage',
        description: 'Verify sufficient API calls remaining',
        severity: 'warning',
        passed: true,
        message: 'API calls at 75% capacity.',
        autoFixable: false,
      };

      const confirmation: ConfirmationItem = {
        title: 'Production Org Detected',
        description: 'This operation targets a production org. Proceed with caution.',
        severity: 'warning',
        requiresTypedConfirmation: true,
        confirmationText: 'I understand the risks',
      };

      const result: PreCheckResult = {
        status: 'fail',
        score: 45,
        checks: [failedCheck, warningCheck],
        estimations: {
          duration: 60000,
          apiCalls: 800,
          dataStorageImpact: 5120,
          fileStorageImpact: 256,
          bulkJobs: 5,
          grappeRecommendation: true,
        },
        canProceed: false,
        requiresConfirmation: [confirmation],
        autoFixable: [failedCheck],
      };

      expect(result.status).toBe('fail');
      expect(result.score).toBe(45);
      expect(result.canProceed).toBe(false);
      expect(result.checks).toHaveLength(2);
      expect(result.requiresConfirmation).toHaveLength(1);
      expect(result.requiresConfirmation[0].requiresTypedConfirmation).toBe(true);
      expect(result.autoFixable).toHaveLength(1);
      expect(result.autoFixable[0].fixDescription).toBe('Create the missing field via Metadata API.');
    });
  });

  describe('PreCheckItem', () => {
    it('should accept a PreCheckItem with all required fields and optional details', () => {
      const item: PreCheckItem = {
        id: 'chk-storage-001',
        category: 'storage',
        name: 'Data Storage Capacity',
        description: 'Verify sufficient data storage for the operation',
        severity: 'blocker',
        passed: false,
        message: 'Insufficient data storage: 95% used, need 500MB more.',
        details: {
          usedMB: 4750,
          limitMB: 5000,
          requiredMB: 500,
        },
        autoFixable: false,
      };

      expect(item.id).toBe('chk-storage-001');
      expect(item.category).toBe('storage');
      expect(item.severity).toBe('blocker');
      expect(item.passed).toBe(false);
      expect(item.autoFixable).toBe(false);
      expect(item.details).toEqual({ usedMB: 4750, limitMB: 5000, requiredMB: 500 });
      expect(item.fixDescription).toBeUndefined();
    });

    it('should accept an auto-fixable PreCheckItem with fix description', () => {
      const item: PreCheckItem = {
        id: 'chk-compat-001',
        category: 'compatibility',
        name: 'API Version Mismatch',
        description: 'Check that API versions are compatible',
        severity: 'warning',
        passed: false,
        message: 'Source org uses API v59, target uses v57.',
        autoFixable: true,
        fixDescription: 'Upgrade target org API version to v59.',
      };

      expect(item.autoFixable).toBe(true);
      expect(item.fixDescription).toBe('Upgrade target org API version to v59.');
    });
  });

  describe('PreCheckEstimations', () => {
    it('should accept estimations without optional grappe config', () => {
      const estimations: PreCheckEstimations = {
        duration: 15000,
        apiCalls: 100,
        dataStorageImpact: 512,
        fileStorageImpact: 0,
        bulkJobs: 1,
        grappeRecommendation: false,
      };

      expect(estimations.duration).toBe(15000);
      expect(estimations.apiCalls).toBe(100);
      expect(estimations.dataStorageImpact).toBe(512);
      expect(estimations.fileStorageImpact).toBe(0);
      expect(estimations.bulkJobs).toBe(1);
      expect(estimations.grappeRecommendation).toBe(false);
      expect(estimations.optimalGrappeConfig).toBeUndefined();
    });

    it('should accept estimations with optional grappe config when recommended', () => {
      const estimations: PreCheckEstimations = {
        duration: 120000,
        apiCalls: 5000,
        dataStorageImpact: 20480,
        fileStorageImpact: 1024,
        bulkJobs: 15,
        grappeRecommendation: true,
        optimalGrappeConfig: {
          enabled: true,
          autoActivateThreshold: 1000,
          maxWorkers: 4,
          grappeSize: 2000,
          strategy: 'by_volume',
          backPressure: {
            enabled: true,
            maxQueueDepth: 10,
            highWaterMark: 80,
            lowWaterMark: 40,
            strategy: 'throttle',
            monitoringInterval: 5000,
          },
          checkpointing: true,
          isolationLevel: 'per_grappe',
        },
      };

      expect(estimations.grappeRecommendation).toBe(true);
      expect(estimations.optimalGrappeConfig).toBeDefined();
      expect(estimations.optimalGrappeConfig?.maxWorkers).toBe(4);
      expect(estimations.optimalGrappeConfig?.strategy).toBe('by_volume');
      expect(estimations.optimalGrappeConfig?.backPressure.strategy).toBe('throttle');
    });
  });
});
