import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';

// VSCode mock — tests tune `isTelemetryEnabled` and `telemetryLevel` per case.
const vscodeMock = vi.hoisted(() => {
  const state = {
    isTelemetryEnabled: false as boolean,
    telemetryLevel: 'all' as string,
  };
  return {
    state,
    env: {
      get isTelemetryEnabled(): boolean {
        return state.isTelemetryEnabled;
      },
    },
    workspace: {
      getConfiguration: (_section: string) => ({
        get: (_key: string, fallback?: string) => state.telemetryLevel ?? fallback,
      }),
    },
  };
});

vi.mock('vscode', () => ({
  env: vscodeMock.env,
  workspace: vscodeMock.workspace,
}));

// Must import AFTER the mocks above so the SUT picks up the stub modules.
import { TelemetryAdapter, stripSensitiveFields, type SentryModule } from './TelemetryAdapter.js';

/** Fresh Sentry stub per test so call counts don't leak. */
function buildSentryStub(): SentryModule & {
  init: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
  addBreadcrumb: ReturnType<typeof vi.fn>;
  setUser: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
    setUser: vi.fn(),
    flush: vi.fn(async () => true),
  } as unknown as SentryModule & {
    init: ReturnType<typeof vi.fn>;
    captureException: ReturnType<typeof vi.fn>;
    addBreadcrumb: ReturnType<typeof vi.fn>;
    setUser: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
  };
}

function fakeContext(): vscode.ExtensionContext {
  return {} as unknown as vscode.ExtensionContext;
}

describe('TelemetryAdapter', () => {
  beforeEach(() => {
    vscodeMock.state.isTelemetryEnabled = false;
    vscodeMock.state.telemetryLevel = 'all';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Sentry init gating', () => {
    it('does NOT initialise Sentry when VSCode telemetry is disabled globally', () => {
      vscodeMock.state.isTelemetryEnabled = false;
      vscodeMock.state.telemetryLevel = 'all';
      const sentry = buildSentryStub();

      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://foo@sentry.io/1',
        sentryModule: sentry,
      });

      expect(sentry.init).not.toHaveBeenCalled();
      expect(adapter.isEnabled()).toBe(false);
    });

    it('does NOT initialise Sentry when telemetryLevel is "off"', () => {
      vscodeMock.state.isTelemetryEnabled = true;
      vscodeMock.state.telemetryLevel = 'off';
      const sentry = buildSentryStub();

      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://foo@sentry.io/1',
        sentryModule: sentry,
      });

      expect(sentry.init).not.toHaveBeenCalled();
      expect(adapter.isEnabled()).toBe(false);
    });

    it('does NOT initialise Sentry when telemetryLevel is "crash"', () => {
      vscodeMock.state.isTelemetryEnabled = true;
      vscodeMock.state.telemetryLevel = 'crash';
      const sentry = buildSentryStub();

      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://foo@sentry.io/1',
        sentryModule: sentry,
      });

      expect(sentry.init).not.toHaveBeenCalled();
      expect(adapter.isEnabled()).toBe(false);
    });

    it('initialises Sentry exactly once when telemetry is on + DSN provided', () => {
      vscodeMock.state.isTelemetryEnabled = true;
      vscodeMock.state.telemetryLevel = 'all';
      const sentry = buildSentryStub();

      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://foo@sentry.io/1',
        release: '1.3.0',
        sentryModule: sentry,
      });

      expect(sentry.init).toHaveBeenCalledTimes(1);
      expect(sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://foo@sentry.io/1',
          release: '1.3.0',
          environment: 'extension-host',
        }),
      );
      expect(adapter.isEnabled()).toBe(true);
    });
  });

  describe('Pino logger', () => {
    it('returns a working Pino logger instance', () => {
      const adapter = new TelemetryAdapter(fakeContext());
      const logger = adapter.getLogger();

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('redacts apiKey / accessToken at top level and nested depth', async () => {
      const chunks: string[] = [];
      const destination = {
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      };
      const adapter = new TelemetryAdapter(fakeContext(), { pinoDestination: destination });

      adapter.getLogger().info(
        {
          apiKey: 'super-secret-123',
          config: {
            accessToken: 'at-xyz',
            nested: { refreshToken: 'rt-xyz' },
          },
        },
        'sensitive payload',
      );

      // Flush sync - pino destination `write` is invoked synchronously here.
      const combined = chunks.join('');
      expect(combined).toContain('[REDACTED]');
      expect(combined).not.toContain('super-secret-123');
      expect(combined).not.toContain('at-xyz');
      expect(combined).not.toContain('rt-xyz');
    });
  });

  describe('beforeSend / stripSensitiveFields', () => {
    it('strips accessToken from event.extra', () => {
      const event = {
        extra: {
          orgId: 'org-1',
          accessToken: 'at-xyz',
          refreshToken: 'rt-xyz',
        },
      };
      const result = stripSensitiveFields(event);
      expect(result.extra).toEqual({
        orgId: 'org-1',
        accessToken: '[REDACTED]',
        refreshToken: '[REDACTED]',
      });
    });

    it('scrubs nested sensitive fields inside event.contexts', () => {
      const event = {
        contexts: {
          auth: { apiKey: 'ak-1', user: 'alice' },
          unrelated: { flag: true },
        },
      };
      const result = stripSensitiveFields(event);
      expect((result.contexts!.auth as { apiKey: string }).apiKey).toBe('[REDACTED]');
      expect((result.contexts!.auth as { user: string }).user).toBe('alice');
      expect(result.contexts!.unrelated).toEqual({ flag: true });
    });
  });

  describe('public methods when Sentry is enabled', () => {
    beforeEach(() => {
      vscodeMock.state.isTelemetryEnabled = true;
      vscodeMock.state.telemetryLevel = 'all';
    });

    it('captureException forwards to Sentry.captureException with sanitised extras', () => {
      const sentry = buildSentryStub();
      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://x@y/1',
        sentryModule: sentry,
      });
      const err = new Error('boom');

      adapter.captureException(err, { orgId: 'o1', accessToken: 'leak' });

      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      const [passedErr, options] = sentry.captureException.mock.calls[0];
      expect(passedErr).toBe(err);
      expect(options.extra).toEqual({ orgId: 'o1', accessToken: '[REDACTED]' });
    });

    it('addBreadcrumb forwards to Sentry.addBreadcrumb with defaults', () => {
      const sentry = buildSentryStub();
      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://x@y/1',
        sentryModule: sentry,
      });

      adapter.addBreadcrumb('retrying-429', 'salesforce', 'warning');

      expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
        message: 'retrying-429',
        category: 'salesforce',
        level: 'warning',
      });
    });

    it('setUser hashes the org id via SHA-256 before forwarding', () => {
      const sentry = buildSentryStub();
      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://x@y/1',
        sentryModule: sentry,
      });

      adapter.setUser('00D000000000ABC');

      expect(sentry.setUser).toHaveBeenCalledTimes(1);
      const [arg] = sentry.setUser.mock.calls[0];
      expect(arg.id).toMatch(/^[a-f0-9]{64}$/);
      expect(arg.id).not.toContain('00D');
    });

    it('flush calls Sentry.flush with the provided timeout', async () => {
      const sentry = buildSentryStub();
      const adapter = new TelemetryAdapter(fakeContext(), {
        dsnNode: 'https://x@y/1',
        sentryModule: sentry,
      });

      await adapter.flush(500);

      expect(sentry.flush).toHaveBeenCalledWith(500);
    });
  });

  describe('public methods when Sentry is disabled (no-op path)', () => {
    it('addBreadcrumb / setUser / flush are safe no-ops', async () => {
      vscodeMock.state.isTelemetryEnabled = false;
      const sentry = buildSentryStub();
      const adapter = new TelemetryAdapter(fakeContext(), { sentryModule: sentry });

      adapter.addBreadcrumb('msg');
      adapter.setUser('org');
      await adapter.flush();

      expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
      expect(sentry.setUser).not.toHaveBeenCalled();
      expect(sentry.flush).not.toHaveBeenCalled();
    });
  });
});
