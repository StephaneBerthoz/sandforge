import { z } from 'zod';
import type { ConfigStore } from '../storage/ConfigStore.js';

/** Maximum number of audit entries to retain. */
const MAX_ENTRIES = 1000;

/** Config store key for the audit trail. */
const AUDIT_KEY = 'audit:trail';

/** Config store category for audit data. */
const AUDIT_CATEGORY = 'audit';

/** Supported operation types for audit logging. */
export type AuditOperationType =
  | 'seed'
  | 'sync'
  | 'backup'
  | 'compare'
  | 'dataops'
  | 'pipeline'
  | 'config'
  | 'governance'
  | 'other';

/** Possible audit entry statuses. */
export type AuditStatus = 'success' | 'failure' | 'partial';

/**
 * Zod schema for an audit trail entry.
 */
const AuditEntrySchema = z.object({
  id: z.string(),
  operationType: z.enum([
    'seed', 'sync', 'backup', 'compare', 'dataops',
    'pipeline', 'config', 'governance', 'other',
  ]),
  description: z.string(),
  orgId: z.string().optional(),
  user: z.string().optional(),
  timestamp: z.string(),
  durationMs: z.number(),
  status: z.enum(['success', 'failure', 'partial']),
  recordCount: z.number().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

/** A single audit trail entry. */
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * Filter criteria for searching audit entries.
 */
export interface AuditFilter {
  /** Start date (ISO string) for date range filter. */
  startDate?: string;
  /** End date (ISO string) for date range filter. */
  endDate?: string;
  /** Filter by operation type. */
  operationType?: AuditOperationType;
  /** Filter by org ID. */
  orgId?: string;
  /** Filter by status. */
  status?: AuditStatus;
  /** Full-text search in description. */
  search?: string;
}

/**
 * Options for exporting audit data.
 */
export interface AuditExportOptions {
  /** Export format. */
  format: 'csv' | 'json';
  /** Optional filter to apply before export. */
  filter?: AuditFilter;
}

/**
 * Service for logging and querying SandForge operation audit trails.
 *
 * Records structured audit entries for every operation, with automatic
 * rotation to keep the store at a manageable size. Supports filtering,
 * searching, and exporting as CSV or JSON.
 */
export class AuditTrailService {
  private entries: AuditEntry[] = [];

  /** @param configStore - The configuration store for persistence. */
  constructor(private readonly configStore: ConfigStore) {
    this.load();
  }

  /**
   * Log a new audit entry.
   *
   * @param entry - The audit entry to record (without id/timestamp).
   * @returns The created audit entry with generated id and timestamp.
   */
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const fullEntry: AuditEntry = {
      ...entry,
      id: AuditTrailService.generateId(),
      timestamp: new Date().toISOString(),
    };

    this.entries.unshift(fullEntry);
    this.rotate();
    this.persist();

    return fullEntry;
  }

  /**
   * Get all audit entries, optionally filtered.
   *
   * @param filter - Optional filter criteria.
   * @returns Filtered audit entries, newest first.
   */
  list(filter?: AuditFilter): AuditEntry[] {
    if (!filter) {
      return [...this.entries];
    }

    return this.entries.filter((entry) => {
      if (filter.startDate && entry.timestamp < filter.startDate) {
        return false;
      }
      if (filter.endDate && entry.timestamp > filter.endDate) {
        return false;
      }
      if (filter.operationType && entry.operationType !== filter.operationType) {
        return false;
      }
      if (filter.orgId && entry.orgId !== filter.orgId) {
        return false;
      }
      if (filter.status && entry.status !== filter.status) {
        return false;
      }
      if (filter.search) {
        const searchLower = filter.search.toLowerCase();
        const descLower = entry.description.toLowerCase();
        if (!descLower.includes(searchLower)) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Get a single audit entry by ID.
   *
   * @param id - The audit entry identifier.
   * @returns The entry if found, undefined otherwise.
   */
  getById(id: string): AuditEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Get the total number of stored entries.
   *
   * @returns Count of audit entries.
   */
  count(): number {
    return this.entries.length;
  }

  /**
   * Clear all audit entries.
   */
  clear(): void {
    this.entries = [];
    this.persist();
  }

  /**
   * Export audit entries as CSV or JSON string.
   *
   * @param options - Export format and optional filter.
   * @returns The serialized audit data.
   */
  export(options: AuditExportOptions): string {
    const data = this.list(options.filter);

    if (options.format === 'json') {
      return JSON.stringify(data, null, 2);
    }

    return AuditTrailService.toCsv(data);
  }

  /**
   * Convert audit entries to CSV format.
   *
   * @param entries - The entries to convert.
   * @returns CSV string with headers.
   */
  static toCsv(entries: AuditEntry[]): string {
    const headers = [
      'id', 'operationType', 'description', 'orgId', 'user',
      'timestamp', 'durationMs', 'status', 'recordCount', 'error',
    ];
    const lines = [headers.join(',')];

    for (const entry of entries) {
      const values = [
        AuditTrailService.csvEscape(entry.id),
        AuditTrailService.csvEscape(entry.operationType),
        AuditTrailService.csvEscape(entry.description),
        AuditTrailService.csvEscape(entry.orgId ?? ''),
        AuditTrailService.csvEscape(entry.user ?? ''),
        AuditTrailService.csvEscape(entry.timestamp),
        String(entry.durationMs),
        AuditTrailService.csvEscape(entry.status),
        String(entry.recordCount ?? 0),
        AuditTrailService.csvEscape(entry.error ?? ''),
      ];
      lines.push(values.join(','));
    }

    return lines.join('\n');
  }

  /**
   * Escape a value for CSV output.
   *
   * @param value - The string to escape.
   * @returns CSV-safe string.
   */
  static csvEscape(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Generate a unique audit entry ID.
   *
   * @returns A unique identifier string.
   */
  static generateId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `audit-${ts}-${rand}`;
  }

  /** Load entries from the config store. */
  private load(): void {
    const raw = this.configStore.get<AuditEntry[]>(AUDIT_KEY);
    if (Array.isArray(raw)) {
      this.entries = raw.filter((e) => AuditEntrySchema.safeParse(e).success);
    }
  }

  /** Persist entries to the config store. */
  private persist(): void {
    this.configStore.set(AUDIT_KEY, this.entries, AUDIT_CATEGORY);
  }

  /** Rotate entries to keep within MAX_ENTRIES limit. */
  private rotate(): void {
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
  }
}
