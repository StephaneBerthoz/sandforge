import * as fs from 'node:fs';
import type { MetricSample } from '@sandforge/shared';
import type { TimeSeriesStore } from './TimeSeriesStore.js';
import { rowsToCsv } from './csv-utils.js';
import { lttb, samplesToPoints, type Point } from './lttb.js';

/** Minimal logger surface — pino-style structured warn. */
export interface ReportLogger {
  warn(meta: Record<string, unknown>, msg?: string): void;
}

/** Minimal bridge surface for export-progress notifications. */
export interface ReportBridge {
  send(message: { type: string; payload: unknown; id: string }): void;
}

/** Descriptor of the data slice to export. */
export interface DashboardView {
  view: 'fleet' | 'single-org' | 'series';
  orgId?: string;
  seriesIds?: string[];
  fromMs: number;
  toMs: number;
}

/** Returned by ReportExporter.export(). */
export interface ExportResult {
  filePath: string;
  format: 'csv' | 'pdf';
  bytes: number;
  durationMs: number;
}

/** Stages emitted via the optional bridge for UI progress. */
export type ExportStage = 'querying' | 'rendering' | 'writing' | 'done';

/** Max sparkline points after LTTB downsampling — keeps SVG/PDF compact. */
export const SPARKLINE_TARGET_POINTS = 100;

/**
 * Exports a {@link DashboardView} of TimeSeriesStore data to disk.
 *
 * - CSV: header `ts,orgId,seriesId,value,unit` then one row per sample.
 * - PDF: lazy-imports `pdfkit`; one page per series with an inline-SVG
 *   sparkline downsampled to {@link SPARKLINE_TARGET_POINTS} via LTTB.
 *
 * Progress is broadcast via the optional bridge so the WebView can render
 * a progress bar; emissions are best-effort and never block the export.
 */
export class ReportExporter {
  constructor(
    private readonly timeSeriesStore: TimeSeriesStore,
    private readonly logger?: ReportLogger,
    private readonly bridge?: ReportBridge,
  ) {}

  async export(view: DashboardView, format: 'csv' | 'pdf', filePath: string): Promise<ExportResult> {
    const startedAt = Date.now();
    this.postProgress('querying', 0);
    const seriesData = this.gatherSeries(view);

    this.postProgress('rendering', 33);
    let bytes = 0;
    if (format === 'csv') {
      bytes = await this.writeCsv(seriesData, filePath);
    } else {
      bytes = await this.writePdf(seriesData, filePath);
    }

    this.postProgress('done', 100);
    return { filePath, format, bytes, durationMs: Date.now() - startedAt };
  }

  private postProgress(stage: ExportStage, pct: number): void {
    try {
      this.bridge?.send({
        type: 'monitor:export:progress',
        payload: { stage, pct },
        id: `prog-${Date.now()}`,
      });
    } catch (err: unknown) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'ReportExporter: progress emit failed',
      );
    }
  }

  private gatherSeries(view: DashboardView): Map<string, MetricSample[]> {
    const result = new Map<string, MetricSample[]>();
    if (!view.orgId || !view.seriesIds) return result;
    for (const seriesId of view.seriesIds) {
      result.set(
        seriesId,
        this.timeSeriesStore.query(view.orgId, seriesId, view.fromMs, view.toMs),
      );
    }
    return result;
  }

  private async writeCsv(
    seriesData: Map<string, MetricSample[]>,
    filePath: string,
  ): Promise<number> {
    const rows: unknown[][] = [['ts', 'orgId', 'seriesId', 'value', 'unit']];
    for (const [seriesId, samples] of seriesData) {
      for (const s of samples) {
        rows.push([s.ts, s.orgId, seriesId, s.value, s.unit ?? '']);
      }
    }
    const csv = rowsToCsv(rows);
    this.postProgress('writing', 80);
    await fs.promises.writeFile(filePath, csv, 'utf8');
    return Buffer.byteLength(csv, 'utf8');
  }

  /** PDF path implemented in plan-03-06-task-05. */
  protected writePdf(
    _seriesData: Map<string, MetricSample[]>,
    _filePath: string,
  ): Promise<number> {
    return Promise.reject(new Error('writePdf implemented in 03-06-05'));
  }

  /** Internal helper exposed for the PDF path: downsample for sparklines. */
  protected downsampleForSparkline(samples: readonly MetricSample[]): Point[] {
    const points = samplesToPoints(samples);
    return lttb(points, SPARKLINE_TARGET_POINTS);
  }
}
