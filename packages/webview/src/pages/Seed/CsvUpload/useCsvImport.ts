import { useState, useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';
import Papa from 'papaparse';
import type { CsvColumnMapping, CsvValidationResult, SeedFieldInfo } from '@sandforge/shared';
import { CSV_IMPORT_MAX_COLUMNS, CSV_IMPORT_MAX_ROWS } from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { WRITE_RUN_TIMEOUT_MS } from '../../../hooks/writeRunTimeout';
import { formatNumber } from '../../../utils/formatters';

/** Step in the CSV import wizard. */
export type CsvImportStep = 'upload' | 'map' | 'validate' | 'execute';

/** Execution status for the CSV import flow. */
export type CsvExecutionStatus = 'idle' | 'validating' | 'executing' | 'complete' | 'error';

/** Execution result shape from the operation completed event. */
export interface CsvExecutionResult {
  insertedCount: number;
  failedCount: number;
  errors: string[];
  /** Set when a cancel stopped the import: the rows it wrote stay in the org. */
  cancelled?: boolean;
  /**
   * The id what the import created is kept under, for its removal from the
   * results or Earlier seeds. Absent when it created nothing.
   */
  runId?: string;
}

/** Return type of the useCsvImport hook. */
export interface CsvImportState {
  /** Currently selected file. */
  file: File | null;
  /** Parsed CSV headers. */
  headers: string[];
  /** All parsed rows from the CSV. */
  parsedRows: Record<string, string>[];
  /** First 10 rows for preview display. */
  previewRows: Record<string, string>[];
  /** Column mappings between CSV headers and Salesforce fields. */
  columnMappings: CsvColumnMapping[];
  /**
   * How many columns are mapped past what one import takes, or 0: the map
   * step says so, and its Next waits until some are left unmapped.
   */
  columnsOverLimit: number;
  /** Target org ID. */
  targetOrgId: string;
  /** Target Salesforce object API name. */
  targetObjectApiName: string;
  /** Described Salesforce fields for the target object. */
  describeFields: SeedFieldInfo[];
  /** Validation result from the extension. */
  validationResult: CsvValidationResult | null;
  /** Current execution status. */
  executionStatus: CsvExecutionStatus;
  /**
   * The id of the request that started the import, which the extension runs
   * it under: what a Cancel sends to stop it. Null before the first one.
   */
  runRequestId: string | null;
  /** Execution result after completion. */
  executionResult: CsvExecutionResult | null;
  /** Error message from the last failed step, if any. */
  error: string | null;
  /** Current wizard step. */
  step: CsvImportStep;
  /** Whether describe-object is loading. */
  describeLoading: boolean;
  /** Whether validation is loading. */
  validateLoading: boolean;
  /** Handle file selection and trigger CSV parsing. */
  handleFileSelected: (file: File) => void;
  /** Handle target object selection and trigger describe + auto-mapping. */
  handleObjectSelected: (orgId: string, objectApiName: string) => void;
  /** Update a single column mapping. */
  handleMappingChange: (csvHeader: string, sfFieldApiName: string) => void;
  /** Trigger validation of mapped data. */
  handleValidate: () => void;
  /** Trigger execution of the CSV import. */
  handleExecute: () => void;
  /** Reset all state to initial values. */
  reset: () => void;
  /** Navigate to a specific step. */
  setStep: (step: CsvImportStep) => void;
  /** Set target org ID. */
  setTargetOrgId: (orgId: string) => void;
}

/**
 * Normalize a string for fuzzy column matching.
 * Lowercases, removes underscores, spaces, and special characters.
 */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, '');
}

/**
 * Auto-map CSV headers to Salesforce fields using case-insensitive,
 * underscore-tolerant matching. Only maps to createable fields.
 */
function autoMapColumns(headers: string[], fields: SeedFieldInfo[]): CsvColumnMapping[] {
  const createableFields = fields.filter(
    (f) =>
      ![
        'id',
        'createddate',
        'lastmodifieddate',
        'systemmodstamp',
        'createdbyid',
        'lastmodifiedbyid',
        'isdeleted',
      ].includes(f.apiName.toLowerCase()),
  );

  return headers.map((header) => {
    const normalizedHeader = normalizeForMatch(header);
    const match = createableFields.find(
      (f) =>
        normalizeForMatch(f.apiName) === normalizedHeader ||
        normalizeForMatch(f.label) === normalizedHeader,
    );

    return {
      csvHeader: header,
      sfFieldApiName: match?.apiName ?? '',
      sfFieldType: match?.type ?? '',
      sfFieldLength: match?.maxLength ?? null,
    };
  });
}

/** The mappings of the columns mapped to a field: the only ones an import sends. */
function mappedColumns(mappings: readonly CsvColumnMapping[]): CsvColumnMapping[] {
  return mappings.filter((mapping) => mapping.sfFieldApiName !== '');
}

/**
 * Each row with only the mapped columns: an import of an 800-column export
 * sent every cell of every column twice, the unmapped ones too.
 */
function mappedCells(
  rows: readonly Record<string, string>[],
  mappings: readonly CsvColumnMapping[],
): Record<string, string>[] {
  const headers = mappings.map((mapping) => mapping.csvHeader);
  return rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const header of headers) {
      if (header in row) cells[header] = row[header];
    }
    return cells;
  });
}

/**
 * Hook managing the complete CSV import lifecycle: file selection,
 * parsing with Papaparse, column auto-mapping, validation, and execution.
 *
 * @param t - i18next translation function for error messages.
 */
export function useCsvImport(t: TFunction): CsvImportState {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [parsedRows, setParsedRows] = useState<Record<string, string>[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [columnMappings, setColumnMappings] = useState<CsvColumnMapping[]>([]);
  const [targetOrgId, setTargetOrgId] = useState('');
  const [targetObjectApiName, setTargetObjectApiName] = useState('');
  const [describeFields, setDescribeFields] = useState<SeedFieldInfo[]>([]);
  const [validationResult, setValidationResult] = useState<CsvValidationResult | null>(null);
  const [executionStatus, setExecutionStatus] = useState<CsvExecutionStatus>('idle');
  const [executionResult, setExecutionResult] = useState<CsvExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<CsvImportStep>('upload');

  const describeMutation = useBridgeMutation<{ fields: SeedFieldInfo[] }>('seed:describe-object');
  const validateMutation = useBridgeMutation<CsvValidationResult>('seed:csv:validate', {
    errorType: 'seed:csv:error',
  });
  const executeMutation = useBridgeMutation<CsvExecutionResult>('seed:csv:execute', {
    // SeedCsvHandler reports failures here, correlated to the request.
    errorType: 'seed:csv:error',
    // The import goes on in the extension until it ends, and answers then:
    // held to two minutes, a long import lost its page while it went on writing.
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
    runOutlivesWait: true,
  });

  const handleFileSelected = useCallback(
    (selectedFile: File) => {
      setFile(selectedFile);

      const reader = new FileReader();
      reader.onload = () => {
        const rawText = reader.result as string;
        const cleanText = rawText.replace(/^\uFEFF/, '');

        // Parsed once: the preview is the first rows of the whole parse. The
        // file was parsed twice, the second time whole.
        const result = Papa.parse<Record<string, string>>(cleanText, {
          header: true,
          dynamicTyping: false,
          skipEmptyLines: true,
        });

        /*
         * A file past what one import takes is refused as it is read, in words.
         * The host refused it only at Validate, once every column had been
         * mapped, as "Invalid payload — records: Too big".
         */
        if (result.data.length > CSV_IMPORT_MAX_ROWS) {
          setHeaders([]);
          setPreviewRows([]);
          setParsedRows([]);
          setError(
            t('seed.csv.wizard.tooManyRows', {
              rows: formatNumber(result.data.length),
              max: formatNumber(CSV_IMPORT_MAX_ROWS),
            }),
          );
          return;
        }
        setError(null);
        setHeaders(result.meta.fields ?? []);
        setPreviewRows(result.data.slice(0, 10));
        setParsedRows(result.data);
      };
      reader.readAsText(selectedFile);
    },
    [t],
  );

  const handleObjectSelected = useCallback(
    (orgId: string, objectApiName: string) => {
      setTargetOrgId(orgId);
      setTargetObjectApiName(objectApiName);

      describeMutation.mutate({ orgId, objectApiName });
    },
    [describeMutation],
  );

  // React to describe response
  if (describeMutation.data && describeMutation.data.fields !== describeFields) {
    const fields = describeMutation.data.fields;
    setDescribeFields(fields);
    if (headers.length > 0) {
      setColumnMappings(autoMapColumns(headers, fields));
    }
  }

  // React to validate response
  if (validateMutation.data && validateMutation.data !== validationResult) {
    setValidationResult(validateMutation.data);
    setExecutionStatus('idle');
    if (validateMutation.data.valid) {
      setStep('execute');
    }
  }

  // React to execute response
  if (executeMutation.data && executeMutation.data !== executionResult) {
    setExecutionResult(executeMutation.data);
    setExecutionStatus('complete');
  }

  // React to validate/execute failures (bridge timeout or hook-level error) —
  // without this the status stays stuck on 'validating'/'executing' forever.
  if (validateMutation.error && executionStatus === 'validating') {
    setExecutionStatus('error');
    setError(validateMutation.error);
  }
  if (executeMutation.error && executionStatus === 'executing') {
    setExecutionStatus('error');
    // A missing Production Guard is said by its code: the host's words are English.
    setError(
      executeMutation.errorCode === 'NOT_INITIALIZED'
        ? t('common.refusal.guardMissing')
        : executeMutation.error,
    );
  }

  const handleMappingChange = useCallback(
    (csvHeader: string, sfFieldApiName: string) => {
      setColumnMappings((prev) =>
        prev.map((m) => {
          if (m.csvHeader !== csvHeader) return m;
          const field = describeFields.find((f) => f.apiName === sfFieldApiName);
          return {
            ...m,
            sfFieldApiName,
            sfFieldType: field?.type ?? '',
            sfFieldLength: field?.maxLength ?? null,
          };
        }),
      );
    },
    [describeFields],
  );

  const mapped = useMemo(() => mappedColumns(columnMappings), [columnMappings]);
  const columnsOverLimit = Math.max(0, mapped.length - CSV_IMPORT_MAX_COLUMNS);

  /**
   * What the extension is sent to check or write: the mapped columns, and
   * each row's cells of those columns. Undefined, with the refusal said, when
   * more columns are mapped than one import takes.
   */
  const importPayload = useCallback((): Record<string, unknown> | undefined => {
    if (mapped.length > CSV_IMPORT_MAX_COLUMNS) {
      setExecutionStatus('error');
      setError(
        t('seed.csv.wizard.tooManyColumns', {
          columns: formatNumber(mapped.length),
          max: formatNumber(CSV_IMPORT_MAX_COLUMNS),
        }),
      );
      return undefined;
    }
    return {
      orgId: targetOrgId,
      objectApiName: targetObjectApiName,
      records: mappedCells(parsedRows, mapped),
      columnMappings: mapped,
    } as unknown as Record<string, unknown>;
  }, [mapped, parsedRows, targetOrgId, targetObjectApiName, t]);

  const handleValidate = useCallback(() => {
    setValidationResult(null);
    setError(null);
    const payload = importPayload();
    if (!payload) return;
    setExecutionStatus('validating');
    validateMutation.mutate(payload);
  }, [importPayload, validateMutation]);

  const handleExecute = useCallback(() => {
    setError(null);
    const payload = importPayload();
    if (!payload) return;
    setExecutionStatus('executing');
    executeMutation.mutate(payload);
  }, [importPayload, executeMutation]);

  const reset = useCallback(() => {
    setFile(null);
    setHeaders([]);
    setParsedRows([]);
    setPreviewRows([]);
    setColumnMappings([]);
    setTargetOrgId('');
    setTargetObjectApiName('');
    setDescribeFields([]);
    setValidationResult(null);
    setExecutionStatus('idle');
    setExecutionResult(null);
    setError(null);
    setStep('upload');
    describeMutation.reset();
    validateMutation.reset();
    executeMutation.reset();
  }, [describeMutation, validateMutation, executeMutation]);

  return {
    file,
    headers,
    parsedRows,
    previewRows,
    columnMappings,
    columnsOverLimit,
    targetOrgId,
    targetObjectApiName,
    describeFields,
    validationResult,
    executionStatus,
    runRequestId: executeMutation.requestId,
    executionResult,
    error,
    step,
    describeLoading: describeMutation.loading,
    validateLoading: validateMutation.loading,
    handleFileSelected,
    handleObjectSelected,
    handleMappingChange,
    handleValidate,
    handleExecute,
    reset,
    setStep,
    setTargetOrgId,
  };
}
