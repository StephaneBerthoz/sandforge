import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AuditAction, AuditLogEntry } from '@sandforge/shared';

/** Filter criteria for querying audit log entries */
export interface AuditLogFilter {
  action?: AuditAction;
  module?: string;
  orgId?: string;
  fromDate?: string;
  toDate?: string;
}

/** Events emitted by the AuditLogger */
export interface AuditLoggerEvents {
  auditLogged: [entry: AuditLogEntry];
}

/**
 * Logs and manages audit trail entries for all SandForge operations.
 * Entries are stored in memory and can be filtered, exported, or cleared.
 */
export class AuditLogger {
  private readonly entries: AuditLogEntry[] = [];
  private readonly emitter: EventEmitter;

  constructor(emitter?: EventEmitter) {
    this.emitter = emitter ?? new EventEmitter();
  }

  /**
   * Log a new audit trail entry.
   * @param action - The audit action category
   * @param module - The module that performed the action
   * @param details - Additional details about the action
   * @param orgId - Optional Salesforce org identifier
   * @returns The created audit log entry
   */
  log(
    action: AuditAction,
    module: string,
    details: Record<string, unknown>,
    orgId?: string,
  ): AuditLogEntry {
    const entry: AuditLogEntry = {
      id: randomUUID(),
      action,
      module,
      orgId,
      details,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(entry);
    this.emitter.emit('auditLogged', entry);

    return entry;
  }

  /**
   * Retrieve audit log entries matching the given filter criteria.
   * All filter fields are optional; unspecified fields match all entries.
   * @param filter - Optional filter criteria
   * @returns An array of matching audit log entries
   */
  getEntries(filter?: AuditLogFilter): AuditLogEntry[] {
    let results = [...this.entries];

    if (filter?.action) {
      results = results.filter((e) => e.action === filter.action);
    }
    if (filter?.module) {
      results = results.filter((e) => e.module === filter.module);
    }
    if (filter?.orgId) {
      results = results.filter((e) => e.orgId === filter.orgId);
    }
    if (filter?.fromDate) {
      const from = filter.fromDate;
      results = results.filter((e) => e.timestamp >= from);
    }
    if (filter?.toDate) {
      const to = filter.toDate;
      results = results.filter((e) => e.timestamp <= to);
    }

    return results;
  }

  /**
   * Retrieve a single audit log entry by its unique identifier.
   * @param id - The UUID of the entry
   * @returns The entry if found, undefined otherwise
   */
  getEntry(id: string): AuditLogEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Clear all audit log entries from memory.
   */
  clear(): void {
    this.entries.length = 0;
  }

  /**
   * Export all audit log entries in the specified format.
   * @param format - The export format ('json' or 'csv')
   * @returns A string containing the exported data
   */
  exportEntries(format: 'json' | 'csv'): string {
    if (format === 'json') {
      return JSON.stringify(this.entries, null, 2);
    }

    return this.exportToCsv();
  }

  /**
   * Register a listener for AuditLogger events.
   * @param event - The event name
   * @param listener - The callback function
   */
  on<K extends keyof AuditLoggerEvents>(
    event: K,
    listener: (...args: AuditLoggerEvents[K]) => void,
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Remove a listener for AuditLogger events.
   * @param event - The event name
   * @param listener - The callback function to remove
   */
  off<K extends keyof AuditLoggerEvents>(
    event: K,
    listener: (...args: AuditLoggerEvents[K]) => void,
  ): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private exportToCsv(): string {
    const headers = [
      'id',
      'action',
      'module',
      'orgId',
      'userId',
      'details',
      'timestamp',
      'ipAddress',
    ];
    const headerRow = headers.join(',');

    const rows = this.entries.map((entry) => {
      const values = [
        this.escapeCsvValue(entry.id),
        this.escapeCsvValue(entry.action),
        this.escapeCsvValue(entry.module),
        this.escapeCsvValue(entry.orgId ?? ''),
        this.escapeCsvValue(entry.userId ?? ''),
        this.escapeCsvValue(JSON.stringify(entry.details)),
        this.escapeCsvValue(entry.timestamp),
        this.escapeCsvValue(entry.ipAddress ?? ''),
      ];
      return values.join(',');
    });

    return [headerRow, ...rows].join('\n');
  }

  private escapeCsvValue(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
