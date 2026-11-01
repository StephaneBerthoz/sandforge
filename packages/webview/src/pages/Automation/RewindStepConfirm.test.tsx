import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '../../i18n';
import type { PipelineStep } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import { useOrgStore } from '../../stores/useOrgStore';
import {
  developerOrg,
  fakeHost,
  previewAnswer,
  readyCheckpoint,
} from '../Checkpoint/testing/checkpointFixtures';
import type { FakeHost } from '../Checkpoint/testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { StepConfigPanel } from './StepConfigPanel';
import { RewindStepConfirm } from './RewindStepConfirm';

const CHECKPOINT_ID = 'ck-20261020-140512-a1b2';

const step: PipelineStep = {
  id: 'step-r',
  name: 'Nightly reset',
  type: 'rewind',
  config: { orgId: 'org-dev', checkpointId: CHECKPOINT_ID, maxRecords: 1500 },
  continueOnError: false,
};

beforeEach(() => {
  host.current = fakeHost();
  useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: 'org-dev' });
});
afterEach(() => {
  useOrgStore.setState({ orgs: [], selectedOrgId: null });
});

describe('RewindStepConfirm', () => {
  function renderConfirm(answer?: Parameters<typeof RewindStepConfirm>[0]['answer']) {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <RewindStepConfirm
        step={step}
        org={developerOrg()}
        checkpoint={readyCheckpoint()}
        onClose={onClose}
        onConfirm={onConfirm}
        answer={answer ?? null}
      />,
    );
    return { onConfirm, onClose };
  }

  it('reads the preview of the rewind from the org, and offers no Rewind of its own', () => {
    renderConfirm();
    expect(host.current?.lastPayload('checkpoint:preview')).toEqual({
      checkpointId: CHECKPOINT_ID,
    });
    act(() =>
      host.current?.answer('checkpoint:preview', 'checkpoint:preview:response', previewAnswer()),
    );
    expect(screen.getByTestId('rewind-step-confirm-lead').textContent).toContain('1,500 records');
    expect(screen.queryByTestId('checkpoint-preview-rewind')).toBeNull();
    expect(host.current?.sent('checkpoint:rewind')).toEqual([]);
  });

  it('asks for the alias under a button and a dialog that say what it allows, in three different words', () => {
    // "Confirm this rewind…", "Confirm for this step…", then a dialog titled
    // as the section above it: three confirmations in a row.
    renderConfirm();
    expect(screen.getByTestId('rewind-step-confirm-type').textContent).toBe(
      'Type the org alias to confirm…',
    );
    fireEvent.click(screen.getByTestId('rewind-step-confirm-type'));
    expect(screen.getByTestId('danger-title').textContent).toBe(
      'Allow unattended rewinds of DEV-SB',
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Each run, scheduled ones included, rewinds DEV-SB to “');
    expect(dialog.textContent).toContain('(at most 1,500 records)');
    expect(dialog.textContent).toContain('Editing this step cancels the confirmation.');
    // The section keeps its heading; the dialog no longer repeats it.
    expect(screen.getAllByText('Confirm the Rewind step “Nightly reset”')).toHaveLength(1);
  });

  it("confirms with the org's alias once it is typed exactly, and not before", () => {
    const { onConfirm } = renderConfirm();
    fireEvent.click(screen.getByTestId('rewind-step-confirm-type'));
    const confirm = screen.getByTestId('danger-confirm-btn');
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'dev-sb' } });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DEV-SB' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledWith('DEV-SB');
  });

  it("says why the extension kept no confirmation, in the reader's words", () => {
    renderConfirm({
      granted: false,
      pipelineId: 'p-1',
      stepId: 'step-r',
      code: 'TYPED_MISMATCH',
    });
    expect(screen.getByTestId('rewind-grant-refused').textContent).toBe(
      "What was typed is not the org's alias: nothing was confirmed.",
    );
  });
});

describe('StepConfigPanel, a Rewind step', () => {
  function renderPanel(rewind: Parameters<typeof StepConfigPanel>[0]['rewind']) {
    const onUpdate = vi.fn();
    render(<StepConfigPanel step={step} onUpdate={onUpdate} rewind={rewind} />);
    act(() =>
      host.current?.answer('checkpoint:list', 'checkpoint:list:response', {
        checkpoints: [
          {
            checkpointId: CHECKPOINT_ID,
            organizationId: '00Dxx0000001234AAA',
            checkpoint: readyCheckpoint(),
            valid: true,
          },
        ],
      }),
    );
    return { onUpdate };
  }

  it('lists the checkpoints of its org kept here, and asks for them of that org', () => {
    renderPanel({ steps: [], blocker: 'rewindNotConfirmed' });
    expect(host.current?.lastPayload('checkpoint:list')).toEqual({ orgId: 'org-dev' });
    const select = screen.getByTestId('config-checkpointId') as HTMLSelectElement;
    expect(select.value).toBe(CHECKPOINT_ID);
  });

  it('offers to confirm a saved step, and opens its preview with its checkpoint', () => {
    const onPreview = vi.fn();
    renderPanel({ steps: [], blocker: 'rewindNotConfirmed', onPreview });
    expect(screen.getByTestId('rewind-confirmation-status').textContent).toContain('Not confirmed');
    fireEvent.click(screen.getByTestId('rewind-confirm'));
    expect(onPreview).toHaveBeenCalledWith(
      'step-r',
      expect.objectContaining({ checkpointId: CHECKPOINT_ID }),
    );
  });

  it('asks to save first a step not saved as it stands, and offers no confirmation', () => {
    const onPreview = vi.fn();
    renderPanel({ steps: [], blocker: 'rewindNotSaved', onPreview });
    expect(screen.getByTestId('rewind-confirmation-status').textContent).toBe(
      'Save the pipeline, then confirm this rewind.',
    );
    expect(screen.getByTestId('rewind-confirm')).toHaveProperty('disabled', true);
  });

  it('says when it was confirmed, and for what, and takes the confirmation back', () => {
    const onRevoke = vi.fn();
    renderPanel({
      steps: [
        {
          stepId: 'step-r',
          checkpointId: CHECKPOINT_ID,
          valid: true,
          granted: { at: '2026-10-29T09:00:00.000Z', digestMatches: true },
        },
      ],
      onRevoke,
    });
    const status = screen.getByTestId('rewind-confirmation-status').textContent ?? '';
    expect(status).toMatch(/^Confirmed on /);
    expect(status).toContain('this step rewinds DEV-SB to');
    expect(status).toContain('at most 1,500 records');
    expect(status).toContain('reverting or deleting every change anyone made since');
    expect(screen.getByTestId('rewind-revoke').textContent).toBe('Revoke confirmation');
    fireEvent.click(screen.getByTestId('rewind-revoke'));
    expect(onRevoke).toHaveBeenCalledWith('step-r');
  });

  it('groups the acceptances under a heading saying they widen the risk, folded while none is ticked', () => {
    // Five boxes stood unlabelled in the column, worded to be read twice.
    renderPanel({ steps: [] });
    const group = screen.getByTestId('rewind-acceptances');
    expect(group.tagName).toBe('DETAILS');
    expect(group.hasAttribute('open')).toBe(false);
    expect(group.querySelector('summary')?.textContent).toBe(
      'Allow riskier changes (off by default)',
    );
    const boxes = screen.getByRole('group', { name: 'Allow riskier changes (off by default)' });
    expect(Array.from(boxes.querySelectorAll('label'), (label) => label.textContent)).toEqual([
      'Run even if triggers, flows or workflow rules fire on the records it writes',
      'Allow deletions that Undo of this rewind cannot bring back',
      'Recreate, with new Ids, records already emptied from the Recycle Bin',
      'Allow deletions that cascade to child records of objects outside the checkpoint',
      'Allow deletions that cascade to records the connected user may not see (no View All Data or Modify All Data)',
    ]);
    expect(screen.queryByTestId('rewind-acceptances-count')).toBeNull();
  });

  it('opens the acceptances of a step that gives one, and counts them on the heading', () => {
    const onUpdate = vi.fn();
    render(
      <StepConfigPanel
        step={{ ...step, config: { ...step.config, acceptNoUndo: true, acceptUnseen: true } }}
        onUpdate={onUpdate}
        rewind={{ steps: [] }}
      />,
    );
    expect(screen.getByTestId('rewind-acceptances').hasAttribute('open')).toBe(true);
    expect(screen.getByTestId('rewind-acceptances-count').textContent).toBe('2 ticked');
  });

  it('words each box as the Checkpoints preview words the same box, in every language', () => {
    // Two places asked the same question in different words; the German
    // acceptUnseen said the opposite of the English.
    const boxOf = {
      acceptAutomation: 'automation',
      acceptNoUndo: 'undoCannot',
      acceptRecreate: 'recreate',
      acceptOutside: 'outside',
      acceptUnseen: 'unseen',
    } as const;
    for (const catalogue of [en, fr, de, es, ptBR, ja]) {
      for (const [key, box] of Object.entries(boxOf)) {
        expect(catalogue.automation.rewindAccept[key as keyof typeof boxOf]).toBe(
          catalogue.checkpoint.preview[box].accept,
        );
      }
    }
    expect(de.automation.rewindAccept.acceptUnseen).toBe(
      'Löschungen erlauben, die Datensätze mitlöschen, deren Sichtbarkeit für den Benutzer nicht nachgewiesen ist (ohne „Alle Daten anzeigen“ und „Alle Daten ändern“)',
    );
  });

  it('names the controls of its confirmation by what each does', () => {
    renderPanel({ steps: [], blocker: 'rewindNotConfirmed', onPreview: vi.fn() });
    expect(screen.getByTestId('rewind-confirm').textContent).toBe('Preview and confirm…');
    expect(screen.getByTestId('rewind-confirmation-status').textContent).toBe(
      "Not confirmed: the step does not run until you click Preview and confirm…, then type the org's alias.",
    );
  });

  it('refuses people at work unless turned off, and gives no acceptance unless ticked', () => {
    const { onUpdate } = renderPanel({ steps: [] });
    expect(screen.getByTestId('config-refuseWhenActive')).toHaveProperty('checked', true);
    for (const key of ['acceptAutomation', 'acceptNoUndo', 'acceptRecreate', 'acceptOutside']) {
      expect(screen.getByTestId(`config-${key}`)).toHaveProperty('checked', false);
    }
    fireEvent.click(screen.getByTestId('config-acceptNoUndo'));
    expect(onUpdate).toHaveBeenCalledWith('step-r', {
      config: { ...step.config, acceptNoUndo: true },
    });
  });
});
