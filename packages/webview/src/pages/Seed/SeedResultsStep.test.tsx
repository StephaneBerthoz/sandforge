import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { SeedExecutionResult, SeedObjectResult, SeedTemplate } from '@sandforge/shared';
import '../../i18n';
import { SeedResultsStep } from './SeedResultsStep';

const saveTemplateMutate = vi.hoisted(() => vi.fn());
const fileSaveMutate = vi.hoisted(() => vi.fn());
const saveTemplateState = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  loading: false,
  /** Whether a file save is waiting on the host's dialog. */
  saving: false,
  /** Use the real request hook, answered through window messages. */
  real: false,
}));

vi.mock('../../hooks/useBridgeMutation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useBridgeMutation')>();
  return {
    useBridgeMutation: (...args: Parameters<typeof actual.useBridgeMutation>) => {
      if (saveTemplateState.real) return actual.useBridgeMutation(...args);
      // The export goes through `file:save`, the template through its own route.
      if (args[0] === 'file:save') {
        return {
          mutate: fileSaveMutate,
          data: null,
          loading: saveTemplateState.saving,
          error: null,
          reset: vi.fn(),
          requestId: null,
        };
      }
      return {
        mutate: saveTemplateMutate,
        data: saveTemplateState.data,
        loading: saveTemplateState.loading,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
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
    fileSaveMutate.mockClear();
    saveTemplateState.data = null;
    saveTemplateState.loading = false;
    saveTemplateState.saving = false;
    saveTemplateState.real = false;
    mockVSCodeApi.postMessage.mockClear();
  });

  it('exports, per object, the records asked for, created and failed, and the ids created', () => {
    // The button had no handler: every results step offered an export that
    // saved nothing.
    const template = seedTemplate();
    template.objects.push({ ...template.objects[0], objectApiName: 'Account', recordCount: 5 });
    render(
      <SeedResultsStep
        executionResult={executionResult([
          objectResult({
            recordsCreated: 8,
            recordsFailed: 2,
            createdIds: ['003000000000001AAA', '003000000000002AAA'],
            truncated: true,
          }),
          objectResult({
            objectApiName: 'Account',
            recordsCreated: 5,
            createdIds: [1, 2, 3, 4, 5].map((n) => `00100000000000${n}AAA`),
          }),
        ])}
        onSeedAgain={vi.fn()}
        template={template}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-export-csv'));

    expect(fileSaveMutate).toHaveBeenCalledTimes(1);
    const sent = fileSaveMutate.mock.calls[0][0] as {
      suggestedName: string;
      content: string;
      extensions: string[];
    };
    expect(sent.suggestedName).toMatch(/^sandforge-seed-results-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(sent.extensions).toEqual(['csv']);
    expect(sent.content.split('\n')).toEqual([
      '"Object","Requested","Created","Failed","Created IDs","Created IDs not listed"',
      // Only the first ids of a long list reach the step; the rest are counted.
      '"Contact","10","8","2","003000000000001AAA 003000000000002AAA","6"',
      '"Account","5","5","0","001000000000001AAA 001000000000002AAA 001000000000003AAA 001000000000004AAA 001000000000005AAA","0"',
    ]);
    expect(saveTemplateMutate).not.toHaveBeenCalled();
  });

  it('leaves the requested count empty when the step has no template', () => {
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult({ createdIds: [] })])}
        onSeedAgain={vi.fn()}
        template={null}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-export-csv'));

    const { content } = fileSaveMutate.mock.calls[0][0] as { content: string };
    expect(content.split('\n')[1]).toBe('"Contact","","10","0","","10"');
  });

  it('cannot export twice while the host’s save dialog is open', () => {
    saveTemplateState.saving = true;
    render(
      <SeedResultsStep
        executionResult={executionResult([objectResult()])}
        onSeedAgain={vi.fn()}
        template={seedTemplate()}
      />,
    );

    expect((screen.getByTestId('btn-export-csv') as HTMLButtonElement).disabled).toBe(true);
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
