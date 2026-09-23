import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `l10n.t` with the host's semantics: the source string looked up in a bundle,
// falling back to itself, then `{0}` interpolated. Tests load a real bundle,
// so a notice missing from it shows up as English where French was expected.
const l10nBundle = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  l10n: {
    t: (message: string, ...args: unknown[]): string =>
      (l10nBundle.current[message] ?? message).replace(/\{(\d+)\}/g, (_m, i: string) =>
        String(args[Number(i)] ?? ''),
      ),
  },
}));

import * as vscode from 'vscode';
import { pipelineTriggerNotice, wirePipelineTriggers } from './pipelineTriggerComposition';
import type { PipelineTriggerWiring } from '../bridge/handlers/AutomationHandler';
import type { TriggerReport } from '../modules/automation/PipelineTriggerScheduler';

function bundle(locale: string): Record<string, string> {
  const file = locale === 'en' ? 'bundle.l10n.json' : `bundle.l10n.${locale}.json`;
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'l10n', file), 'utf8')) as Record<
    string,
    string
  >;
}

const missedWhileClosed: TriggerReport = {
  kind: 'missed',
  pipelineName: 'Nightly backup',
  triggeredBy: 'schedule',
  dueAt: '2026-09-23T02:00:00.000Z',
  missed: { reason: 'closed', count: 1 },
  nextRunAt: '2026-09-24T02:00:00.000Z',
};

describe('what the user is told of a pipeline trigger', () => {
  beforeEach(() => {
    l10nBundle.current = bundle('en');
  });

  it('says a start fell due while VS Code was closed, and that it was not made late', () => {
    const notice = pipelineTriggerNotice(missedWhileClosed);
    expect(notice).toContain('"Nightly backup"');
    expect(notice).toContain('while VS Code was closed');
    expect(notice).toContain('not started late');
  });

  it('counts the starts missed during a long absence, and says when there were more', () => {
    const notice = pipelineTriggerNotice({
      ...missedWhileClosed,
      missed: { reason: 'closed', count: 51, atLeast: true, lastDueAt: '2026-09-23T02:50:00.000Z' },
    });
    expect(notice).toContain('missed 51+ scheduled starts');
  });

  it('tells a start the computer slept through from one VS Code was closed for', () => {
    const notice = pipelineTriggerNotice({
      ...missedWhileClosed,
      missed: { reason: 'asleep', count: 1 },
    });
    expect(notice).toContain('as when the computer sleeps');
    expect(notice).not.toContain('closed');
  });

  it('says a pipeline runs once at a time when a run holds up a start', () => {
    const notice = pipelineTriggerNotice({
      ...missedWhileClosed,
      missed: { reason: 'busy', count: 1, busySince: '2026-09-23T01:55:00.000Z' },
    });
    expect(notice).toContain('was still going');
    expect(notice).toContain('never runs twice at once');
  });

  it('names the sandbox whose refresh did not start a pipeline, and the step in the way', () => {
    const notice = pipelineTriggerNotice({
      kind: 'missed',
      pipelineName: 'After refresh',
      triggeredBy: 'sandbox_refresh',
      dueAt: '2026-09-23T02:00:00.000Z',
      missed: {
        reason: 'cannotRun',
        count: 1,
        detail: 'Pipeline step "Mask" (anonymize) cannot run in a pipeline.',
      },
      sandboxName: 'uat',
    });
    expect(notice).toContain('sandbox uat');
    expect(notice).toContain('"After refresh"');
    expect(notice).toContain('"Mask" (anonymize) cannot run');
  });

  it('says what started a run that failed', () => {
    expect(
      pipelineTriggerNotice({
        kind: 'failed',
        pipelineName: 'Nightly compare',
        triggeredBy: 'schedule',
        error: 'org unreachable',
      }),
    ).toBe(
      'SandForge: pipeline "Nightly compare", started by its schedule, failed: org unreachable',
    );
    expect(
      pipelineTriggerNotice({
        kind: 'failed',
        pipelineName: 'After refresh',
        triggeredBy: 'sandbox_refresh',
        error: 'org unreachable',
        sandboxName: 'uat',
      }),
    ).toBe(
      'SandForge: pipeline "After refresh", started by the refresh of sandbox uat, failed: org unreachable',
    );
  });

  it('speaks the editor language', () => {
    l10nBundle.current = bundle('fr');
    expect(pipelineTriggerNotice(missedWhileClosed)).toMatch(
      /^SandForge : le pipeline « Nightly backup » était prévu le .+, pendant que VS Code était fermé\./,
    );
  });
});

describe('starting the pipeline triggers', () => {
  let storage: string;

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'sandforge-storage-'));
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    vi.mocked(vscode.window.showErrorMessage).mockReset();
    l10nBundle.current = bundle('en');
  });

  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  it('shares its claims with the other windows through the global storage, and stops on dispose', () => {
    let wiring: PipelineTriggerWiring | undefined;
    const stop = vi.fn();
    const disposable = wirePipelineTriggers(
      (given) => {
        wiring = given;
      },
      stop,
      storage,
      () => undefined,
    );
    expect(wiring?.claims?.claim('due:p1:t1:1000')).toBe(true);
    expect(readdirSync(join(storage, 'pipeline-triggers', 'claims'))).toHaveLength(1);

    disposable.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('shows a missed start as a warning, a failed run as an error, and logs both', () => {
    let wiring: PipelineTriggerWiring | undefined;
    const logged: string[] = [];
    wirePipelineTriggers(
      (given) => {
        wiring = given;
      },
      () => undefined,
      storage,
      (line) => logged.push(line),
    );
    wiring?.report(missedWhileClosed);
    wiring?.report({
      kind: 'failed',
      pipelineName: 'Nightly compare',
      triggeredBy: 'schedule',
      error: 'org unreachable',
    });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('"Nightly backup"'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed: org unreachable'),
    );
    expect(logged).toHaveLength(2);
  });
});
