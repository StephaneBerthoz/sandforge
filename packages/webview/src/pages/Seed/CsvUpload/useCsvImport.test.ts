import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../../i18n/index';
import { useCsvImport } from './useCsvImport';
import type { TFunction } from 'i18next';

/* -------------------------------------------------------------------------- */
/* Mocks                                                                       */
/* -------------------------------------------------------------------------- */

vi.mock('papaparse', () => ({
  default: {
    parse: vi.fn((input: string, opts?: { preview?: number }) => {
      const lines = input
        .replace(/^\uFEFF/, '')
        .split('\n')
        .filter(Boolean);
      const headerLine = lines[0] ?? '';
      const fields = headerLine.split(',');
      const dataLines = lines.slice(1);
      const limited = opts?.preview ? dataLines.slice(0, opts.preview) : dataLines;
      const data = limited.map((line) => {
        const values = line.split(',');
        const row: Record<string, string> = {};
        fields.forEach((f, i) => {
          row[f] = values[i] ?? '';
        });
        return row;
      });
      return { data, meta: { fields } };
    }),
  },
}));

const mockMutate = vi.fn();
const mockReset = vi.fn();

/** Shared mutable mutation state (one mutation exercised at a time). */
let mockMutationState = {
  mutate: mockMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockReset,
};

/** Every mutation the hook creates, with the error channel it asked for. */
const mutationCalls: Array<{ type: string; errorType?: string }> = [];

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { errorType?: string }) => {
    mutationCalls.push({ type, errorType: options?.errorType });
    return mockMutationState;
  },
}));

const tMock: TFunction = ((key: string) => key) as unknown as TFunction;

describe('useCsvImport', () => {
  beforeEach(() => {
    mockMutate.mockClear();
    mutationCalls.length = 0;
    mockReset.mockClear();
    mockMutationState = {
      mutate: mockMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockReset,
    };
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useCsvImport(tMock));

    expect(result.current.file).toBeNull();
    expect(result.current.headers).toEqual([]);
    expect(result.current.parsedRows).toEqual([]);
    expect(result.current.previewRows).toEqual([]);
    expect(result.current.columnMappings).toEqual([]);
    expect(result.current.step).toBe('upload');
    expect(result.current.executionStatus).toBe('idle');
  });

  it('should parse CSV and populate headers and preview rows on handleFileSelected', async () => {
    const { result } = renderHook(() => useCsvImport(tMock));

    const csvContent = 'Name,Email\nAlice,alice@test.com\nBob,bob@test.com';
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });

    await act(async () => {
      result.current.handleFileSelected(file);
      // Let the File.text() promise resolve
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.headers).toEqual(['Name', 'Email']);
    expect(result.current.previewRows.length).toBe(2);
    expect(result.current.parsedRows.length).toBe(2);
    expect(result.current.file).toBe(file);
  });

  it('should update step via setStep', () => {
    const { result } = renderHook(() => useCsvImport(tMock));

    expect(result.current.step).toBe('upload');

    act(() => {
      result.current.setStep('map');
    });

    expect(result.current.step).toBe('map');

    act(() => {
      result.current.setStep('validate');
    });

    expect(result.current.step).toBe('validate');
  });

  it('should reset all state on reset()', async () => {
    const { result } = renderHook(() => useCsvImport(tMock));

    const csvContent = 'Name\nTest';
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });

    await act(async () => {
      result.current.handleFileSelected(file);
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.file).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.file).toBeNull();
    expect(result.current.headers).toEqual([]);
    expect(result.current.parsedRows).toEqual([]);
    expect(result.current.previewRows).toEqual([]);
    expect(result.current.step).toBe('upload');
    expect(result.current.executionStatus).toBe('idle');
    expect(mockReset).toHaveBeenCalled();
  });

  it('should call mutation on handleObjectSelected', () => {
    const { result } = renderHook(() => useCsvImport(tMock));

    act(() => {
      result.current.handleObjectSelected('org-1', 'Account');
    });

    expect(result.current.targetOrgId).toBe('org-1');
    expect(result.current.targetObjectApiName).toBe('Account');
    expect(mockMutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objectApiName: 'Account',
    });
  });

  it('should call validate mutation on handleValidate', () => {
    const { result } = renderHook(() => useCsvImport(tMock));

    act(() => {
      result.current.handleValidate();
    });

    expect(result.current.executionStatus).toBe('validating');
    expect(mockMutate).toHaveBeenCalled();
  });

  /* ------------------------------------------------------------------ */
  /* Error handling: mutation error + seed:csv:error channel             */
  /* ------------------------------------------------------------------ */

  it('unsticks the validating status when the validate mutation errors', () => {
    const { result, rerender } = renderHook(() => useCsvImport(tMock));

    act(() => {
      result.current.handleValidate();
    });
    expect(result.current.executionStatus).toBe('validating');

    // The mutation reports an error (e.g. bridge timeout) on the next render.
    mockMutationState = { ...mockMutationState, loading: false, error: 'Bridge timeout' };
    act(() => {
      rerender();
    });

    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe('Bridge timeout');
  });

  it('listens for validate and execute failures on seed:csv:error', () => {
    // The handler posts its failures on this channel, correlated to the
    // request, and the mutations listen there themselves. A separate
    // type-only listener used to catch them instead and hand each one to
    // whichever mutation happened to be loading.
    renderHook(() => useCsvImport(tMock));

    expect(mutationCalls).toEqual(
      expect.arrayContaining([
        { type: 'seed:csv:validate', errorType: 'seed:csv:error' },
        { type: 'seed:csv:execute', errorType: 'seed:csv:error' },
      ]),
    );
  });

  it('unsticks the executing status when the execute mutation errors', () => {
    const { result, rerender } = renderHook(() => useCsvImport(tMock));

    act(() => {
      result.current.handleExecute();
    });
    expect(result.current.executionStatus).toBe('executing');

    mockMutationState = { ...mockMutationState, loading: false, error: 'Import exploded' };
    act(() => {
      rerender();
    });

    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe('Import exploded');
  });
});
