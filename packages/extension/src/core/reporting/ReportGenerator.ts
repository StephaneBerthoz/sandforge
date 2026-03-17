import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  ReportDefinition,
  GeneratedReport,
  ReportSection,
  ReportMetadata,
  ReportType,
} from '@sandforge/shared';

/** Events emitted by the ReportGenerator */
export interface ReportGeneratorEvents {
  reportGenerated: [report: GeneratedReport];
  reportDeleted: [id: string];
}

/**
 * Generates, stores, and manages reports from operation data.
 * Reports are stored in memory and can be filtered, retrieved, or deleted.
 */
export class ReportGenerator {
  private readonly reports: Map<string, GeneratedReport> = new Map();
  private readonly emitter: EventEmitter;

  constructor(emitter?: EventEmitter) {
    this.emitter = emitter ?? new EventEmitter();
  }

  /**
   * Generate a report from a definition and raw operation data.
   * Builds sections from data keys and stores the report in memory.
   * @param definition - The report definition describing the report type and template
   * @param data - Raw operation data used to populate report sections
   * @returns The generated report
   */
  async generateReport(
    definition: ReportDefinition,
    data: Record<string, unknown>
  ): Promise<GeneratedReport> {
    const sections = this.buildSections(data);
    const metadata = this.buildMetadata(definition, data);

    const report: GeneratedReport = {
      id: randomUUID(),
      definitionId: definition.id,
      type: definition.type,
      title: definition.name,
      summary: definition.description,
      sections,
      metadata,
      generatedAt: new Date().toISOString(),
    };

    this.reports.set(report.id, report);
    this.emitter.emit('reportGenerated', report);

    return report;
  }

  /**
   * Retrieve a report by its unique identifier.
   * @param id - The UUID of the report
   * @returns The report if found, undefined otherwise
   */
  getReport(id: string): GeneratedReport | undefined {
    return this.reports.get(id);
  }

  /**
   * List all reports, optionally filtered by type and/or module.
   * @param filter - Optional filter criteria
   * @returns An array of matching reports
   */
  listReports(filter?: {
    type?: ReportType;
    module?: string;
  }): GeneratedReport[] {
    let results = Array.from(this.reports.values());

    if (filter?.type) {
      results = results.filter((r) => r.type === filter.type);
    }
    if (filter?.module) {
      results = results.filter((r) => r.metadata.module === filter.module);
    }

    return results;
  }

  /**
   * Delete a report by its unique identifier.
   * @param id - The UUID of the report to delete
   * @returns true if the report was deleted, false if not found
   */
  deleteReport(id: string): boolean {
    const existed = this.reports.delete(id);
    if (existed) {
      this.emitter.emit('reportDeleted', id);
    }
    return existed;
  }

  /**
   * Register a listener for ReportGenerator events.
   * @param event - The event name
   * @param listener - The callback function
   */
  on<K extends keyof ReportGeneratorEvents>(
    event: K,
    listener: (...args: ReportGeneratorEvents[K]) => void
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Remove a listener for ReportGenerator events.
   * @param event - The event name
   * @param listener - The callback function to remove
   */
  off<K extends keyof ReportGeneratorEvents>(
    event: K,
    listener: (...args: ReportGeneratorEvents[K]) => void
  ): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private buildSections(data: Record<string, unknown>): ReportSection[] {
    const sections: ReportSection[] = [];
    let order = 0;

    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        sections.push({
          title: key,
          type: 'table',
          content: { rows: value },
          order: order++,
        });
      } else if (typeof value === 'object' && value !== null) {
        sections.push({
          title: key,
          type: 'detail',
          content: value as Record<string, unknown>,
          order: order++,
        });
      } else {
        sections.push({
          title: key,
          type: 'text',
          content: { value },
          order: order++,
        });
      }
    }

    return sections;
  }

  private buildMetadata(
    definition: ReportDefinition,
    data: Record<string, unknown>
  ): ReportMetadata {
    return {
      module: typeof data['module'] === 'string' ? data['module'] : definition.type,
      orgId: typeof data['orgId'] === 'string' ? data['orgId'] : undefined,
      operationId:
        typeof data['operationId'] === 'string' ? data['operationId'] : undefined,
      duration: typeof data['duration'] === 'number' ? data['duration'] : undefined,
      recordCount:
        typeof data['recordCount'] === 'number' ? data['recordCount'] : undefined,
    };
  }
}
