import { describe, it, expect, beforeEach } from 'vitest';
import { CliParser } from './CliParser.js';
import type { CliCommand } from './CliParser.js';

describe('CliParser', () => {
  let parser: CliParser;

  beforeEach(() => {
    parser = new CliParser();
  });

  describe('parse', () => {
    it('should parse a simple command with no options', () => {
      const result = parser.parse(['health', '--org', 'prod']);
      expect(result.command).toBe('health');
      expect(result.options['org']).toBe('prod');
    });

    it('should parse the seed command with all options', () => {
      const result = parser.parse([
        'seed',
        '--template',
        './templates/b2b.json',
        '--org',
        'dev1',
        '--records',
        '1000',
      ]);
      expect(result.command).toBe('seed');
      expect(result.options['template']).toBe('./templates/b2b.json');
      expect(result.options['org']).toBe('dev1');
      expect(result.options['records']).toBe('1000');
    });

    it('should parse the sync command with dry-run flag', () => {
      const result = parser.parse([
        'sync',
        '--config',
        './sync/prod-to-dev.json',
        '--dry-run',
      ]);
      expect(result.command).toBe('sync');
      expect(result.options['config']).toBe('./sync/prod-to-dev.json');
      expect(result.flags).toContain('dry-run');
    });

    it('should parse the compare command with output option', () => {
      const result = parser.parse([
        'compare',
        '--source',
        'prod',
        '--target',
        'uat',
        '--output',
        './reports/diff.html',
      ]);
      expect(result.command).toBe('compare');
      expect(result.options['source']).toBe('prod');
      expect(result.options['target']).toBe('uat');
      expect(result.options['output']).toBe('./reports/diff.html');
    });

    it('should parse the backup command with objects list', () => {
      const result = parser.parse([
        'backup',
        '--org',
        'prod',
        '--objects',
        'Account,Contact',
        '--output',
        './backups/',
      ]);
      expect(result.command).toBe('backup');
      expect(result.options['org']).toBe('prod');
      expect(result.options['objects']).toBe('Account,Contact');
    });

    it('should parse the pipeline command with sub-command', () => {
      const result = parser.parse([
        'pipeline',
        'run',
        '--config',
        './pipelines/nightly.json',
      ]);
      expect(result.command).toBe('pipeline');
      expect(result.subCommand).toBe('run');
      expect(result.options['config']).toBe('./pipelines/nightly.json');
    });

    it('should parse the anonymize command', () => {
      const result = parser.parse([
        'anonymize',
        '--org',
        'uat',
        '--template',
        'rgpd-france',
        '--report',
        './reports/',
      ]);
      expect(result.command).toBe('anonymize');
      expect(result.options['org']).toBe('uat');
      expect(result.options['template']).toBe('rgpd-france');
    });

    it('should parse the grappe command with sub-command and operation-id', () => {
      const result = parser.parse([
        'grappe',
        'status',
        '--operation-id',
        'abc123',
      ]);
      expect(result.command).toBe('grappe');
      expect(result.subCommand).toBe('status');
      expect(result.options['operation-id']).toBe('abc123');
    });

    it('should parse the health command with format option', () => {
      const result = parser.parse([
        'health',
        '--org',
        'prod',
        '--format',
        'json',
      ]);
      expect(result.command).toBe('health');
      expect(result.options['org']).toBe('prod');
      expect(result.options['format']).toBe('json');
    });

    it('should handle the help flag', () => {
      const result = parser.parse(['seed', '--help']);
      expect(result.command).toBe('seed');
      expect(result.flags).toContain('help');
    });

    it('should handle the verbose flag', () => {
      const result = parser.parse(['sync', '--config', 'x.json', '--verbose']);
      expect(result.flags).toContain('verbose');
    });

    it('should throw an error when no arguments are provided', () => {
      expect(() => parser.parse([])).toThrow('No arguments provided');
    });

    it('should not set subCommand for non-subcommand commands', () => {
      const result = parser.parse(['seed', '--template', 'a', '--org', 'b']);
      expect(result.subCommand).toBeUndefined();
    });

    it('should handle multiple flags together', () => {
      const result = parser.parse([
        'sync',
        '--config',
        'x.json',
        '--dry-run',
        '--verbose',
        '--force',
      ]);
      expect(result.flags).toContain('dry-run');
      expect(result.flags).toContain('verbose');
      expect(result.flags).toContain('force');
    });
  });

  describe('validate', () => {
    it('should validate a correct seed command', () => {
      const cmd: CliCommand = {
        command: 'seed',
        options: { template: './t.json', org: 'dev1' },
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject seed command missing --template', () => {
      const cmd: CliCommand = {
        command: 'seed',
        options: { org: 'dev1' },
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('--template')
      );
    });

    it('should reject seed command missing --org', () => {
      const cmd: CliCommand = {
        command: 'seed',
        options: { template: './t.json' },
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining('--org'));
    });

    it('should validate a correct sync command', () => {
      const cmd: CliCommand = {
        command: 'sync',
        options: { config: './sync.json' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });

    it('should reject sync command missing --config', () => {
      const cmd: CliCommand = {
        command: 'sync',
        options: {},
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('--config')
      );
    });

    it('should validate a correct compare command', () => {
      const cmd: CliCommand = {
        command: 'compare',
        options: { source: 'prod', target: 'uat' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });

    it('should reject compare command missing --source and --target', () => {
      const cmd: CliCommand = {
        command: 'compare',
        options: {},
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('should validate a correct backup command', () => {
      const cmd: CliCommand = {
        command: 'backup',
        options: { org: 'prod' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });

    it('should validate a correct pipeline command with sub-command', () => {
      const cmd: CliCommand = {
        command: 'pipeline',
        subCommand: 'run',
        options: { config: './p.json' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });

    it('should reject pipeline command without sub-command', () => {
      const cmd: CliCommand = {
        command: 'pipeline',
        options: { config: './p.json' },
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("sub-command 'run'")
      );
    });

    it('should reject pipeline command with wrong sub-command', () => {
      const cmd: CliCommand = {
        command: 'pipeline',
        subCommand: 'stop',
        options: { config: './p.json' },
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("Unknown sub-command 'stop'")
      );
    });

    it('should validate a correct anonymize command', () => {
      const cmd: CliCommand = {
        command: 'anonymize',
        options: { org: 'uat', template: 'rgpd' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });

    it('should validate a correct health command', () => {
      const cmd: CliCommand = {
        command: 'health',
        options: { org: 'prod' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });

    it('should validate a correct grappe command with sub-command', () => {
      const cmd: CliCommand = {
        command: 'grappe',
        subCommand: 'status',
        options: { 'operation-id': 'abc123' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });

    it('should reject grappe command without sub-command', () => {
      const cmd: CliCommand = {
        command: 'grappe',
        options: { 'operation-id': 'abc123' },
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
    });

    it('should reject unknown commands', () => {
      const cmd: CliCommand = {
        command: 'deploy',
        options: {},
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("Unknown command: 'deploy'")
      );
    });

    it('should accept any command with --help flag', () => {
      const cmd: CliCommand = {
        command: 'nonexistent',
        options: {},
        flags: ['help'],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(true);
    });

    it('should reject invalid format option', () => {
      const cmd: CliCommand = {
        command: 'health',
        options: { org: 'prod', format: 'yaml' },
        flags: [],
      };
      const result = parser.validate(cmd);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("Invalid format 'yaml'")
      );
    });

    it('should accept valid format option', () => {
      const cmd: CliCommand = {
        command: 'health',
        options: { org: 'prod', format: 'table' },
        flags: [],
      };
      expect(parser.validate(cmd).valid).toBe(true);
    });
  });

  describe('isValidCommand', () => {
    it('should return true for valid commands', () => {
      expect(parser.isValidCommand('seed')).toBe(true);
      expect(parser.isValidCommand('sync')).toBe(true);
      expect(parser.isValidCommand('compare')).toBe(true);
      expect(parser.isValidCommand('backup')).toBe(true);
      expect(parser.isValidCommand('pipeline')).toBe(true);
      expect(parser.isValidCommand('anonymize')).toBe(true);
      expect(parser.isValidCommand('health')).toBe(true);
      expect(parser.isValidCommand('grappe')).toBe(true);
    });

    it('should return false for invalid commands', () => {
      expect(parser.isValidCommand('deploy')).toBe(false);
      expect(parser.isValidCommand('')).toBe(false);
      expect(parser.isValidCommand('SEED')).toBe(false);
    });
  });

  describe('getValidCommands', () => {
    it('should return all 8 valid command names', () => {
      const commands = parser.getValidCommands();
      expect(commands).toHaveLength(8);
      expect(commands).toContain('seed');
      expect(commands).toContain('grappe');
    });
  });
});
