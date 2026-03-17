/** Log level for SandForge extension */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Minimal output channel interface (matches vscode.OutputChannel) */
interface OutputChannel {
  appendLine(line: string): void;
}

interface LogMeta {
  [key: string]: unknown;
}

/**
 * Lightweight logger that writes to a VSCode OutputChannel.
 * Replaces console.log throughout the extension.
 */
class Logger {
  private channel: OutputChannel | undefined;

  /** Initialize with a VSCode output channel */
  init(channel: OutputChannel): void {
    this.channel = channel;
  }

  /** Log a debug-level message */
  debug(message: string, meta?: LogMeta): void {
    this.log('debug', message, meta);
  }

  /** Log an info-level message */
  info(message: string, meta?: LogMeta): void {
    this.log('info', message, meta);
  }

  /** Log a warning-level message */
  warn(message: string, meta?: LogMeta): void {
    this.log('warn', message, meta);
  }

  /** Log an error-level message */
  error(message: string, meta?: LogMeta): void {
    this.log('error', message, meta);
  }

  private log(level: LogLevel, message: string, meta?: LogMeta): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
    this.channel?.appendLine(line);
  }
}

/** Singleton logger instance for the extension */
export const logger = new Logger();
