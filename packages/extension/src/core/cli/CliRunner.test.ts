import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliRunner } from './CliRunner.js';
import { CliParser } from './CliParser.js';
import { CliReporter, CliExitCode } from './CliReporter.js';

describe('CliRunner', () => {
  let parser: CliParser;
  let reporter: CliReporter;
  let runner: CliRunner;

  beforeEach(() => {
    parser = new CliParser();
    reporter = new CliReporter();
    runner = new CliRunner(parser, reporter);
  });

  describe('run — seed command', () => {
    it('should execute the seed command successfully', async () => {
      const result = await runner.run([
        'seed',
        '--template',
        './templates/b2b.json',
        '--org',
        'dev1',
        '--records',
        '1000',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Success);
      expect(result.format).toBe('json');
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('seed');
      expect(parsed['status']).toBe('completed');
      expect(parsed['recordsGenerated']).toBe(1000);
    });

    it('should fail when seed is missing required options', async () => {
      const result = await runner.run(['seed', '--template', './t.json']);

      expect(result.exitCode).toBe(CliExitCode.Failure);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['error']).toBe('Validation failed');
    });
  });

  describe('run — sync command', () => {
    it('should execute the sync command successfully', async () => {
      const result = await runner.run([
        'sync',
        '--config',
        './sync/prod-to-dev.json',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Success);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('sync');
      expect(parsed['dryRun']).toBe(false);
      expect(parsed['recordsSynced']).toBe(250);
    });

    it('should handle dry-run flag for sync', async () => {
      const result = await runner.run([
        'sync',
        '--config',
        './sync/prod-to-dev.json',
        '--dry-run',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Success);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['dryRun']).toBe(true);
      expect(parsed['recordsSynced']).toBe(0);
    });
  });

  describe('run — compare command', () => {
    it('should execute the compare command with warnings exit code', async () => {
      const result = await runner.run([
        'compare',
        '--source',
        'prod',
        '--target',
        'uat',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Warnings);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('compare');
      expect(parsed['differencesFound']).toBe(12);
    });
  });

  describe('run — backup command', () => {
    it('should execute the backup command successfully', async () => {
      const result = await runner.run([
        'backup',
        '--org',
        'prod',
        '--objects',
        'Account,Contact',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Success);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('backup');
      expect(parsed['totalRecords']).toBe(1500);
    });
  });

  describe('run — pipeline command', () => {
    it('should execute the pipeline run command successfully', async () => {
      const result = await runner.run([
        'pipeline',
        'run',
        '--config',
        './pipelines/nightly.json',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Success);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('pipeline');
      expect(parsed['stepsExecuted']).toBe(5);
    });

    it('should fail when pipeline is missing sub-command', async () => {
      const result = await runner.run([
        'pipeline',
        '--config',
        './pipelines/nightly.json',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Failure);
    });
  });

  describe('run — anonymize command', () => {
    it('should execute the anonymize command successfully', async () => {
      const result = await runner.run([
        'anonymize',
        '--org',
        'uat',
        '--template',
        'rgpd-france',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Success);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('anonymize');
      expect(parsed['recordsAnonymized']).toBe(3200);
    });
  });

  describe('run — health command', () => {
    it('should execute the health command successfully', async () => {
      const result = await runner.run(['health', '--org', 'prod']);

      expect(result.exitCode).toBe(CliExitCode.Success);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('health');
      expect(parsed['status']).toBe('healthy');
    });
  });

  describe('run — grappe command', () => {
    it('should execute the grappe status command successfully', async () => {
      const result = await runner.run([
        'grappe',
        'status',
        '--operation-id',
        'abc123',
      ]);

      expect(result.exitCode).toBe(CliExitCode.Success);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['command']).toBe('grappe');
      expect(parsed['operationId']).toBe('abc123');
      expect(parsed['progress']).toBe(75);
    });
  });

  describe('run — format option', () => {
    it('should output in table format when --format table', async () => {
      const result = await runner.run([
        'health',
        '--org',
        'prod',
        '--format',
        'table',
      ]);

      expect(result.format).toBe('table');
      expect(result.output).toContain('|');
      expect(result.output).toContain('+');
    });

    it('should output in CSV format when --format csv', async () => {
      const result = await runner.run([
        'health',
        '--org',
        'prod',
        '--format',
        'csv',
      ]);

      expect(result.format).toBe('csv');
      expect(result.output).toContain(',');
    });

    it('should output in HTML format when --format html', async () => {
      const result = await runner.run([
        'health',
        '--org',
        'prod',
        '--format',
        'html',
      ]);

      expect(result.format).toBe('html');
      expect(result.output).toContain('<!DOCTYPE html>');
    });

    it('should default to JSON format when no --format specified', async () => {
      const result = await runner.run(['health', '--org', 'prod']);

      expect(result.format).toBe('json');
      // Should be valid JSON
      expect(() => JSON.parse(result.output)).not.toThrow();
    });
  });

  describe('run — error handling', () => {
    it('should return failure for empty arguments', async () => {
      const result = await runner.run([]);

      expect(result.exitCode).toBe(CliExitCode.Failure);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['error']).toContain('No arguments provided');
    });

    it('should return failure for unknown commands', async () => {
      const result = await runner.run(['deploy', '--target', 'prod']);

      expect(result.exitCode).toBe(CliExitCode.Failure);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['error']).toBe('Validation failed');
    });

    it('should always include a duration in the result', async () => {
      const result = await runner.run(['health', '--org', 'prod']);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle parser throwing an error gracefully', async () => {
      const brokenParser = new CliParser();
      vi.spyOn(brokenParser, 'parse').mockImplementation(() => {
        throw new Error('Parse explosion');
      });
      const brokenRunner = new CliRunner(brokenParser, reporter);

      const result = await brokenRunner.run(['anything']);

      expect(result.exitCode).toBe(CliExitCode.Failure);
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['error']).toBe('Parse explosion');
    });
  });

  describe('run — output option', () => {
    it('should track output path in seed result', async () => {
      const result = await runner.run([
        'seed',
        '--template',
        './t.json',
        '--org',
        'dev1',
        '--output',
        './out/',
      ]);

      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['outputPath']).toBe('./out/');
    });

    it('should track output path in compare result', async () => {
      const result = await runner.run([
        'compare',
        '--source',
        'prod',
        '--target',
        'uat',
        '--output',
        './reports/diff.html',
      ]);

      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['outputPath']).toBe('./reports/diff.html');
    });

    it('should set outputPath to null when --output is not provided', async () => {
      const result = await runner.run([
        'seed',
        '--template',
        './t.json',
        '--org',
        'dev1',
      ]);

      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      expect(parsed['outputPath']).toBeNull();
    });
  });
});
