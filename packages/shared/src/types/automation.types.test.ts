import { describe, it, expect } from 'vitest';
import type {
  PipelineDefinition,
  PipelineStep,
  PipelineRun,
  PipelineHistoryEntry,
} from './automation.types.js';

describe('automation.types', () => {
  describe('PipelineDefinition', () => {
    it('should accept a valid PipelineDefinition with steps and triggers', () => {
      const pipeline: PipelineDefinition = {
        id: 'pipe-001',
        name: 'Sandbox Refresh Pipeline',
        description: 'Full sandbox refresh: backup, seed, anonymize, verify',
        version: 3,
        steps: [
          {
            id: 'step-001',
            name: 'Backup Target',
            type: 'backup',
            config: { orgId: 'org-sandbox', objects: ['Account', 'Contact'] },
            continueOnError: false,
            timeout: 300000,
            retries: 2,
          },
          {
            id: 'step-002',
            name: 'Seed Data',
            type: 'seed',
            config: { seedConfigId: 'seed-001' },
            continueOnError: false,
          },
          {
            id: 'step-003',
            name: 'Anonymize PII',
            type: 'anonymize',
            config: { templateId: 'anon-001' },
            continueOnError: true,
          },
        ],
        triggers: [
          {
            id: 'trig-001',
            type: 'schedule',
            enabled: true,
            config: { cron: '0 3 * * 1', timezone: 'UTC' },
          },
          {
            id: 'trig-002',
            type: 'sandbox_refresh',
            enabled: true,
            config: { orgId: 'org-sandbox' },
          },
        ],
        variables: [
          {
            name: 'TARGET_ORG',
            type: 'string',
            defaultValue: 'org-sandbox',
            required: true,
            description: 'Target sandbox org ID',
          },
          {
            name: 'DRY_RUN',
            type: 'boolean',
            defaultValue: 'false',
            required: false,
            description: 'Run in dry-run mode without committing changes',
          },
        ],
        tags: ['sandbox-refresh', 'weekly', 'automated'],
        createdAt: '2026-01-15T10:00:00Z',
        updatedAt: '2026-02-18T14:30:00Z',
      };

      expect(pipeline.id).toBe('pipe-001');
      expect(pipeline.version).toBe(3);
      expect(pipeline.steps).toHaveLength(3);
      expect(pipeline.triggers).toHaveLength(2);
      expect(pipeline.variables).toHaveLength(2);
      expect(pipeline.tags).toContain('weekly');
    });

    it('should accept a minimal pipeline with no triggers or variables', () => {
      const pipeline: PipelineDefinition = {
        id: 'pipe-002',
        name: 'Manual Data Compare',
        description: 'Compare two orgs on demand',
        version: 1,
        steps: [
          {
            id: 'step-010',
            name: 'Compare Metadata',
            type: 'compare',
            config: { configId: 'cmp-001' },
            continueOnError: false,
          },
        ],
        triggers: [],
        variables: [],
        tags: [],
        createdAt: '2026-02-20T08:00:00Z',
        updatedAt: '2026-02-20T08:00:00Z',
      };

      expect(pipeline.steps).toHaveLength(1);
      expect(pipeline.triggers).toHaveLength(0);
      expect(pipeline.variables).toHaveLength(0);
      expect(pipeline.tags).toHaveLength(0);
    });
  });

  describe('PipelineStep', () => {
    it('should accept a step with conditional routing', () => {
      const step: PipelineStep = {
        id: 'step-100',
        name: 'Check Record Count',
        type: 'condition',
        config: { soqlQuery: 'SELECT COUNT() FROM Account' },
        continueOnError: false,
        condition: {
          field: 'record_count',
          operator: 'gt',
          value: 1000,
          logicalGroup: 'and',
        },
        onSuccess: 'step-101',
        onFailure: 'step-102',
      };

      expect(step.type).toBe('condition');
      expect(step.condition?.operator).toBe('gt');
      expect(step.condition?.value).toBe(1000);
      expect(step.onSuccess).toBe('step-101');
      expect(step.onFailure).toBe('step-102');
    });

    it('should accept a notification step without optional fields', () => {
      const step: PipelineStep = {
        id: 'step-200',
        name: 'Notify Team',
        type: 'notification',
        config: { channel: 'webhook', message: 'Pipeline completed' },
        continueOnError: true,
      };

      expect(step.type).toBe('notification');
      expect(step.continueOnError).toBe(true);
      expect(step.timeout).toBeUndefined();
      expect(step.retries).toBeUndefined();
      expect(step.condition).toBeUndefined();
    });
  });

  describe('PipelineRun', () => {
    it('should accept a completed pipeline run with step results', () => {
      const run: PipelineRun = {
        id: 'run-001',
        pipelineId: 'pipe-001',
        pipelineName: 'Sandbox Refresh Pipeline',
        status: 'completed',
        triggeredBy: 'schedule',
        stepResults: [
          {
            stepId: 'step-001',
            stepName: 'Backup Target',
            stepType: 'backup',
            status: 'completed',
            output: { recordCount: 5000, filePath: '/backups/bkp-20260215.zip' },
            startTime: '2026-02-15T03:00:00Z',
            endTime: '2026-02-15T03:05:00Z',
            duration: 300000,
          },
          {
            stepId: 'step-002',
            stepName: 'Seed Data',
            stepType: 'seed',
            status: 'completed',
            output: { inserted: 2500 },
            startTime: '2026-02-15T03:05:00Z',
            endTime: '2026-02-15T03:12:00Z',
            duration: 420000,
          },
        ],
        variables: { TARGET_ORG: 'org-sandbox', DRY_RUN: 'false' },
        startTime: '2026-02-15T03:00:00Z',
        endTime: '2026-02-15T03:12:00Z',
        duration: 720000,
      };

      expect(run.status).toBe('completed');
      expect(run.triggeredBy).toBe('schedule');
      expect(run.stepResults).toHaveLength(2);
      expect(run.variables['TARGET_ORG']).toBe('org-sandbox');
      expect(run.duration).toBe(720000);
    });

    it('should accept a failed pipeline run with an error', () => {
      const run: PipelineRun = {
        id: 'run-002',
        pipelineId: 'pipe-001',
        pipelineName: 'Sandbox Refresh Pipeline',
        status: 'failed',
        triggeredBy: 'manual',
        stepResults: [
          {
            stepId: 'step-001',
            stepName: 'Backup Target',
            stepType: 'backup',
            status: 'failed',
            error: 'INSUFFICIENT_ACCESS: Cannot access org',
            startTime: '2026-02-16T10:00:00Z',
            endTime: '2026-02-16T10:00:05Z',
            duration: 5000,
          },
          {
            stepId: 'step-002',
            stepName: 'Seed Data',
            stepType: 'seed',
            status: 'skipped',
          },
        ],
        variables: { TARGET_ORG: 'org-sandbox' },
        startTime: '2026-02-16T10:00:00Z',
        endTime: '2026-02-16T10:00:05Z',
        duration: 5000,
        error: 'Pipeline failed at step "Backup Target"',
      };

      expect(run.status).toBe('failed');
      expect(run.error).toBeDefined();
      expect(run.stepResults[0].status).toBe('failed');
      expect(run.stepResults[1].status).toBe('skipped');
    });
  });

  describe('PipelineHistoryEntry', () => {
    it('should accept a valid history entry', () => {
      const entry: PipelineHistoryEntry = {
        runId: 'run-001',
        pipelineId: 'pipe-001',
        pipelineName: 'Sandbox Refresh Pipeline',
        status: 'completed',
        triggeredBy: 'schedule',
        startTime: '2026-02-15T03:00:00Z',
        duration: 720000,
        stepCount: 3,
        errorCount: 0,
      };

      expect(entry.status).toBe('completed');
      expect(entry.stepCount).toBe(3);
      expect(entry.errorCount).toBe(0);
      expect(entry.triggeredBy).toBe('schedule');
    });

    it('should accept a history entry for a failed run with errors', () => {
      const entry: PipelineHistoryEntry = {
        runId: 'run-002',
        pipelineId: 'pipe-001',
        pipelineName: 'Sandbox Refresh Pipeline',
        status: 'failed',
        triggeredBy: 'manual',
        startTime: '2026-02-16T10:00:00Z',
        duration: 5000,
        stepCount: 3,
        errorCount: 1,
      };

      expect(entry.status).toBe('failed');
      expect(entry.errorCount).toBe(1);
      expect(entry.duration).toBe(5000);
    });

    it('should accept a history entry for a cancelled run', () => {
      const entry: PipelineHistoryEntry = {
        runId: 'run-003',
        pipelineId: 'pipe-002',
        pipelineName: 'Manual Data Compare',
        status: 'cancelled',
        triggeredBy: 'manual',
        startTime: '2026-02-17T09:00:00Z',
        duration: 1200,
        stepCount: 1,
        errorCount: 0,
      };

      expect(entry.status).toBe('cancelled');
      expect(entry.pipelineName).toBe('Manual Data Compare');
    });
  });
});
