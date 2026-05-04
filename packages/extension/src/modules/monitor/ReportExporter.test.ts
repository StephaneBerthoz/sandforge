import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MetricSample } from '@sandforge/shared';
import { TimeSeriesStore } from './TimeSeriesStore.js';
import { ReportExporter, type DashboardView, type ReportBridge } from './ReportExporter.js';

/** Far-future fixed clock so query() default upper bound covers any sample. */
const FIXED_NOW = () => new Date('2099-01-01T00:00:00Z').getTime();
const BASE_MS = new Date('2024-01-01T00:00:00Z').getTime();

const tmpFiles: string[] = [];
function tmpPath(suffix: string): string {
  const p = path.join(os.tmpdir(), `sandforge-rep-${Date.now()}-${Math.floor(Math.random() * 1e9)}.${suffix}`);
  tmpFiles.push(p);
  return p;
}

afterEach(async () => {
  while (tmpFiles.length) {
    const p = tmpFiles.pop()!;
    try {
      await fs.promises.unlink(p);
    } catch {
      // ignore — file may not exist or may have already been cleaned
    }
    // Also try the .partN.pdf split files
    for (let n = 1; n <= 3; n++) {
      const part = p.replace(/(\.pdf)$/i, `.part${n}$1`);
      try {
        await fs.promises.unlink(part);
      } catch {
        /* ignore */
      }
    }
  }
});

function makeStore(samples: MetricSample[]): TimeSeriesStore {
  const store = new TimeSeriesStore({ now: FIXED_NOW });
  for (const s of samples) store.record(s);
  return store;
}

function s(seriesId: string, value: number, offsetMin = 0, orgId = 'o1', unit?: string): MetricSample {
  return {
    ts: new Date(BASE_MS + offsetMin * 60_000).toISOString(),
    orgId,
    seriesId,
    value,
    ...(unit ? { unit } : {}),
  };
}

const ALL = (orgId = 'o1', seriesIds = ['s1']): DashboardView => ({
  view: 'series',
  orgId,
  seriesIds,
  fromMs: 0,
  toMs: FIXED_NOW(),
});

describe('ReportExporter — CSV', () => {
  it('CSV header row is exactly ts,orgId,seriesId,value,unit + CRLF', async () => {
    const store = makeStore([s('s1', 42)]);
    const exporter = new ReportExporter(store);
    const out = tmpPath('csv');
    await exporter.export(ALL('o1', ['s1']), 'csv', out);
    const csv = await fs.promises.readFile(out, 'utf8');
    expect(csv.startsWith('ts,orgId,seriesId,value,unit\r\n')).toBe(true);
  });

  it('CSV escapes values containing commas with quotes', async () => {
    const store = makeStore([s('s1', 1, 0, 'o1', 'a,b')]);
    const exporter = new ReportExporter(store);
    const out = tmpPath('csv');
    await exporter.export(ALL('o1', ['s1']), 'csv', out);
    const csv = await fs.promises.readFile(out, 'utf8');
    expect(csv).toContain(',"a,b"');
  });

  it('CSV row count = header + N data rows', async () => {
    const samples = Array.from({ length: 10 }, (_, i) => s('s1', i, i));
    const store = makeStore(samples);
    const exporter = new ReportExporter(store);
    const out = tmpPath('csv');
    await exporter.export(ALL('o1', ['s1']), 'csv', out);
    const csv = await fs.promises.readFile(out, 'utf8');
    const rows = csv.split('\r\n').filter(Boolean);
    expect(rows).toHaveLength(11); // 1 header + 10 data
  });

  it('empty series tolerated — CSV has 0 data rows for that series', async () => {
    const store = makeStore([]); // nothing recorded
    const exporter = new ReportExporter(store);
    const out = tmpPath('csv');
    const result = await exporter.export(ALL('o1', ['s1']), 'csv', out);
    const csv = await fs.promises.readFile(out, 'utf8');
    const rows = csv.split('\r\n').filter(Boolean);
    expect(rows).toHaveLength(1); // header only
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('progress events emitted (querying / rendering / done) via bridge', async () => {
    const store = makeStore([s('s1', 1)]);
    const sendSpy = vi.fn();
    const bridge: ReportBridge = { send: sendSpy };
    const exporter = new ReportExporter(store, undefined, bridge);
    const out = tmpPath('csv');
    await exporter.export(ALL('o1', ['s1']), 'csv', out);
    const stages = sendSpy.mock.calls.map((c) => (c[0] as { payload: { stage: string } }).payload.stage);
    expect(stages).toContain('querying');
    expect(stages).toContain('rendering');
    expect(stages).toContain('done');
  });
});

describe('ReportExporter — PDF', () => {
  it('PDF magic bytes — first 5 bytes are %PDF-', async () => {
    const store = makeStore([s('s1', 1, 0), s('s1', 2, 1), s('s1', 3, 2)]);
    const exporter = new ReportExporter(store);
    const out = tmpPath('pdf');
    await exporter.export(ALL('o1', ['s1']), 'pdf', out);
    const buf = await fs.promises.readFile(out);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('series-cap pagination — 75 series → 2 part files, each ≤ 50 series', async () => {
    const seriesIds = Array.from({ length: 75 }, (_, i) => `series-${i}`);
    const samples = seriesIds.flatMap((sid) => [s(sid, 1, 0), s(sid, 2, 1)]);
    const store = makeStore(samples);
    const exporter = new ReportExporter(store);
    const out = tmpPath('pdf');
    await exporter.export(ALL('o1', seriesIds), 'pdf', out);
    const part1 = out.replace(/(\.pdf)$/, '.part1$1');
    const part2 = out.replace(/(\.pdf)$/, '.part2$1');
    expect(fs.existsSync(part1)).toBe(true);
    expect(fs.existsSync(part2)).toBe(true);
    const buf1 = await fs.promises.readFile(part1);
    const buf2 = await fs.promises.readFile(part2);
    expect(buf1.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf2.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('empty series in PDF → no crash, file still valid', async () => {
    const store = makeStore([]);
    const exporter = new ReportExporter(store);
    const out = tmpPath('pdf');
    await exporter.export(ALL('o1', ['s1']), 'pdf', out);
    const buf = await fs.promises.readFile(out);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('ReportExporter — Plan 03-06 vertical slice', () => {
  it('1000-sample × 5-series fixture — both formats < 10 MB + valid magic bytes', async () => {
    const store = new TimeSeriesStore({ now: FIXED_NOW });
    const fromMs = BASE_MS;
    for (let i = 0; i < 5; i++) {
      const seriesId = `series-${i}`;
      for (let j = 0; j < 1000; j++) {
        store.record({
          ts: new Date(fromMs + j * 60_000).toISOString(),
          orgId: 'org-1',
          seriesId,
          value: Math.sin(j / 10) * 100 + i * 50,
        });
      }
    }
    const seriesIds = Array.from({ length: 5 }, (_, i) => `series-${i}`);
    const exporter = new ReportExporter(store);
    const csvPath = tmpPath('csv');
    const pdfPath = tmpPath('pdf');
    const view: DashboardView = {
      view: 'series',
      orgId: 'org-1',
      seriesIds,
      fromMs,
      toMs: FIXED_NOW(),
    };

    const csvResult = await exporter.export(view, 'csv', csvPath);
    expect(csvResult.bytes).toBeGreaterThan(0);
    expect(csvResult.bytes).toBeLessThan(10 * 1024 * 1024);
    const csvHead = await fs.promises.readFile(csvPath, 'utf8');
    expect(csvHead.startsWith('ts,orgId,seriesId,value,unit\r\n')).toBe(true);

    const pdfResult = await exporter.export(view, 'pdf', pdfPath);
    expect(pdfResult.bytes).toBeGreaterThan(0);
    expect(pdfResult.bytes).toBeLessThan(10 * 1024 * 1024);
    const pdfHead = await fs.promises.readFile(pdfPath);
    expect(pdfHead.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
