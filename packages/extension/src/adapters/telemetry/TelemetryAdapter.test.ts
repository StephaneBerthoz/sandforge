import { describe, it, expect } from 'vitest';
import type * as vscode from 'vscode';

import { TelemetryAdapter } from './TelemetryAdapter.js';

function fakeContext(): vscode.ExtensionContext {
  return {} as unknown as vscode.ExtensionContext;
}

/** Capture Pino output chunks for assertions. */
function captureDestination(): { destination: { write: (chunk: string) => boolean }; chunks: string[] } {
  const chunks: string[] = [];
  const destination = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  };
  return { destination, chunks };
}

describe('TelemetryAdapter', () => {
  describe('Pino logger', () => {
    it('returns a working Pino logger instance', () => {
      const adapter = new TelemetryAdapter(fakeContext());
      const logger = adapter.getLogger();

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('redacts apiKey / accessToken at top level and nested depth', () => {
      const { destination, chunks } = captureDestination();
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

  describe('captureException', () => {
    it('logs at error level with sanitised extras', () => {
      const { destination, chunks } = captureDestination();
      const adapter = new TelemetryAdapter(fakeContext(), { pinoDestination: destination });
      const err = new Error('boom');

      adapter.captureException(err, { orgId: 'o1', accessToken: 'leak' });

      const combined = chunks.join('');
      expect(combined).toContain('"level":50');
      expect(combined).toContain('captureException');
      expect(combined).toContain('boom');
      expect(combined).toContain('o1');
      expect(combined).toContain('[REDACTED]');
      expect(combined).not.toContain('leak');
    });
  });

  describe('addBreadcrumb', () => {
    it('logs at debug level (below the default info threshold)', () => {
      const { destination, chunks } = captureDestination();
      const adapter = new TelemetryAdapter(fakeContext(), { pinoDestination: destination });

      adapter.addBreadcrumb('retrying-429', 'salesforce', 'warning');

      // Debug is below the default `info` level — nothing is emitted.
      expect(chunks.join('')).toBe('');
    });

    it('is safe to call without a category', () => {
      const adapter = new TelemetryAdapter(fakeContext());
      expect(() => adapter.addBreadcrumb('msg')).not.toThrow();
    });
  });

  describe('flush', () => {
    it('resolves without throwing', async () => {
      const { destination } = captureDestination();
      const adapter = new TelemetryAdapter(fakeContext(), { pinoDestination: destination });

      await expect(adapter.flush()).resolves.toBeUndefined();
    });
  });

  describe('sandforge.telemetry gate', () => {
    it('suppresses captureException when the gate is closed', () => {
      const { destination, chunks } = captureDestination();
      const adapter = new TelemetryAdapter(fakeContext(), {
        pinoDestination: destination,
        isEnabled: () => false,
      });

      adapter.captureException(new Error('boom'));

      expect(chunks.join('')).toBe('');
      expect(adapter.getTelemetryEventCount()).toBe(0);
    });

    it('suppresses addBreadcrumb when the gate is closed', () => {
      const adapter = new TelemetryAdapter(fakeContext(), { isEnabled: () => false });

      adapter.addBreadcrumb('msg', 'cat', 'info');

      expect(adapter.getTelemetryEventCount()).toBe(0);
    });

    it('counts emitted events while the gate is open and honours live toggling', () => {
      const { destination, chunks } = captureDestination();
      let enabled = true;
      const adapter = new TelemetryAdapter(fakeContext(), {
        pinoDestination: destination,
        isEnabled: () => enabled,
      });

      adapter.captureException(new Error('first'));
      expect(adapter.getTelemetryEventCount()).toBe(1);
      expect(chunks.join('')).toContain('first');

      enabled = false;
      adapter.captureException(new Error('second'));
      expect(adapter.getTelemetryEventCount()).toBe(1);
      expect(chunks.join('')).not.toContain('second');
    });

    it('never gates the operational Pino logger', () => {
      const { destination, chunks } = captureDestination();
      const adapter = new TelemetryAdapter(fakeContext(), {
        pinoDestination: destination,
        isEnabled: () => false,
      });

      adapter.getLogger().info('operational-log');

      expect(chunks.join('')).toContain('operational-log');
    });
  });
});
