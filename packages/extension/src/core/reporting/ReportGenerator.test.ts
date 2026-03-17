import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ReportGenerator } from './ReportGenerator';
import type { ReportDefinition } from '@sandforge/shared';

function makeDefinition(
  overrides?: Partial<ReportDefinition>
): ReportDefinition {
  return {
    id: 'def-001',
    name: 'Test Report',
    type: 'seed_execution',
    description: 'A test report definition',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ReportGenerator', () => {
  let generator: ReportGenerator;
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
    generator = new ReportGenerator(emitter);
  });

  describe('generateReport', () => {
    it('should generate a report with correct fields from definition', async () => {
      const definition = makeDefinition();
      const data = { module: 'seed', status: 'success' };

      const report = await generator.generateReport(definition, data);

      expect(report.id).toBeDefined();
      expect(report.definitionId).toBe('def-001');
      expect(report.type).toBe('seed_execution');
      expect(report.title).toBe('Test Report');
      expect(report.summary).toBe('A test report definition');
      expect(report.generatedAt).toBeDefined();
    });

    it('should build sections from data keys', async () => {
      const definition = makeDefinition();
      const data = {
        records: [{ name: 'Account' }, { name: 'Contact' }],
        info: { count: 42 },
        status: 'done',
      };

      const report = await generator.generateReport(definition, data);

      expect(report.sections).toHaveLength(3);

      const tableSection = report.sections.find((s) => s.title === 'records');
      expect(tableSection?.type).toBe('table');

      const detailSection = report.sections.find((s) => s.title === 'info');
      expect(detailSection?.type).toBe('detail');

      const textSection = report.sections.find((s) => s.title === 'status');
      expect(textSection?.type).toBe('text');
    });

    it('should extract metadata from data when available', async () => {
      const definition = makeDefinition();
      const data = {
        module: 'sync',
        orgId: 'org-123',
        operationId: 'op-456',
        duration: 1500,
        recordCount: 200,
      };

      const report = await generator.generateReport(definition, data);

      expect(report.metadata.module).toBe('sync');
      expect(report.metadata.orgId).toBe('org-123');
      expect(report.metadata.operationId).toBe('op-456');
      expect(report.metadata.duration).toBe(1500);
      expect(report.metadata.recordCount).toBe(200);
    });

    it('should use definition type as module fallback', async () => {
      const definition = makeDefinition({ type: 'compare_result' });
      const data = { status: 'ok' };

      const report = await generator.generateReport(definition, data);

      expect(report.metadata.module).toBe('compare_result');
    });

    it('should store the report in the internal map', async () => {
      const definition = makeDefinition();
      const report = await generator.generateReport(definition, {});

      const retrieved = generator.getReport(report.id);
      expect(retrieved).toEqual(report);
    });

    it('should emit a reportGenerated event', async () => {
      const listener = vi.fn();
      emitter.on('reportGenerated', listener);

      const definition = makeDefinition();
      const report = await generator.generateReport(definition, {});

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(report);
    });

    it('should generate unique IDs for each report', async () => {
      const definition = makeDefinition();
      const report1 = await generator.generateReport(definition, {});
      const report2 = await generator.generateReport(definition, {});

      expect(report1.id).not.toBe(report2.id);
    });

    it('should assign incrementing section order values', async () => {
      const definition = makeDefinition();
      const data = { a: 'x', b: 'y', c: 'z' };

      const report = await generator.generateReport(definition, data);

      const orders = report.sections.map((s) => s.order);
      expect(orders).toEqual([0, 1, 2]);
    });
  });

  describe('getReport', () => {
    it('should return undefined for a non-existent id', () => {
      expect(generator.getReport('nonexistent')).toBeUndefined();
    });

    it('should return the correct report by id', async () => {
      const report = await generator.generateReport(makeDefinition(), {
        status: 'ok',
      });

      const found = generator.getReport(report.id);
      expect(found?.title).toBe('Test Report');
    });
  });

  describe('listReports', () => {
    it('should return all reports when no filter is provided', async () => {
      await generator.generateReport(makeDefinition(), {});
      await generator.generateReport(makeDefinition(), {});

      const all = generator.listReports();
      expect(all).toHaveLength(2);
    });

    it('should filter by report type', async () => {
      await generator.generateReport(
        makeDefinition({ type: 'seed_execution' }),
        {}
      );
      await generator.generateReport(
        makeDefinition({ type: 'sync_execution' }),
        {}
      );
      await generator.generateReport(
        makeDefinition({ type: 'seed_execution' }),
        {}
      );

      const filtered = generator.listReports({ type: 'seed_execution' });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((r) => r.type === 'seed_execution')).toBe(true);
    });

    it('should filter by module', async () => {
      await generator.generateReport(makeDefinition(), { module: 'seed' });
      await generator.generateReport(makeDefinition(), { module: 'sync' });

      const filtered = generator.listReports({ module: 'seed' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].metadata.module).toBe('seed');
    });

    it('should filter by both type and module', async () => {
      await generator.generateReport(
        makeDefinition({ type: 'seed_execution' }),
        { module: 'seed' }
      );
      await generator.generateReport(
        makeDefinition({ type: 'seed_execution' }),
        { module: 'sync' }
      );
      await generator.generateReport(
        makeDefinition({ type: 'sync_execution' }),
        { module: 'seed' }
      );

      const filtered = generator.listReports({
        type: 'seed_execution',
        module: 'seed',
      });
      expect(filtered).toHaveLength(1);
    });

    it('should return empty array when no reports match', async () => {
      await generator.generateReport(makeDefinition(), {});

      const filtered = generator.listReports({ type: 'org_health' });
      expect(filtered).toHaveLength(0);
    });
  });

  describe('deleteReport', () => {
    it('should delete an existing report and return true', async () => {
      const report = await generator.generateReport(makeDefinition(), {});

      const result = generator.deleteReport(report.id);

      expect(result).toBe(true);
      expect(generator.getReport(report.id)).toBeUndefined();
    });

    it('should return false when deleting a non-existent report', () => {
      const result = generator.deleteReport('nonexistent');
      expect(result).toBe(false);
    });

    it('should emit a reportDeleted event', async () => {
      const listener = vi.fn();
      emitter.on('reportDeleted', listener);

      const report = await generator.generateReport(makeDefinition(), {});
      generator.deleteReport(report.id);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(report.id);
    });

    it('should not emit reportDeleted for non-existent reports', () => {
      const listener = vi.fn();
      emitter.on('reportDeleted', listener);

      generator.deleteReport('nonexistent');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('on / off', () => {
    it('should register and unregister event listeners', async () => {
      const listener = vi.fn();
      generator.on('reportGenerated', listener);

      await generator.generateReport(makeDefinition(), {});
      expect(listener).toHaveBeenCalledOnce();

      generator.off('reportGenerated', listener);

      await generator.generateReport(makeDefinition(), {});
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe('default EventEmitter', () => {
    it('should create its own EventEmitter when none is provided', async () => {
      const standalone = new ReportGenerator();
      const report = await standalone.generateReport(makeDefinition(), {});

      expect(report.id).toBeDefined();
      expect(standalone.getReport(report.id)).toBeDefined();
    });
  });
});
