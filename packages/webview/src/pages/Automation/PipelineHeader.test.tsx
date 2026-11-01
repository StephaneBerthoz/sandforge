import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { PipelineDefinition } from '@sandforge/shared';
import { PipelineHeader, PIPELINE_NAME_MAX } from './PipelineHeader';
import type { PipelineHeaderProps } from './PipelineHeader';

const PIPELINE: PipelineDefinition = {
  id: 'pipe-1',
  name: 'Nightly refresh',
  description: '',
  version: 1,
  steps: [],
  triggers: [],
  variables: [],
  tags: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function renderHeader(overrides: Partial<PipelineHeaderProps> = {}) {
  const props: PipelineHeaderProps = {
    pipeline: PIPELINE,
    stepCount: 3,
    unsaved: false,
    saving: false,
    running: false,
    runBlocked: false,
    blockedNoticeId: 'blocked-note',
    listOpen: false,
    listId: 'saved-list',
    onCreate: vi.fn(),
    onToggleList: vi.fn(),
    onRename: vi.fn(),
    onSave: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  };
  render(<PipelineHeader {...props} />);
  return props;
}

describe('PipelineHeader', () => {
  it('offers only Create pipeline, and no name, while no pipeline is open', () => {
    const props = renderHeader({ pipeline: undefined, stepCount: 0 });

    fireEvent.click(screen.getByTestId('create-pipeline-btn'));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pipeline-name-input')).toBeNull();
    for (const id of ['new-pipeline-btn', 'open-pipeline-btn', 'save-pipeline-btn']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.getByTestId('page-header-subtitle').textContent).toBe(
      'Compose and save multi-step pipelines',
    );
  });

  it('holds the name of the pipeline in a labelled field, and renames it as it is typed', () => {
    const props = renderHeader();

    const field = screen.getByLabelText('Pipeline name') as HTMLInputElement;
    expect(field.value).toBe('Nightly refresh');
    expect(field.maxLength).toBe(PIPELINE_NAME_MAX);
    fireEvent.change(field, { target: { value: 'Nightly refresh of UAT' } });

    expect(props.onRename).toHaveBeenCalledWith('Nightly refresh of UAT');
    expect(screen.getByTestId('pipeline-meta').textContent).toBe('v1 · 3 steps');
  });

  it('puts New, Open…, Save and Run side by side, each to its own handler', () => {
    const props = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Pipeline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Pipeline' }));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
    expect(props.onToggleList).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onRun).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('create-pipeline-btn')).toBeNull();
  });

  it('says when the pipeline holds unsaved changes, and only then', () => {
    renderHeader({ unsaved: true });
    expect(screen.getByTestId('pipeline-unsaved').textContent).toBe('Unsaved changes');
  });

  it('shows no unsaved mark on a pipeline as saved', () => {
    renderHeader({ unsaved: false });
    expect(screen.queryByTestId('pipeline-unsaved')).toBeNull();
  });

  it('refuses to save or run a pipeline whose name is blank, and says why', () => {
    renderHeader({ pipeline: { ...PIPELINE, name: '   ' } });

    const error = screen.getByRole('alert');
    expect(error.textContent).toBe('Name the pipeline to save or run it.');
    const save = screen.getByTestId('save-pipeline-btn');
    const run = screen.getByTestId('run-pipeline-btn');
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(save.getAttribute('aria-describedby')).toBe(error.id);
    expect(run.getAttribute('aria-describedby')).toBe(error.id);
    expect(screen.getByLabelText('Pipeline name').getAttribute('aria-invalid')).toBe('true');
  });

  it('ties Run to both reasons when a blank name and a blocked step both hold it', () => {
    renderHeader({ pipeline: { ...PIPELINE, name: '' }, runBlocked: true });

    const error = screen.getByRole('alert');
    expect(screen.getByTestId('run-pipeline-btn').getAttribute('aria-describedby')).toBe(
      `blocked-note ${error.id}`,
    );
  });

  it('ties Run to the note naming the steps that block it, and keeps Save on', () => {
    renderHeader({ runBlocked: true });

    const run = screen.getByTestId('run-pipeline-btn') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.getAttribute('aria-describedby')).toBe('blocked-note');
    expect((screen.getByTestId('save-pipeline-btn') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says Open… controls the saved list only while that list is there', () => {
    renderHeader({ listOpen: false });
    const open = screen.getByTestId('open-pipeline-btn');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(open.hasAttribute('aria-controls')).toBe(false);
  });

  it('points Open… at the saved list once it is open', () => {
    renderHeader({ listOpen: true });
    const open = screen.getByTestId('open-pipeline-btn');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.getAttribute('aria-controls')).toBe('saved-list');
  });

  it('keeps New and Open… off while a run draws its progress on the pipeline', () => {
    renderHeader({ running: true });

    expect((screen.getByTestId('new-pipeline-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('open-pipeline-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('run-pipeline-btn').textContent).toContain('Running pipeline...');
  });
});
