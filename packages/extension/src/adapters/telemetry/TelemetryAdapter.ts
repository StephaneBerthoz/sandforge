import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import pino from 'pino';
import type { Logger as PinoLogger, LoggerOptions } from 'pino';

/** Public logger type — wraps Pino so callers don't need to import pino directly. */
export type Logger = PinoLogger;

/** Options for TelemetryAdapter construction. */
export interface TelemetryAdapterOptions {
  /** Sentry DSN for the Node (extension-host) SDK. */
  dsnNode?: string;
  /** Sentry DSN for the browser (webview) SDK. */
  dsnBrowser?: string;
  /** Release tag, usually package.json#version. */
  release?: string;
  /** Optional override for Pino destination (used by tests to capture output). */
  pinoDestination?: pino.DestinationStream;
}

/**
 * Set of field names (case-insensitive) that must never reach Sentry or logs.
 * Matches Pino `redact` patterns + Sentry `beforeSend` sanitisation.
 */
const SENSITIVE_FIELD_NAMES = new Set([
  'accesstoken',
  'refreshtoken',
  'apikey',
  'password',
  'authorization',
  'secret',
]);

/** Pino `redact` paths — deep match (`**.xyz`) required for nested scrubbing. */
const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '**.apiKey',
  '**.accessToken',
  '**.refreshToken',
  '**.secret',
  '**.authorization',
  '**.password',
];

/**
 * TelemetryAdapter — opt-in observability facade wired on VSCode telemetry settings.
 *
 * Behaviour:
 *  - Sentry (`@sentry/node`) is only initialised when BOTH
 *    `vscode.env.isTelemetryEnabled` is true AND
 *    `telemetry.telemetryLevel` is `'error'` or `'all'` (not `'off'` / `'crash'`).
 *  - `getLogger()` returns a Pino logger configured with deep redaction paths
 *    for OAuth tokens, API keys and authorization headers.
 *  - `beforeSend` hook strips sensitive fields from `event.contexts` and
 *    `event.extra` before transmission.
 *  - Methods degrade gracefully to no-ops when Sentry is disabled.
 */
export class TelemetryAdapter {
  // context retained for future wiring (e.g. SessionToken, LogOutputChannel).
  // @ts-expect-error intentionally kept for downstream plans (DI wiring in 01-03).
  private readonly context: vscode.ExtensionContext;
  private readonly opts: TelemetryAdapterOptions;
  private readonly logger: Logger;
  private sentryInitialised = false;
  private sentryEnabled = false;
  private sentryModule: typeof import('@sentry/node') | null = null;

  constructor(context: vscode.ExtensionContext, opts?: TelemetryAdapterOptions) {
    this.context = context;
    this.opts = opts ?? {};
    this.logger = this.createLogger(this.opts.pinoDestination);

    if (this.shouldEnableSentry() && this.opts.dsnNode) {
      this.initSentry();
    }
  }

  /** Returns true if the Pino logger is wired to forward to Sentry (i.e. telemetry active). */
  isEnabled(): boolean {
    return this.sentryEnabled;
  }

  /** Returns the Pino logger (always available — redaction applies even when Sentry is off). */
  getLogger(): Logger {
    return this.logger;
  }

  /** Forward an exception to Sentry if enabled; otherwise log at error level. */
  captureException(err: unknown, extra?: Record<string, unknown>): void {
    if (this.sentryEnabled && this.sentryModule) {
      this.sentryModule.captureException(err, { extra: sanitiseExtras(extra) });
      return;
    }
    this.logger.error({ err, extra: sanitiseExtras(extra) }, 'captureException (sentry disabled)');
  }

  /** Add a Sentry breadcrumb (no-op if Sentry disabled). */
  addBreadcrumb(message: string, category?: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (!this.sentryEnabled || !this.sentryModule) {
      return;
    }
    this.sentryModule.addBreadcrumb({
      message,
      category: category ?? 'sandforge',
      level,
    });
  }

  /**
   * Set the current Sentry user to a hashed org identifier.
   * Uses SHA-256 (Node crypto) — the org id itself never leaves the process.
   */
  setUser(orgIdHash: string): void {
    if (!this.sentryEnabled || !this.sentryModule) {
      return;
    }
    const hashed = createHash('sha256').update(orgIdHash).digest('hex');
    this.sentryModule.setUser({ id: hashed });
  }

  /** Flush pending Sentry events, bounded by timeout (ms). */
  async flush(timeout = 2000): Promise<void> {
    if (!this.sentryEnabled || !this.sentryModule) {
      return;
    }
    await this.sentryModule.flush(timeout);
  }

  // ── internals ──────────────────────────────────────────────

  /** Gate per VSCode's global telemetry setting + `telemetry.telemetryLevel`. */
  private shouldEnableSentry(): boolean {
    if (!vscode.env.isTelemetryEnabled) {
      return false;
    }
    const level = vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'all');
    return level !== 'off' && level !== 'crash';
  }

  private initSentry(): void {
    if (this.sentryInitialised) {
      return;
    }
    // Dynamic require to avoid pulling Sentry into the bundle when disabled.
    // In Node the extension host can use a regular require.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/node') as typeof import('@sentry/node');
    Sentry.init({
      dsn: this.opts.dsnNode,
      release: this.opts.release,
      environment: 'extension-host',
      tracesSampleRate: 0,
      beforeSend: (event) => stripSensitiveFields(event),
    });
    this.sentryModule = Sentry;
    this.sentryEnabled = true;
    this.sentryInitialised = true;
  }

  private createLogger(destination?: pino.DestinationStream): Logger {
    const options: LoggerOptions = {
      name: 'sandforge',
      level: 'info',
      redact: {
        paths: PINO_REDACT_PATHS,
        censor: '[REDACTED]',
      },
    };
    return destination ? pino(options, destination) : pino(options);
  }
}

/** Strip sensitive keys from a map in-place, returning a new object. */
function sanitiseExtras(extras: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extras) {
    return extras;
  }
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extras)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/** Sentry `beforeSend` — strip sensitive fields from `contexts` and `extra`. */
export function stripSensitiveFields<T extends { contexts?: Record<string, unknown>; extra?: Record<string, unknown> }>(
  event: T
): T {
  if (event.extra) {
    event.extra = sanitiseRecord(event.extra);
  }
  if (event.contexts) {
    const cleanContexts: Record<string, unknown> = {};
    for (const [ctxKey, ctxValue] of Object.entries(event.contexts)) {
      if (ctxValue && typeof ctxValue === 'object') {
        cleanContexts[ctxKey] = sanitiseRecord(ctxValue as Record<string, unknown>);
      } else {
        cleanContexts[ctxKey] = ctxValue;
      }
    }
    event.contexts = cleanContexts;
  }
  return event;
}

function sanitiseRecord(record: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitiseRecord(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}
