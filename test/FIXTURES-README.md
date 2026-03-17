# Fixtures & Mocks pour les Tests

Ce dossier contient les données mock et helpers pour les tests.
Claude Code doit créer ces fichiers lors de la Phase 2 (Core Engine).

## Helpers requis

### `test/helpers/sf-mock.ts`
Mock d'une connexion jsforce. Pattern :

```typescript
import { vi } from 'vitest';

export function createMockConnection(overrides?: Partial<MockConnectionConfig>) {
  return {
    instanceUrl: 'https://test.salesforce.com',
    accessToken: 'mock-token-xxx',
    version: '62.0',
    
    // Mock describe
    describe: vi.fn().mockResolvedValue(mockDescribeResult),
    
    // Mock query
    query: vi.fn().mockResolvedValue({ records: [], totalSize: 0, done: true }),
    
    // Mock sobject
    sobject: vi.fn().mockReturnValue({
      create: vi.fn().mockResolvedValue({ id: '001xx000003DGbYAAW', success: true }),
      update: vi.fn().mockResolvedValue({ id: '001xx000003DGbYAAW', success: true }),
      upsert: vi.fn().mockResolvedValue({ id: '001xx000003DGbYAAW', success: true }),
      delete: vi.fn().mockResolvedValue({ id: '001xx000003DGbYAAW', success: true }),
      describe: vi.fn().mockResolvedValue(mockDescribeResult),
    }),
    
    // Mock limits
    limits: vi.fn().mockResolvedValue(mockLimitsResponse),
    
    // Mock metadata
    metadata: {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({}),
    },
    
    // Mock tooling
    tooling: {
      query: vi.fn().mockResolvedValue({ records: [], totalSize: 0, done: true }),
      sobject: vi.fn().mockReturnValue({
        describe: vi.fn().mockResolvedValue(mockDescribeResult),
      }),
    },
    
    // Mock bulk
    bulk2: {
      createJob: vi.fn().mockResolvedValue({ id: '750xx000000001AAA', state: 'Open' }),
      getJobInfo: vi.fn().mockResolvedValue({ id: '750xx000000001AAA', state: 'JobComplete' }),
    },
    
    ...overrides,
  };
}
```

### `test/helpers/vscode-mock.ts`
Mock de l'API VSCode pour les tests de l'extension :

```typescript
import { vi } from 'vitest';

export const mockVSCode = {
  window: {
    createOutputChannel: vi.fn().mockReturnValue({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    createWebviewPanel: vi.fn(),
    registerTreeDataProvider: vi.fn(),
    createStatusBarItem: vi.fn().mockReturnValue({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      text: '',
      tooltip: '',
    }),
  },
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn(),
      update: vi.fn(),
    }),
    workspaceFolders: [],
  },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  Uri: {
    file: vi.fn((path: string) => ({ fsPath: path, scheme: 'file' })),
    parse: vi.fn((uri: string) => ({ toString: () => uri })),
  },
  ExtensionContext: {
    subscriptions: [],
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
    },
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
    },
    extensionPath: '/mock/extension/path',
    extensionUri: { fsPath: '/mock/extension/path' },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { One: 1, Two: 2 },
};
```

## Fixtures JSON

### `test/fixtures/mock-describe-account.json`
Réponse Describe complète d'Account (simplifiée mais structurellement correcte).
Doit inclure : fields (Id, Name, Type, Industry, BillingAddress, OwnerId, ParentId), 
childRelationships (Contacts, Opportunities), recordTypeInfos.

### `test/fixtures/mock-describe-contact.json`
Describe de Contact avec : Id, FirstName, LastName, Email, Phone, AccountId (lookup),
OwnerId, RecordTypeId.

### `test/fixtures/mock-limits-response.json`
```json
{
  "DailyApiRequests": { "Max": 100000, "Remaining": 54770 },
  "DailyBulkV2QueryJobs": { "Max": 10000, "Remaining": 9998 },
  "DailyBulkV2QueryFileStorageMB": { "Max": 976562, "Remaining": 976560 },
  "DataStorageMB": { "Max": 5120, "Remaining": 3021 },
  "FileStorageMB": { "Max": 2048, "Remaining": 1158 },
  "SingleEmail": { "Max": 5000, "Remaining": 4990 },
  "StreamingApiConcurrentClients": { "Max": 2000, "Remaining": 1998 },
  "DailyAsyncApexExecutions": { "Max": 250000, "Remaining": 249900 },
  "HourlyAsyncReportRuns": { "Max": 1200, "Remaining": 1195 },
  "ConcurrentAsyncGetReportInstances": { "Max": 200, "Remaining": 200 },
  "ConcurrentSyncReportRuns": { "Max": 20, "Remaining": 20 }
}
```

### `test/fixtures/mock-bulk-job-response.json`
```json
{
  "id": "750xx000000001AAA",
  "operation": "insert",
  "object": "Account",
  "state": "JobComplete",
  "numberRecordsProcessed": 500,
  "numberRecordsFailed": 2,
  "totalProcessingTime": 12500,
  "apiVersion": 62.0,
  "jobType": "V2Ingest",
  "createdDate": "2026-02-15T10:30:00.000+0000",
  "systemModstamp": "2026-02-15T10:32:30.000+0000"
}
```

### `test/fixtures/sample-data/accounts.csv`
```csv
Name,Type,Industry,BillingStreet,BillingCity,BillingCountry,Phone
"Acme Corp","Customer","Technology","123 Main St","Paris","France","+33 1 23 45 67 89"
"TechStart SAS","Prospect","Consulting","45 Avenue Foch","Lyon","France","+33 4 56 78 90 12"
"Global Industries","Customer","Manufacturing","78 Rue de Rivoli","Marseille","France","+33 6 12 34 56 78"
```
