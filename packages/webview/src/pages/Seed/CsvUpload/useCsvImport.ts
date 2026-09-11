import { useState, useCallback } from 'react';
import type { TFunction } from 'i18next';
import Papa from 'papaparse';
import type { CsvColumnMapping, CsvValidationResult, SeedFieldInfo } from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';

/** Step in the CSV import wizard. */
export type CsvImportStep = 'upload' | 'map' | 'validate' | 'execute';

/** Execution status for the CSV import flow. */
export type CsvExecutionStatus = 'idle' | 'validating' | 'executing' | 'complete' | 'error';

/** Execution result shape from the operation completed event. */
export interface CsvExecutionResult {
  insertedCount: number;
  failedCount: number;
  errors: string[];
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
    // Bulk write: can exceed the 30 s default on real volumes; operation:progress
    // events keep flowing while the response is pending.
    timeoutMs: 120_000,
  });

  const handleFileSelected = useCallback((selectedFile: File) => {
    setFile(selectedFile);

    const reader = new FileReader();
    reader.onload = () => {
      const rawText = reader.result as string;
      const cleanText = rawText.replace(/^\uFEFF/, '');

      // Parse preview (first 10 rows)
      const previewResult = Papa.parse<Record<string, string>>(cleanText, {
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
        preview: 10,
      });

      if (previewResult.meta.fields) {
        setHeaders(previewResult.meta.fields);
      }
      setPreviewRows(previewResult.data);

      // Parse all rows
      const fullResult = Papa.parse<Record<string, string>>(cleanText, {
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true,
      });
      setParsedRows(fullResult.data);
    };
    reader.readAsText(selectedFile);
  }, []);

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
    setError(executeMutation.error);
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

  const handleValidate = useCallback(() => {
    setExecutionStatus('validating');
    setValidationResult(null);
    setError(null);

    validateMutation.mutate({
      orgId: targetOrgId,
      objectApiName: targetObjectApiName,
      records: parsedRows as unknown as Record<string, unknown>[],
      columnMappings: columnMappings as unknown as Record<string, unknown>[],
    } as unknown as Record<string, unknown>);
  }, [targetOrgId, targetObjectApiName, parsedRows, columnMappings, validateMutation]);

  const handleExecute = useCallback(() => {
    setExecutionStatus('executing');
    setError(null);

    executeMutation.mutate({
      orgId: targetOrgId,
      objectApiName: targetObjectApiName,
      records: parsedRows as unknown as Record<string, unknown>[],
      columnMappings: columnMappings as unknown as Record<string, unknown>[],
    } as unknown as Record<string, unknown>);
  }, [targetOrgId, targetObjectApiName, parsedRows, columnMappings, executeMutation]);

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

  // Suppress unused parameter warning -- t is part of the public API contract
  void t;

  return {
    file,
    headers,
    parsedRows,
    previewRows,
    columnMappings,
    targetOrgId,
    targetObjectApiName,
    describeFields,
    validationResult,
    executionStatus,
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
