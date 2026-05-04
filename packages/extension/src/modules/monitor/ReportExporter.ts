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

  /**
   * Render the slice as a multi-part PDF when over {@link MAX_SERIES_PER_PDF}.
   * pdfkit is lazy-imported so its ~1.2 MB raw weight only loads on Export
   * (cold-start guarantee — RESEARCH §1 + CONTEXT D-03-6).
   */
  protected async writePdf(
    seriesData: Map<string, MetricSample[]>,
    filePath: string,
  ): Promise<number> {
    const allSeries = [...seriesData.entries()];
    const partCount = Math.max(1, Math.ceil(allSeries.length / MAX_SERIES_PER_PDF));
    let totalBytes = 0;
    for (let part = 0; part < partCount; part++) {
      const partFilePath =
        partCount === 1 ? filePath : filePath.replace(/(\.pdf)$/i, `.part${part + 1}$1`);
      const partSeries = allSeries.slice(
        part * MAX_SERIES_PER_PDF,
        (part + 1) * MAX_SERIES_PER_PDF,
      );
      totalBytes += await this.writePdfPart(partSeries, partFilePath, part + 1, partCount);
    }
    return totalBytes;
  }

  private async writePdfPart(
    series: [string, MetricSample[]][],
    filePath: string,
    partIndex: number,
    partCount: number,
  ): Promise<number> {
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc
      .fontSize(18)
      .text(
        `SandForge Monitor Report${partCount > 1 ? ` (Part ${partIndex} of ${partCount})` : ''}`,
        { align: 'left' },
      );
    doc.fontSize(10).fillColor('#666').text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown();

    for (const [seriesId, samples] of series) {
      if (samples.length === 0) continue;
      doc.fillColor('black').fontSize(12).text(seriesId, { continued: false });
      this.drawSparkline(doc, samples);
      const values = samples.map((s) => s.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      doc
        .fontSize(9)
        .fillColor('#444')
        .text(
          `min: ${min.toFixed(2)}   avg: ${avg.toFixed(2)}   max: ${max.toFixed(2)}   n: ${samples.length}`,
        );
      doc.moveDown();
    }

    if (partCount > 1 && partIndex < partCount) {
      doc.fontSize(9).fillColor('#aaa').text(`Continued in part ${partIndex + 1}`, { align: 'right' });
    }

    doc.end();
    await new Promise<void>((resolve, reject) => {
      // `once` auto-removes the listener after firing — pdfkit's stream
      // is one-shot per writePdfPart call so this is the right primitive
      // and the audit-disposables script accepts it as a sink.
      stream.once('finish', () => resolve());
      stream.once('error', reject);
    });
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  }

  /**
   * Draw a sparkline directly via pdfkit primitives (no svg-to-pdfkit dep).
   * Downsamples to {@link SPARKLINE_PDF_POINTS} via LTTB so the polyline
   * stays compact even for series with thousands of samples.
   */
  private drawSparkline(
    doc: { x: number; y: number; moveTo: (x: number, y: number) => unknown; lineTo: (x: number, y: number) => unknown; stroke: (color?: string) => unknown },
    samples: readonly MetricSample[],
  ): void {
    const W = 480;
    const H = 60;
    const P = 4;
    const points = lttb(samplesToPoints(samples), SPARKLINE_PDF_POINTS);
    if (points.length === 0) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const xRange = Math.max(xMax - xMin, 1);
    const yRange = Math.max(yMax - yMin, 1);
    const x0 = (doc as { x: number }).x;
    const y0 = (doc as { y: number }).y;
    let started = false;
    for (const p of points) {
      const px = x0 + P + ((p.x - xMin) / xRange) * (W - 2 * P);
      const py = y0 + H - P - ((p.y - yMin) / yRange) * (H - 2 * P);
      if (!started) {
        doc.moveTo(px, py);
        started = true;
      } else {
        doc.lineTo(px, py);
      }
    }
    doc.stroke('#3b82f6');
    // Reserve vertical space so subsequent text rows don't overlap.
    (doc as { y: number }).y = y0 + H + 4;
  }

  /** Internal helper exposed for the PDF path: downsample for sparklines. */
  protected downsampleForSparkline(samples: readonly MetricSample[]): Point[] {
    const points = samplesToPoints(samples);
    return lttb(points, SPARKLINE_TARGET_POINTS);
  }
}

/** Per-PDF cap (P-03.4) — anything bigger splits into .partN.pdf files. */
const MAX_SERIES_PER_PDF = 50;
/** PDF sparkline detail level — 800 keeps each line under 30 KB. */
const SPARKLINE_PDF_POINTS = 800;
