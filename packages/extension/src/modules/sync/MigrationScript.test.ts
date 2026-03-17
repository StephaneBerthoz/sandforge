import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationScript } from './MigrationScript';
import type { MigrationScriptDeps } from './MigrationScript';

function createDeps(overrides?: Partial<MigrationScriptDeps>): MigrationScriptDeps {
  return {
    executeAnonymous: vi.fn().mockResolvedValue({
      compiled: true,
      success: true,
      logs: 'Execution complete',
    }),
    ...overrides,
  };
}

describe('MigrationScript', () => {
  let deps: MigrationScriptDeps;
  let service: MigrationScript;

  beforeEach(() => {
    deps = createDeps();
    service = new MigrationScript(deps);
  });

  describe('execute', () => {
    it('should call executeAnonymous with org ID and script', async () => {
      await service.execute('System.debug("hello");', 'org-1');

      expect(deps.executeAnonymous).toHaveBeenCalledWith(
        'org-1',
        'System.debug("hello");'
      );
    });

    it('should return success for a compiled and successful script', async () => {
      const result = await service.execute('System.debug("test");', 'org-1');

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return output from logs', async () => {
      deps = createDeps({
        executeAnonymous: vi.fn().mockResolvedValue({
          compiled: true,
          success: true,
          logs: 'DEBUG|hello world',
        }),
      });
      service = new MigrationScript(deps);

      const result = await service.execute('System.debug("hello");', 'org-1');

      expect(result.output).toBe('DEBUG|hello world');
    });

    it('should return compilation error when script fails to compile', async () => {
      deps = createDeps({
        executeAnonymous: vi.fn().mockResolvedValue({
          compiled: false,
          success: false,
          compileProblem: 'Unexpected token',
        }),
      });
      service = new MigrationScript(deps);

      const result = await service.execute('bad code', 'org-1');

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Compilation error');
      expect(result.errors[0]).toContain('Unexpected token');
    });

    it('should return runtime exception when script throws', async () => {
      deps = createDeps({
        executeAnonymous: vi.fn().mockResolvedValue({
          compiled: true,
          success: false,
          exceptionMessage: 'System.NullPointerException',
        }),
      });
      service = new MigrationScript(deps);

      const result = await service.execute('Integer x = null; x.intValue();', 'org-1');

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('Runtime exception');
      expect(result.errors[0]).toContain('NullPointerException');
    });

    it('should return success with empty output for empty script', async () => {
      const result = await service.execute('', 'org-1');

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
      expect(deps.executeAnonymous).not.toHaveBeenCalled();
    });

    it('should return success with empty output for whitespace-only script', async () => {
      const result = await service.execute('   ', 'org-1');

      expect(result.success).toBe(true);
      expect(deps.executeAnonymous).not.toHaveBeenCalled();
    });

    it('should trim the script before executing', async () => {
      await service.execute('  System.debug("test");  ', 'org-1');

      expect(deps.executeAnonymous).toHaveBeenCalledWith(
        'org-1',
        'System.debug("test");'
      );
    });

    it('should handle missing logs in response', async () => {
      deps = createDeps({
        executeAnonymous: vi.fn().mockResolvedValue({
          compiled: true,
          success: true,
        }),
      });
      service = new MigrationScript(deps);

      const result = await service.execute('System.debug("test");', 'org-1');

      expect(result.output).toBe('');
    });

    it('should handle both compilation and runtime fields being present', async () => {
      deps = createDeps({
        executeAnonymous: vi.fn().mockResolvedValue({
          compiled: false,
          success: false,
          compileProblem: 'Syntax error',
          exceptionMessage: 'should not appear',
        }),
      });
      service = new MigrationScript(deps);

      const result = await service.execute('bad;', 'org-1');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Compilation error');
    });

    it('should set success to false when compiled but not successful', async () => {
      deps = createDeps({
        executeAnonymous: vi.fn().mockResolvedValue({
          compiled: true,
          success: false,
        }),
      });
      service = new MigrationScript(deps);

      const result = await service.execute('throw new Exception();', 'org-1');

      expect(result.success).toBe(false);
    });
  });
});
