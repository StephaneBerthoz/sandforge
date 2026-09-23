import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { SeedExecutionResult, SeedObjectResult, SeedTemplate } from '@sandforge/shared';
import '../../i18n';
import { SeedResultsStep } from './SeedResultsStep';

const saveTemplateMutate = vi.hoisted(() => vi.fn());
const saveTemplateState = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  loading: false,
  /** Use the real request hook, answered through window messages. */
  real: false,
}));

vi.mock('../../hooks/useBridgeMutation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useBridgeMutation')>();
  return {
    useBridgeMutation: (...args: Parameters<typeof actual.useBridgeMutation>) =>
      saveTemplateState.real
        ? actual.useBridgeMutation(...args)
        : {
            mutate: saveTemplateMutate,
            data: saveTemplateState.data,
            loading: saveTemplateState.loading,
            error: null,
            reset: vi.fn(),
            requestId: null,
          },
  };
});

const mockVSCodeApi = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined,
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => mockVSCodeApi,
  useVSCodeApi: () => mockVSCodeApi,
}));

function seedTemplate(): SeedTemplate {
  return {
    id: 'tpl-run',
    name: 'seed-from-ui',
    description: 'Seed from SandForge UI',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Contact',
        recordCount: 10,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [],
      },
    ],
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function objectResult(overrides: Partial<SeedObjectResult> = {}): SeedObjectResult {
  return {
    objectApiName: 'Contact',
    recordsCreated: 10,
    recordsFailed: 0,
    createdIds: [],
    errors: [],
    ...overrides,
  };
}

function executionResult(objectResults: SeedObjectResult[]): SeedExecutionResult {
  return {
    templateId: 'tpl-1',
    operationId: 'op-1',
    status: 'success',
    objectResults,
    totalRecordsCreated: 10,
    totalRecordsFailed: 0,
    duration: 1200,
    timestamp: '2026-01-01T00:00:00Z',
  };
}

describe('SeedResultsStep', () => {
  beforeEach(() => {
    saveTemplateMutate.mockClear();
    saveTemplateState.data = null;
    saveTemplateState.loading = false;
    saveTemplateState.real = false;
    mockVSCodeApi.postMessage.mockClear();
  });

  it('calls a seed a cancel stopped cancelled, not partially complete, with what it created', () => {
    render(
      <SeedResultsStep
        executionResult={{
          ...executionResult([objectResult()]),
          status: 'partial',
          cancelled: true,
        }}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const summary = screen.getByTestId('result-summary');
    expect(summary.textContent).toContain('Cancelled');
    expect(summary.textContent).not.toContain('Partially Complete');
    expect(summary.textContent).toContain('10');
  });

  it('names the fields that received generated sentences instead of AI values', () => {
    render(
      <SeedResultsStep
        executionResult={executionResult([
          objectResult({ aiFallback: { fields: ['Description', 'Title'], reason: 'no-answer' } }),
          objectResult({ objectApiName: 'Account' }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const rows = screen.getAllByTestId('seed-result-ai-fallback');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Description, Title');
  });

  it('says a short AI answer apart from no answer', () => {
    render(
      <SeedResultsStep
        executionResult={executionResult([
          objectResult({ aiFallback: { fields: ['Title'], reason: 'short-answer' } }),
        ])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    const row = screen.getByTestId('seed-result-ai-fallback');
    expect(row.textContent).toContain('Title');
    expect(row.textContent).toContain('left values out');
    expect(row.textContent).not.toContain('refused');
  });

  it('shows no fallback row when every AI field got an AI value', () => {
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.queryByTestId('seed-result-ai-fallback')).toBeNull();
  });

  it('saves the run as a template named after the objects it seeded', () => {
    // The button was inert: the route that stores a template had no sender, so
    // a configuration worth keeping had to be rebuilt by hand every time.
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-save-template'));

    expect(saveTemplateMutate).toHaveBeenCalledTimes(1);
    const saved = (saveTemplateMutate.mock.calls[0][0] as { template: Record<string, unknown> })
      .template;
    expect(saved.name).toContain('Contact');
    expect(saved.id).toBeUndefined();
    expect((saved.objects as Array<{ recordCount: number }>)[0].recordCount).toBe(10);
  });

  it('cannot save a template before a run has produced one', () => {
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={null}
      />,
    );

    expect((screen.getByTestId('btn-save-template') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the template was saved once the host confirms it', () => {
    saveTemplateState.data = { success: true, id: 'tpl-7' };
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect(screen.getByTestId('seed-template-saved').textContent).toContain('saved');
  });

  it('shows why the host refused to save the template', () => {
    // A refused save left the button looking as inert as before it was wired.
    saveTemplateState.real = true;
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-save-template'));
    const sent = mockVSCodeApi.postMessage.mock.calls[0][0] as {
      payload: { id: string; type: string };
    };
    expect(sent.payload.type).toBe('seed:template:save');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'ext-err',
            type: 'seed:error',
            timestamp: Date.now(),
            correlationId: sent.payload.id,
            payload: { message: 'Template storage is full' },
          },
        }),
      );
    });

    expect(screen.getByTestId('seed-template-save-error').textContent).toContain(
      'Template storage is full',
    );
  });

  it('cannot save the same run twice while the first save is in flight', () => {
    saveTemplateState.loading = true;
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect((screen.getByTestId('btn-save-template') as HTMLButtonElement).disabled).toBe(true);
  });
});
