/**
 * 1-hour soak harness.
 *
 * Exercises the adapters + orchestrator composition root with a fake VSCode
 * context, then runs a synthetic monitor-like loop for N minutes measuring
 * `process.memoryUsage().rss` every 10 min (or every `SAMPLE_INTERVAL_MINUTES`).
 * Emits the timeline to `reports/soak-baseline.md`.
 *
 * The harness does NOT load the real VSCode extension — that requires
 * running inside the VSCode extension host. Instead it imports `createServices`
 * from `packages/extension/src/services.ts` with a lightweight mock context so
 * adapter lifecycle code (SecretStorage migration, Sentry init no-op, Pino
 * logger, StorageAdapter) is exercised under sustained load. This catches
 * regressions in adapter allocation shapes (listeners, breadcrumb lists, etc.)
 * without requiring `code --extensionDevelopmentPath`.
 *
 * Env vars:
 *   SOAK_MINUTES            (default 60) — total run time
 *   SAMPLE_INTERVAL_MINUTES (default 10) — how often to record RSS
 *
 * Run with:  pnpm soak:test        (60 min, real baseline)
 *            SOAK_MINUTES=1 pnpm soak:test  (smoke test harness itself)
 *
 * Exits 1 if RSS delta (end - start) exceeds 50 MB (hard failure — indicates
 * a regression in adapter or orchestrator hygiene).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface Sample {
  t: string;
  elapsedMinutes: number;
  rssMb: number;
  heapUsedMb: number;
}

const MAX_RSS_DELTA_MB = 50;

function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a minimal VSCode ExtensionContext stub sufficient to construct the
 * composition root's adapters (TelemetryAdapter, StorageAdapter, etc.). No
 * real VSCode APIs are touched — the stubs return deterministic no-op values.
 */
function createFakeContext(): unknown {
  const store = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    subscriptions: [],
    globalState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...store.keys()],
    },
    workspaceState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...store.keys()],
    },
    secrets: {
      get: (key: string) => Promise.resolve(secrets.get(key)),
      store: (key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        secrets.delete(key);
        return Promise.resolve();
      },
      onDidChange: () => ({ dispose: () => {} }),
    },
    extensionUri: { toString: () => 'file:///fake/ext', fsPath: '/fake/ext' },
    extensionPath: '/fake/ext',
  };
}

async function main(): Promise<void> {
  const soakMinutes = Number(process.env.SOAK_MINUTES ?? '60');
  const sampleIntervalMinutes = Math.max(1, Number(process.env.SAMPLE_INTERVAL_MINUTES ?? '10'));

  // eslint-disable-next-line no-console
  console.log(
    `[soak-test] starting — duration=${soakMinutes}min, sampleInterval=${sampleIntervalMinutes}min`,
  );

  // Try to exercise createServices with the fake context. If the import fails
  // (e.g. vscode/node_modules shim not set up), fall back to a pure memory
  // loop that still measures the harness itself — that's valuable as a canary.
  let exerciseCycle: () => Promise<void> = async () => {
    // Fallback: allocate+free a small workload to keep GC busy.
    const tmp: number[] = new Array(10_000).fill(0).map((_, i) => i);
    tmp.sort(() => Math.random() - 0.5);
    await sleep(50);
  };

  try {
    // Dynamic import so the harness runs on machines without a built extension.
    // Import path is resolved relative to the repo root when tsx runs this file.
    const servicesModule = (await import('../packages/extension/src/services.js')) as {
      createServices: (ctx: unknown) => {
        telemetry: { addBreadcrumb: (...args: unknown[]) => void };
      };
    };
    const fakeCtx = createFakeContext();
    const services = servicesModule.createServices(fakeCtx);
    exerciseCycle = async () => {
      // Emit a telemetry breadcrumb every cycle — hits Pino logger + Sentry
      // breadcrumb buffer. This is the "monitor cycle" stand-in.
      services.telemetry.addBreadcrumb('soak cycle', 'soak', 'info');
      await sleep(50);
    };
    // eslint-disable-next-line no-console
    console.log('[soak-test] composition root wired — exercising telemetry loop');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[soak-test] composition root unavailable — falling back to allocation loop. Reason:',
      (err as Error).message,
    );
  }

  const samples: Sample[] = [];
  const start = Date.now();
  const runMs = soakMinutes * 60 * 1000;
  const intervalMs = sampleIntervalMinutes * 60 * 1000;

  const recordSample = (): void => {
    const m = process.memoryUsage();
    samples.push({
      t: new Date().toISOString(),
      elapsedMinutes: Math.round(((Date.now() - start) / 60_000) * 100) / 100,
      rssMb: toMb(m.rss),
      heapUsedMb: toMb(m.heapUsed),
    });
  };

  recordSample();

  // Loop: run exerciseCycle as fast as practical, but record RSS at intervals.
  let nextSampleAt = Date.now() + intervalMs;
  while (Date.now() - start < runMs) {
    await exerciseCycle();
    if (Date.now() >= nextSampleAt) {
      recordSample();
      nextSampleAt = Date.now() + intervalMs;
    }
  }

  recordSample();

  const startRss = samples[0].rssMb;
  const endRss = samples[samples.length - 1].rssMb;
  const delta = Math.round((endRss - startRss) * 100) / 100;
  const maxRss = Math.max(...samples.map((s) => s.rssMb));

  const outPath = 'reports/soak-baseline.md';
  mkdirSync(dirname(outPath), { recursive: true });

  const rows = samples
    .map(
      (s) =>
        `| ${s.t} | ${s.elapsedMinutes.toFixed(2)} | ${s.rssMb.toFixed(2)} | ${s.heapUsedMb.toFixed(2)} |`,
    )
    .join('\n');

  const verdict = delta <= MAX_RSS_DELTA_MB ? 'PASS' : 'FAIL';

  const lines = [
    '# Soak Test Baseline',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Duration:** ${soakMinutes} minute(s)`,
    `**Sample interval:** ${sampleIntervalMinutes} minute(s)`,
    `**Verdict:** **${verdict}** (threshold: +${MAX_RSS_DELTA_MB} MB RSS)`,
    '',
    '## Summary',
    '',
    `- Start RSS: **${startRss.toFixed(2)} MB**`,
    `- End RSS: **${endRss.toFixed(2)} MB**`,
    `- Delta: **${delta >= 0 ? '+' : ''}${delta.toFixed(2)} MB**`,
    `- Peak RSS: **${maxRss.toFixed(2)} MB**`,
    '',
    '## Samples',
    '',
    '| Timestamp | Elapsed (min) | RSS (MB) | Heap used (MB) |',
    '|-----------|---------------|----------|----------------|',
    rows,
    '',
    '## Notes',
    '',
    '- Harness exercises `createServices` with a fake VSCode `ExtensionContext` — no extension host required.',
    '- A `soak cycle` breadcrumb is emitted per iteration; on machines without the composition root available, an allocation loop keeps GC busy.',
    '- This harness is NOT wired into CI by default — run locally or in nightly.',
    '',
  ];

  writeFileSync(outPath, lines.join('\n'), 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `[soak-test] done — start=${startRss.toFixed(2)}MB end=${endRss.toFixed(2)}MB delta=${delta.toFixed(2)}MB verdict=${verdict}. Report: ${outPath}`,
  );

  if (verdict === 'FAIL') {
    process.exit(1);
  }
}

void main();
