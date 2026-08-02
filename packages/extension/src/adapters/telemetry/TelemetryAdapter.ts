import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import pino from 'pino';
import type { Logger as PinoLogger, LoggerOptions } from 'pino';

/** Public logger type — wraps Pino so callers don't need to import pino directly. */
export type Logger = PinoLogger;

/**
 * Minimal shape we require from @sentry/node — lets tests inject a stub without
 * importing the real Sentry module.
 */
export interface SentryModule {
  init: (options: Record<string, unknown>) => void;
  captureException: (err: unknown, context?: { extra?: Record<string, unknown> }) => void;
  addBreadcrumb: (crumb: { message: string; category?: string; level?: string }) => void;
  setUser: (user: { id: string }) => void;
  flush: (timeout?: number) => Promise<boolean>;
}

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
  /** Sentry module injection — defaults to dynamic require('@sentry/node'). */
  sentryModule?: SentryModule;
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

/**
 * Sensitive field names redacted from every Pino payload. Pino's wildcard
 * (`*`) matches a single level, so we enumerate depths 1..4 programmatically
 * below to cover realistic nesting (token under `config`, `config.nested`,
 * `req.body.config`, etc.) without blowing out the path list by hand.
 */
const SENSITIVE_LEAF_NAMES = [
  'apiKey',
  'accessToken',
  'refreshToken',
  'secret',
  'password',
  'authorization',
];

/** Build Pino `redact.paths` that match sensitive leaves at depths 0..4. */
function buildRedactPaths(): string[] {
  const paths: string[] = ['req.headers.authorization'];
  for (const leaf of SENSITIVE_LEAF_NAMES) {
    paths.push(leaf);
    paths.push(`*.${leaf}`);
    paths.push(`*.*.${leaf}`);
    paths.push(`*.*.*.${leaf}`);
    paths.push(`*.*.*.*.${leaf}`);
  }
  return paths;
}

const PINO_REDACT_PATHS = buildRedactPaths();

/**
 * TelemetryAdapter — opt-in observability facade wired on VSCode telemetry settings.
 *
 * Behaviour:
 *  - Sentry (`@sentry/node`) is only initialised when ALL of
 *    `vscode.env.isTelemetryEnabled` is true AND
 *    `sandforge.telemetry` is true (extension-level opt-in, manifest default off) AND
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
  private sentryModule: SentryModule | null = null;

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
  addBreadcrumb(
    message: string,
    category?: string,
    level: 'info' | 'warning' | 'error' = 'info',
  ): void {
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

  /** Gate per VSCode's global telemetry setting + `telemetry.telemetryLevel` + `sandforge.telemetry`. */
  private shouldEnableSentry(): boolean {
    if (!vscode.env.isTelemetryEnabled) {
      return false;
    }
    // `sandforge.telemetry` (manifest default false) is the extension-level
    // opt-in: even when the VS Code-wide telemetry switch is on, SandForge
    // only reports when the user explicitly enabled its own telemetry.
    const optedIn = vscode.workspace.getConfiguration('sandforge').get<boolean>('telemetry', false);
    if (!optedIn) {
      return false;
    }
    const level = vscode.workspace
      .getConfiguration('telemetry')
      .get<string>('telemetryLevel', 'all');
    return level !== 'off' && level !== 'crash';
  }

  private initSentry(): void {
    if (this.sentryInitialised) {
      return;
    }
    const Sentry = this.opts.sentryModule ?? loadSentryNode();
    if (!Sentry) {
      return;
    }
    Sentry.init({
      dsn: this.opts.dsnNode,
      release: this.opts.release,
      environment: 'extension-host',
      tracesSampleRate: 0,
      beforeSend: (event: unknown) =>
        stripSensitiveFields(event as Parameters<typeof stripSensitiveFields>[0]),
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

/**
 * Best-effort dynamic load of @sentry/node. Returns null if the module isn't
 * available (e.g. in unit tests that don't install it or explicitly opt out).
 */
function loadSentryNode(): SentryModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const imported = require('@sentry/node') as Record<string, unknown>;
    const candidate = (
      typeof imported.init === 'function' ? imported : (imported.default ?? imported)
    ) as SentryModule;
    return typeof candidate.init === 'function' ? candidate : null;
  } catch {
    return null;
  }
}

/** Strip sensitive keys from a map in-place, returning a new object. */
function sanitiseExtras(
  extras: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
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
export function stripSensitiveFields<
  T extends { contexts?: Record<string, unknown>; extra?: Record<string, unknown> },
>(event: T): T {
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
