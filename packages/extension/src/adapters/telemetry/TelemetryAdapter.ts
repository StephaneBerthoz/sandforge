import * as vscode from 'vscode';
import pino from 'pino';
import type { Logger as PinoLogger, LoggerOptions } from 'pino';

/** Public logger type — wraps Pino so callers don't need to import pino directly. */
export type Logger = PinoLogger;

/** Options for TelemetryAdapter construction. */
export interface TelemetryAdapterOptions {
  /** Optional override for Pino destination (used by tests to capture output). */
  pinoDestination?: pino.DestinationStream;
  /**
   * Live gate for telemetry emissions, bound to the `sandforge.telemetry`
   * setting at the composition root. When absent, telemetry emissions are
   * always allowed (preserves legacy behaviour for tests embedding the
   * adapter directly). The operational Pino logger is NEVER gated — only
   * the telemetry-style API (`captureException` / `addBreadcrumb`).
   */
  isEnabled?: () => boolean;
}

/**
 * Set of field names (case-insensitive) that must never reach the logs.
 * Matches the Pino `redact` patterns used for every payload.
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
 * TelemetryAdapter — structured logging facade over Pino.
 *
 * Behaviour:
 *  - `getLogger()` returns a Pino logger configured with deep redaction paths
 *    for OAuth tokens, API keys and authorization headers.
 *  - `captureException` logs at error level with sanitised extras.
 *  - `addBreadcrumb` logs at debug level (silent at the default `info` level).
 *  - `flush()` drains the Pino destination — called on extension deactivate.
 */
export class TelemetryAdapter {
  // context retained for future wiring (e.g. SessionToken, LogOutputChannel).
  // @ts-expect-error intentionally kept for downstream plans (DI wiring in 01-03).
  private readonly context: vscode.ExtensionContext;
  private readonly opts: TelemetryAdapterOptions;
  private readonly logger: Logger;
  /** Count of telemetry events actually emitted while the gate was open. */
  private telemetryEventCount = 0;

  constructor(context: vscode.ExtensionContext, opts?: TelemetryAdapterOptions) {
    this.context = context;
    this.opts = opts ?? {};
    this.logger = this.createLogger(this.opts.pinoDestination);
  }

  /** Returns the Pino logger (redaction always applies). */
  getLogger(): Logger {
    return this.logger;
  }

  /**
   * Number of telemetry events emitted since activation (0 when the
   * `sandforge.telemetry` gate has been closed the whole time).
   */
  getTelemetryEventCount(): number {
    return this.telemetryEventCount;
  }

  /** True when the `sandforge.telemetry` gate allows telemetry emissions. */
  private isTelemetryAllowed(): boolean {
    return this.opts.isEnabled?.() ?? true;
  }

  /** Log an exception at error level; sensitive extras are redacted. */
  captureException(err: unknown, extra?: Record<string, unknown>): void {
    if (!this.isTelemetryAllowed()) return;
    this.telemetryEventCount++;
    this.logger.error({ err, extra: sanitiseExtras(extra) }, 'captureException');
  }

  /** Record a diagnostic breadcrumb at debug level. */
  addBreadcrumb(
    message: string,
    category?: string,
    level: 'info' | 'warning' | 'error' = 'info',
  ): void {
    if (!this.isTelemetryAllowed()) return;
    this.telemetryEventCount++;
    this.logger.debug({ category: category ?? 'sandforge', level }, message);
  }

  /** Flush pending log writes (best-effort, called on deactivate). */
  async flush(): Promise<void> {
    this.logger.flush();
  }

  // ── internals ──────────────────────────────────────────────

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

/** Strip sensitive keys from a map, returning a new object. */
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
