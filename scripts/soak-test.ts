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
 * `services.ts` imports `vscode`, a module that only exists inside the host.
 * The harness resolves that name to an in-file stand-in before loading the
 * composition root. It used to skip that step, fail the import, fall back to
 * sorting an array for an hour and report PASS — a soak of nothing. A
 * composition root that does not load is now exit 1, never a fallback.
 *
 * Env vars:
 *   SOAK_MINUTES            (default 60) — total run time
 *   SAMPLE_INTERVAL_MINUTES (default 10) — how often to record RSS
 *
 * Run with:  pnpm soak:test        (60 min, real baseline)
 *            SOAK_MINUTES=1 pnpm soak:test  (smoke test harness itself)
 *
 * Exits 1 if the composition root fails to load, if a message-broker cycle
 * leaves a panel registered, or if RSS delta (end - start) exceeds 50 MB
 * (hard failure — indicates a regression in adapter or orchestrator hygiene).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import Module from 'node:module';
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

/**
 * The part of the `vscode` API the composition root touches while it is built
 * and while telemetry is emitted: settings are read (and answer their
 * defaults), no workspace is open, telemetry is off.
 */
const vscodeStandIn = {
  env: { isTelemetryEnabled: false },
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
      update: (): Promise<void> => Promise.resolve(),
    }),
    workspaceFolders: undefined,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
};

/** Cache key the stand-in is registered under. */
const VSCODE_ID = 'vscode';

/** The CommonJS loader internals the alias needs; tsx runs this file as CommonJS. */
interface CommonJsLoader {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
  _cache: Record<string, unknown>;
}

/**
 * Make `require('vscode')` return {@link vscodeStandIn}.
 *
 * Resolution is redirected for that one name and every other request goes
 * through untouched; the stand-in is pre-seeded in the module cache under the
 * id the redirect returns, so the loader serves it without reading a file.
 */
function aliasVscodeToStandIn(): void {
  const loader = Module as unknown as CommonJsLoader;
  const resolve = loader._resolveFilename;
  loader._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === VSCODE_ID) return VSCODE_ID;
    return resolve.call(this, request, ...rest);
  };
  loader._cache[VSCODE_ID] = {
    id: VSCODE_ID,
    filename: VSCODE_ID,
    loaded: true,
    exports: vscodeStandIn,
    children: [],
  };
}

/** A webview panel as far as the broker can tell: it posts and it listens. */
function createFakePanel(): unknown {
  return {
    webview: {
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
  };
}

async function main(): Promise<void> {
  const soakMinutes = Number(process.env.SOAK_MINUTES ?? '60');
  const sampleIntervalMinutes = Math.max(1, Number(process.env.SAMPLE_INTERVAL_MINUTES ?? '10'));

  // eslint-disable-next-line no-console
  console.log(
    `[soak-test] starting — duration=${soakMinutes}min, sampleInterval=${sampleIntervalMinutes}min`,
  );

  let exerciseCycle: () => Promise<void>;
  let broker: { panelCount: number };

  try {
    aliasVscodeToStandIn();
    // Resolved relative to this file, so the harness can run from any cwd.
    const servicesModule = (await import('../packages/extension/src/services.js')) as {
      createServices: (ctx: unknown) => {
        telemetry: { addBreadcrumb: (...args: unknown[]) => void };
      };
    };
    const brokerModule = (await import('../packages/extension/src/bridge/MessageBroker.js')) as {
      MessageBroker: new () => {
        registerPanel: (panel: unknown) => { dispose: () => void };
        on: (type: string, handler: (msg: unknown) => void) => () => void;
        postToWebview: (message: unknown) => void;
        readonly panelCount: number;
      };
    };
    const services = servicesModule.createServices(createFakeContext());
    const messageBroker = new brokerModule.MessageBroker();
    broker = messageBroker;
    let cycle = 0;
    exerciseCycle = async () => {
      // Emit a telemetry breadcrumb every cycle — hits Pino logger + Sentry
      // breadcrumb buffer.
      services.telemetry.addBreadcrumb('soak cycle', 'soak', 'info');
      // A panel opened, answered and closed, as the Monitor view does on every
      // show/hide: whatever registration it leaves behind accumulates here.
      const registration = messageBroker.registerPanel(createFakePanel());
      const unsubscribe = messageBroker.on('monitor:data', () => {});
      messageBroker.postToWebview({
        id: `soak-${++cycle}`,
        type: 'monitor:data',
        timestamp: Date.now(),
        payload: { healthScore: 100 },
      });
      unsubscribe();
      registration.dispose();
      await sleep(50);
    };
    // eslint-disable-next-line no-console
    console.log('[soak-test] composition root wired — exercising telemetry and broker loop');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[soak-test] composition root failed to load — nothing to soak. Reason:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
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

  // Every cycle disposed what it registered; a panel still counted is a leak
  // whatever the RSS says.
  const leakedPanels = broker.panelCount;
  const verdict = delta <= MAX_RSS_DELTA_MB && leakedPanels === 0 ? 'PASS' : 'FAIL';

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
    `- Panels left registered: **${leakedPanels}**`,
    '',
    '## Samples',
    '',
    '| Timestamp | Elapsed (min) | RSS (MB) | Heap used (MB) |',
    '|-----------|---------------|----------|----------------|',
    rows,
    '',
    '## Notes',
    '',
    '- Harness exercises `createServices` with a fake VSCode `ExtensionContext` and a `vscode` stand-in — no extension host required.',
    '- Each iteration emits a `soak cycle` breadcrumb and registers, posts to and disposes a webview panel on the message broker.',
    '- A composition root that fails to load ends the run with exit 1; there is no fallback workload.',
    '- Runs weekly in CI (`.github/workflows/soak.yml`) and on demand.',
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
