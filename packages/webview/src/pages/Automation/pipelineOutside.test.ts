import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import type { PipelineDefinition, PipelineRunsOutside } from '@sandforge/shared';
import {
  historyOutsideLine,
  outsideSinceLine,
  resumedLine,
  resumedPipeline,
  runnerBadgeWords,
  runnerWords,
} from './pipelineOutside';

const t = i18n.getFixedT('en');

const OUTSIDE: PipelineRunsOutside = {
  since: '2026-11-20T08:00:00.000Z',
  runner: 'taskScheduler',
  file: 'nightly.sandforge-pipeline.json',
  digest: `sha256:${'f'.repeat(64)}`,
};

describe('pipelineOutside', () => {
  it('names each launcher in a sentence, and by its scheduler alone on a badge', () => {
    expect(runnerWords('cron', t)).toBe('cron (bash launcher)');
    expect(runnerWords('taskScheduler', t)).toBe('Task Scheduler (PowerShell launcher)');
    expect(runnerWords('githubActions', t)).toBe('GitHub Actions');
    expect(runnerBadgeWords('taskScheduler', t)).toBe('Task Scheduler');
  });

  it('says who starts the pipeline, since when and from which file', () => {
    expect(outsideSinceLine(OUTSIDE, t)).toMatch(
      /^Started by Task Scheduler \(PowerShell launcher\) since .+ \(file nightly\.sandforge-pipeline\.json\): its schedule is off in VS Code\.$/,
    );
    expect(outsideSinceLine({ ...OUTSIDE, since: 'not a date' }, t)).toContain('since unknown');
  });

  it('says what to remove once the schedule is given back, by what started it', () => {
    expect(resumedLine('cron', t)).toContain('Remove its line from the crontab');
    expect(resumedLine('taskScheduler', t)).toContain('Delete its task in Task Scheduler');
    expect(resumedLine('githubActions', t)).toContain('Delete or disable its workflow on GitHub');
  });

  it('says History lists the runs of this machine and not a CI’s', () => {
    expect(historyOutsideLine('Nightly', OUTSIDE, t)).toContain(
      'Its runs on this machine show here',
    );
    expect(historyOutsideLine('Nightly', { ...OUTSIDE, runner: 'githubActions' }, t)).toContain(
      'Its runs there do not show here',
    );
  });

  it('gives the schedule back: the schedule triggers with a line on, the hand-over gone', () => {
    const pipeline = {
      id: 'p',
      name: 'Nightly',
      description: '',
      version: 1,
      steps: [],
      triggers: [
        { id: 'a', type: 'schedule', enabled: false, config: { cron: '0 2 * * *' } },
        { id: 'b', type: 'schedule', enabled: false, config: { cron: '  ' } },
        { id: 'c', type: 'sandbox_refresh', enabled: false, config: { orgId: 'o' } },
      ],
      variables: [],
      tags: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      runsOutside: OUTSIDE,
    } as PipelineDefinition;

    const resumed = resumedPipeline(pipeline);

    expect(resumed.triggers.map((trigger) => [trigger.id, trigger.enabled])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
    expect(resumed).not.toHaveProperty('runsOutside');
    expect(pipeline.runsOutside).toEqual(OUTSIDE);
  });
});
