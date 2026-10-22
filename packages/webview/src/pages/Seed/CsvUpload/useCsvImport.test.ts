import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../../i18n/index';
import { useCsvImport } from './useCsvImport';
import { WRITE_RUN_TIMEOUT_MS } from '../../../hooks/writeRunTimeout';
import type { TFunction } from 'i18next';
import Papa from 'papaparse';
import i18n from '../../../i18n/index';
import { CSV_IMPORT_MAX_COLUMNS, CSV_IMPORT_MAX_ROWS } from '@sandforge/shared';

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
  errorCode: null as string | null,
  reset: mockReset,
};

/** Every mutation the hook creates, with the error channel it asked for. */
const mutationCalls: Array<{ type: string; errorType?: string }> = [];
/** The options each mutation was set up with, by request type. */
const mutationOptions = new Map<string, unknown>();

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { errorType?: string }) => {
    mutationCalls.push({ type, errorType: options?.errorType });
    mutationOptions.set(type, options);
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
      errorCode: null,
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

  it('waits on its run as long as a write run takes, and says the run may still be writing when it stops waiting', () => {
    // Held to 120 s, a long run lost its page and said "Try again" while it
    // went on writing in the extension.
    renderHook(() => useCsvImport(tMock));

    expect(mutationOptions.get('seed:csv:execute')).toMatchObject({
      timeoutMs: WRITE_RUN_TIMEOUT_MS,
      runOutlivesWait: true,
    });
  });

  it('names the import by the id of its request, which a Cancel sends to stop it', () => {
    mockMutationState = {
      ...mockMutationState,
      requestId: 'req-csv-1',
    } as typeof mockMutationState;
    const { result } = renderHook(() => useCsvImport(tMock));

    expect(result.current.runRequestId).toBe('req-csv-1');
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

  it('says a refusal for a missing Production Guard by its code, not in the host’s English', () => {
    const { result, rerender } = renderHook(() => useCsvImport(tMock));

    act(() => {
      result.current.handleExecute();
    });
    mockMutationState = {
      ...mockMutationState,
      loading: false,
      error: 'Production Guard is not initialized — infrastructure services missing',
      errorCode: 'NOT_INITIALIZED',
    };
    act(() => {
      rerender();
    });

    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe('common.refusal.guardMissing');
  });

  /* ------------------------------------------------------------------ */
  /* What one import takes                                               */
  /* ------------------------------------------------------------------ */

  /** The page's words, in English. */
  const tEnglish = i18n.t.bind(i18n) as unknown as TFunction;

  /** Read a file of `text` as the drop zone hands it over. */
  async function readFile(
    result: { current: ReturnType<typeof useCsvImport> },
    text: string,
  ): Promise<void> {
    await act(async () => {
      result.current.handleFileSelected(new File([text], 'export.csv', { type: 'text/csv' }));
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  /** Describe the target as the extension answers: one text field per name. */
  function describe(rerender: () => void, names: readonly string[]): void {
    mockMutationState = {
      ...mockMutationState,
      data: { fields: names.map((name) => ({ apiName: name, label: name, type: 'string' })) },
    };
    act(() => {
      rerender();
    });
    mockMutationState = { ...mockMutationState, data: null };
  }

  it('refuses a file past the rows one import takes as it is read, in words, and keeps none of it', async () => {
    // The host refused it only at Validate, once every column had been
    // mapped, as "Invalid payload — records: Too big".
    const { result } = renderHook(() => useCsvImport(tEnglish));
    const rows = Array.from({ length: CSV_IMPORT_MAX_ROWS + 1 }, (_, i) => `Acme ${i}`);

    await readFile(result, ['Name', ...rows].join('\n'));

    expect(result.current.error).toBe(
      'This file holds 50,001 rows; CSV Upload takes 50,000 at a time. Split it into files of 50,000 rows or fewer, and upload each.',
    );
    expect(result.current.headers).toEqual([]);
    expect(result.current.parsedRows).toEqual([]);
    expect(result.current.previewRows).toEqual([]);
  });

  it('takes a file of exactly the rows one import takes, parsed once, its preview the first ten rows', async () => {
    const { result } = renderHook(() => useCsvImport(tEnglish));
    const rows = Array.from({ length: CSV_IMPORT_MAX_ROWS }, (_, i) => `Acme ${i}`);
    vi.mocked(Papa.parse).mockClear();

    await readFile(result, ['Name', ...rows].join('\n'));

    // Parsed twice, the second time whole: once is enough for the preview.
    expect(Papa.parse).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.parsedRows).toHaveLength(CSV_IMPORT_MAX_ROWS);
    expect(result.current.previewRows.map((row) => row.Name)).toEqual(rows.slice(0, 10));
  });

  it('sends only the mapped columns, and each row only their cells', async () => {
    // Every cell of every column went out twice, the unmapped ones too, and
    // every column counted against the host's cap of mapped columns.
    const { result, rerender } = renderHook(() => useCsvImport(tEnglish));
    await readFile(result, 'Name,Legacy Id,Phone\nAcme,L-1,555\nGlobex,L-2,556');
    act(() => {
      result.current.handleObjectSelected('org-1', 'Account');
    });
    describe(rerender, ['Name', 'Phone']);
    mockMutate.mockClear();

    act(() => {
      result.current.handleValidate();
    });

    const payload = mockMutate.mock.calls[0][0] as {
      records: Record<string, string>[];
      columnMappings: Array<{ csvHeader: string }>;
    };
    expect(payload.columnMappings.map((mapping) => mapping.csvHeader)).toEqual(['Name', 'Phone']);
    expect(payload.records).toEqual([
      { Name: 'Acme', Phone: '555' },
      { Name: 'Globex', Phone: '556' },
    ]);
  });

  it('refuses more mapped columns than one import takes, in words, and sends nothing', async () => {
    const { result, rerender } = renderHook(() => useCsvImport(tEnglish));
    const headers = Array.from({ length: CSV_IMPORT_MAX_COLUMNS + 1 }, (_, i) => `Field${i}`);
    await readFile(result, `${headers.join(',')}\n${headers.map(() => 'x').join(',')}`);
    act(() => {
      result.current.handleObjectSelected('org-1', 'Account');
    });
    describe(rerender, headers);
    expect(result.current.columnsOverLimit).toBe(1);
    mockMutate.mockClear();

    act(() => {
      result.current.handleValidate();
    });

    expect(mockMutate).not.toHaveBeenCalled();
    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe(
      '501 columns are mapped; CSV Upload takes 500 at a time. Leave the columns you do not need unmapped, or split the file by columns.',
    );

    // One left unmapped, and the import goes.
    act(() => {
      result.current.handleMappingChange('Field0', '');
    });
    expect(result.current.columnsOverLimit).toBe(0);
    act(() => {
      result.current.handleValidate();
    });
    expect(mockMutate).toHaveBeenCalledOnce();
  });
});
