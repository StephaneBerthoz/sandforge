import type { Connection } from 'jsforce';
import { DEPLOY_WAIT_MINUTES } from '@sandforge/shared';
import type {
  DeploymentComponentRef,
  DeploymentComponentResult,
  DeploymentReport,
  DeploymentTestFailure,
  DeployTestLevel,
} from '@sandforge/shared';
import { isInstalledByPackage } from './MetadataCompare.js';

/*
 * A deployment from a comparison: what the source holds of some components,
 * retrieved through the Metadata API, deployed to the target as it came.
 *
 * The package is the source's own: nothing is rewritten between the two
 * calls, so what the target is asked to take is what the source holds. It
 * carries no destructive changes, and a deployment rolls back as a whole on
 * the first error.
 */

/** A component as the Metadata API describes it in a retrieval. */
interface RetrievedFile {
  type?: string | null;
  fullName?: string | null;
  fileName?: string | null;
  namespacePrefix?: string | null;
  manageableState?: string | null;
}

/** What the Metadata API says about one retrieval, as far as a deployment reads it. */
export interface RetrieveStatus {
  id?: string;
  done: boolean;
  success?: boolean;
  status?: string;
  errorMessage?: string | null;
  zipFile?: string | null;
  fileProperties?: RetrievedFile[] | RetrievedFile | null;
  messages?: RetrieveMessage[] | RetrieveMessage | null;
}

/** Something the source said while handing a package over. */
interface RetrieveMessage {
  fileName?: string | null;
  problem?: string | null;
}

/** One component in a deployment result. */
interface DeployMessage {
  componentType?: string | null;
  fullName?: string | null;
  fileName?: string | null;
  success?: boolean | string | null;
  created?: boolean | string | null;
  changed?: boolean | string | null;
  deleted?: boolean | string | null;
  problem?: string | null;
  problemType?: string | null;
  lineNumber?: number | string | null;
  columnNumber?: number | string | null;
}

/** A failed test in a deployment result. */
interface RunTestFailure {
  name?: string | null;
  methodName?: string | null;
  message?: string | null;
  stackTrace?: string | null;
}

/** What the Metadata API says about one deployment, as far as the report reads it. */
export interface DeployStatus {
  id: string;
  done: boolean;
  status?: string;
  success?: boolean;
  checkOnly?: boolean;
  errorMessage?: string | null;
  numberComponentsTotal?: number;
  numberComponentsDeployed?: number;
  numberComponentErrors?: number;
  numberTestsTotal?: number;
  numberTestsCompleted?: number;
  numberTestErrors?: number;
  startDate?: string | null;
  completedDate?: string | null;
  details?: {
    componentSuccesses?: DeployMessage[] | DeployMessage | null;
    componentFailures?: DeployMessage[] | DeployMessage | null;
    runTestResult?: {
      failures?: RunTestFailure[] | RunTestFailure | null;
      codeCoverageWarnings?:
        | Array<{ name?: string | null; message?: string | null }>
        | { name?: string | null; message?: string | null }
        | null;
    } | null;
  } | null;
}

/** The request a retrieval sends, as jsforce types it. */
type RetrieveRequestInput = Parameters<Connection['metadata']['retrieve']>[0];

/** The options a deployment sends, in the order the Metadata API's schema lists them. */
export interface DeployOptionsInput {
  allowMissingFiles: false;
  autoUpdatePackage: false;
  checkOnly: boolean;
  ignoreWarnings: false;
  performRetrieve: false;
  purgeOnDelete: false;
  rollbackOnError: true;
  runTests?: string[];
  singlePackage: true;
  testLevel: DeployTestLevel;
}

/** The Metadata API calls a deployment makes. */
export interface DeployMetadataApi {
  retrieve(request: RetrieveRequestInput): Promise<{ id: string }>;
  checkRetrieveStatus(id: string): Promise<RetrieveStatus>;
  deploy(zipFile: string, options: DeployOptionsInput): Promise<{ id: string }>;
  checkDeployStatus(id: string, includeDetails: boolean): Promise<DeployStatus>;
}

/** Those calls on a jsforce connection. */
export function metadataApiOf(conn: Connection): DeployMetadataApi {
  return {
    async retrieve(request) {
      const started = await conn.metadata.retrieve(request);
      return { id: started.id };
    },
    checkRetrieveStatus: (id) => conn.metadata.checkRetrieveStatus(id),
    async deploy(zipFile, options) {
      const started = await conn.metadata.deploy(zipFile, options);
      return { id: started.id };
    },
    checkDeployStatus: (id, includeDetails) => conn.metadata.checkDeployStatus(id, includeDetails),
  };
}

/** How the deployer waits on an org; a test passes its own clock. */
export interface Waiting {
  /** Between two status checks. */
  pollMs: number;
  retrieveTimeoutMs: number;
  deployTimeoutMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const DEFAULT_WAITING: Waiting = {
  pollMs: 3000,
  retrieveTimeoutMs: DEPLOY_WAIT_MINUTES.retrieve * 60_000,
  deployTimeoutMs: DEPLOY_WAIT_MINUTES.deploy * 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

/** Where a run stands, for the page's progress line. */
export interface DeployProgress {
  /** `retrieve`: the source is packing; `components` and `tests`: the target is deploying. */
  step: 'retrieve' | 'components' | 'tests';
  done: number;
  total: number;
}

/** A run the org kept going past the wait: its id says where to follow it. */
export class DeploymentStillRunning extends Error {
  constructor(
    readonly kind: 'retrieval' | 'deployment',
    readonly asyncId: string,
    readonly status: string,
    minutes: number,
  ) {
    super(
      kind === 'deployment'
        ? `Deployment ${asyncId} was still ${status} after ${minutes} min; it goes on in the ` +
            'target org, and Setup › Deployment Status follows it.'
        : `Retrieval ${asyncId} was still ${status} after ${minutes} min; nothing was deployed.`,
    );
    this.name = 'DeploymentStillRunning';
  }
}

/** What the source handed over for a deployment. */
export interface RetrievedPackage {
  /** The package, base64 as the Metadata API carries it; empty when nothing came back. */
  zipFile: string;
  /** The components it holds. */
  retrieved: DeploymentComponentRef[];
  /** Components asked for that the source did not return, with what it said of each. */
  missing: Array<DeploymentComponentRef & { problem?: string }>;
  /** Components it holds that a managed package installed, as the retrieval says. */
  managed: DeploymentComponentRef[];
  /** What the source said that names no component asked for. */
  problems: string[];
}

/** The key a component is matched by: its type and its name, percent-decoded. */
function keyOf(componentType: string, fullName: string): string {
  return `${componentType}\u0000${decodeName(fullName)}`;
}

/**
 * A name as the Metadata API means it. A layout named with a quote or an
 * underscore pair is listed, retrieved and reported percent-encoded
 * (`%27`, `%5F%5F`); decoding both sides matches it however it was written.
 */
function decodeName(fullName: string): string {
  try {
    return decodeURIComponent(fullName);
  } catch {
    return fullName;
  }
}

function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asBoolean(value: boolean | string | null | undefined): boolean {
  return value === true || value === 'true';
}

function asNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** "Entity of type 'ApexClass' named 'Invoicing' cannot be found": the source does not hold it. */
const NOT_FOUND = /^Entity of type '(.+?)' named '(.+)' cannot be found$/;

/** One retrieval, followed until the source has packed it. */
async function retrieveOnce(
  api: DeployMetadataApi,
  apiVersion: string,
  components: readonly DeploymentComponentRef[],
  waiting: Waiting,
): Promise<RetrieveStatus> {
  const byType = new Map<string, string[]>();
  for (const { componentType, fullName } of components) {
    byType.set(componentType, [...(byType.get(componentType) ?? []), fullName]);
  }
  // Keys in the order of the Metadata API's schema, which reads elements in
  // sequence. `singlePackage` puts the package at the root of the zip, where
  // a deployment with the same flag reads it.
  const request: RetrieveRequestInput = {
    apiVersion: Number(apiVersion),
    singlePackage: true,
    unpackaged: {
      objectPermissions: [],
      types: [...byType].map(([name, members]) => ({ members, name })),
      version: apiVersion,
    },
  };
  const { id } = await api.retrieve(request);
  const startedAt = waiting.now();
  for (;;) {
    const status = await api.checkRetrieveStatus(id);
    if (status.done) {
      if (status.success === false || status.status === 'Failed') {
        throw new Error(
          `Retrieval ${id} from the source failed: ${status.errorMessage ?? status.status ?? 'no reason given'}`,
        );
      }
      return status;
    }
    if (waiting.now() - startedAt >= waiting.retrieveTimeoutMs) {
      throw new DeploymentStillRunning(
        'retrieval',
        id,
        status.status ?? 'running',
        Math.round(waiting.retrieveTimeoutMs / 60_000),
      );
    }
    await waiting.sleep(waiting.pollMs);
  }
}

/**
 * Retrieve components from the source, as one package.
 *
 * A component the source no longer holds does not fail a retrieval: the
 * manifest the source returns still names it, with no file beside it, and a
 * deployment with `allowMissingFiles` off, as every deployment here is, does
 * not succeed on a manifest that names a file the package lacks. The source
 * is then asked again for the others, so that the manifest names only what
 * the package holds.
 *
 * What is missing is read from what the source says, never from the files it
 * lists: a label, a field or a validation rule comes back inside its file
 * (`CustomLabels`, the object), which names the file and not the component.
 */
export async function retrieveComponents(
  api: DeployMetadataApi,
  apiVersion: string,
  components: readonly DeploymentComponentRef[],
  options: { waiting?: Waiting; onProgress?: (progress: DeployProgress) => void } = {},
): Promise<RetrievedPackage> {
  const waiting = options.waiting ?? DEFAULT_WAITING;
  options.onProgress?.({ step: 'retrieve', done: 0, total: components.length });

  const first = await retrieveOnce(api, apiVersion, components, waiting);
  const asked = new Map(components.map((c) => [keyOf(c.componentType, c.fullName), c]));
  const missing = new Map<string, DeploymentComponentRef & { problem?: string }>();
  const problems: string[] = [];
  for (const message of asArray(first.messages)) {
    const problem = message.problem ?? '';
    const notFound = NOT_FOUND.exec(problem);
    const component = notFound ? asked.get(keyOf(notFound[1], notFound[2])) : undefined;
    if (component) {
      missing.set(keyOf(component.componentType, component.fullName), { ...component, problem });
    } else if (problem) {
      problems.push(message.fileName ? `${message.fileName}: ${problem}` : problem);
    }
  }
  const retrieved = components.filter((c) => !missing.has(keyOf(c.componentType, c.fullName)));

  let answer = first;
  if (retrieved.length === 0) {
    answer = { ...first, zipFile: '' };
  } else if (missing.size > 0) {
    answer = await retrieveOnce(api, apiVersion, retrieved, waiting);
  }
  options.onProgress?.({ step: 'retrieve', done: retrieved.length, total: components.length });

  // Only what was asked for: a field of the org's own comes back inside an
  // object a package installed, and the object is not what is deployed.
  const managed = asArray(answer.fileProperties)
    .filter((file) => isInstalledByPackage(file))
    .map((file) => asked.get(keyOf(file.type ?? '', file.fullName ?? '')))
    .filter((c): c is DeploymentComponentRef => c !== undefined);

  return {
    zipFile: answer.zipFile ?? '',
    retrieved,
    missing: [...missing.values()],
    managed,
    problems,
  };
}

/** The options of a deployment: all or nothing, never destructive, tests as asked. */
export function deployOptions(
  checkOnly: boolean,
  testLevel: DeployTestLevel,
  runTests: readonly string[],
): DeployOptionsInput {
  return {
    allowMissingFiles: false,
    autoUpdatePackage: false,
    checkOnly,
    ignoreWarnings: false,
    performRetrieve: false,
    purgeOnDelete: false,
    rollbackOnError: true,
    ...(testLevel === 'RunSpecifiedTests' ? { runTests: [...runTests] } : {}),
    singlePackage: true,
    testLevel,
  };
}

/**
 * Deploy a retrieved package to the target and follow it to its end.
 *
 * The status is read without its details while the org works, since the
 * details list every component and every test; once it is done, they are
 * read once.
 */
export async function deployPackage(
  api: DeployMetadataApi,
  zipFile: string,
  options: DeployOptionsInput,
  hooks: { waiting?: Waiting; onProgress?: (progress: DeployProgress) => void } = {},
): Promise<DeployStatus> {
  const waiting = hooks.waiting ?? DEFAULT_WAITING;
  const { id } = await api.deploy(zipFile, options);
  const startedAt = waiting.now();
  for (;;) {
    const status = await api.checkDeployStatus(id, false);
    if (status.done) return api.checkDeployStatus(id, true);
    hooks.onProgress?.(progressOf(status));
    if (waiting.now() - startedAt >= waiting.deployTimeoutMs) {
      throw new DeploymentStillRunning(
        'deployment',
        id,
        status.status ?? 'running',
        Math.round(waiting.deployTimeoutMs / 60_000),
      );
    }
    await waiting.sleep(waiting.pollMs);
  }
}

/** Where a deployment stands: its components, then its tests. */
function progressOf(status: DeployStatus): DeployProgress {
  const testsTotal = status.numberTestsTotal ?? 0;
  const componentsTotal = status.numberComponentsTotal ?? 0;
  const componentsDone =
    (status.numberComponentsDeployed ?? 0) + (status.numberComponentErrors ?? 0);
  if (testsTotal > 0 && componentsDone >= componentsTotal) {
    return {
      step: 'tests',
      done: (status.numberTestsCompleted ?? 0) + (status.numberTestErrors ?? 0),
      total: testsTotal,
    };
  }
  return { step: 'components', done: componentsDone, total: componentsTotal };
}

/** "Class.InvoicingTest.charges: line 12, column 1" names line 12. */
function lineOfStackTrace(stackTrace: string | null | undefined): number | undefined {
  const match = /line (\d+), column \d+/.exec(stackTrace ?? '');
  return match ? Number(match[1]) : undefined;
}

/** One component of the result, as the report lists it. */
function componentResult(message: DeployMessage): DeploymentComponentResult {
  const line = asNumber(message.lineNumber);
  const column = asNumber(message.columnNumber);
  const problemType =
    message.problemType === 'Warning' || message.problemType === 'Error'
      ? message.problemType
      : undefined;
  const base = {
    componentType: message.componentType ?? '',
    fullName: message.fullName ?? '',
    ...(message.fileName ? { fileName: message.fileName } : {}),
  };
  if (!asBoolean(message.success)) {
    return {
      ...base,
      outcome: 'failed',
      ...(message.problem ? { problem: message.problem } : {}),
      ...(problemType ? { problemType } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    };
  }
  const outcome = asBoolean(message.created)
    ? 'created'
    : asBoolean(message.changed)
      ? 'changed'
      : 'unchanged';
  return { ...base, outcome };
}

/** What one run asked for and where, for its report. */
export interface DeploymentRequestFacts {
  sourceOrgId: string;
  targetOrgId: string;
  checkOnly: boolean;
  testLevel: DeployTestLevel;
  runTests: readonly string[];
}

/**
 * The report of a deployment: every component the org reports on, once each
 * and its failure first, then those the source did not return.
 *
 * The org also reports the package manifest as a component of no type; it is
 * no component of anyone's, and left out.
 */
export function deploymentReport(
  status: DeployStatus | undefined,
  retrieved: Pick<RetrievedPackage, 'missing' | 'problems'>,
  facts: DeploymentRequestFacts,
): DeploymentReport {
  const details = status?.details ?? undefined;
  const byKey = new Map<string, DeploymentComponentResult>();
  const messages = [
    ...asArray(details?.componentFailures),
    ...asArray(details?.componentSuccesses),
  ];
  for (const message of messages) {
    if (!message.componentType && message.fullName === 'package.xml') continue;
    const result = componentResult(message);
    const key = keyOf(result.componentType, result.fullName);
    if (!byKey.has(key)) byKey.set(key, result);
  }
  const notRetrieved: DeploymentComponentResult[] = retrieved.missing.map((c) => ({
    componentType: c.componentType,
    fullName: c.fullName,
    outcome: 'not_retrieved',
    ...(c.problem ? { problem: c.problem } : {}),
  }));

  const runTestResult = details?.runTestResult ?? undefined;
  const testFailures: DeploymentTestFailure[] = asArray(runTestResult?.failures).map((f) => {
    const line = lineOfStackTrace(f.stackTrace);
    return {
      className: f.name ?? '',
      ...(f.methodName ? { methodName: f.methodName } : {}),
      message: f.message ?? '',
      ...(f.stackTrace ? { stackTrace: f.stackTrace } : {}),
      ...(line !== undefined ? { line } : {}),
    };
  });
  const coverageWarnings = asArray(runTestResult?.codeCoverageWarnings)
    .map((w) => (w.name ? `${w.name}: ${w.message ?? ''}` : (w.message ?? '')))
    .filter((w) => w !== '');

  return {
    ...(status?.id ? { deployId: status.id } : {}),
    checkOnly: facts.checkOnly,
    status: status?.status ?? 'NotStarted',
    success: status?.success === true && retrieved.missing.length === 0,
    ...(status?.errorMessage ? { errorMessage: status.errorMessage } : {}),
    sourceOrgId: facts.sourceOrgId,
    targetOrgId: facts.targetOrgId,
    testLevel: facts.testLevel,
    runTests: [...facts.runTests],
    components: [...byKey.values(), ...notRetrieved],
    counts: {
      componentsTotal: status?.numberComponentsTotal ?? 0,
      componentsDeployed: status?.numberComponentsDeployed ?? 0,
      componentErrors: status?.numberComponentErrors ?? 0,
      testsTotal: status?.numberTestsTotal ?? 0,
      testsCompleted: status?.numberTestsCompleted ?? 0,
      testErrors: status?.numberTestErrors ?? 0,
    },
    testFailures,
    coverageWarnings,
    ...(retrieved.problems.length > 0 ? { retrieveProblems: [...retrieved.problems] } : {}),
    ...(status?.startDate ? { startedAt: status.startDate } : {}),
    ...(status?.completedDate ? { completedAt: status.completedDate } : {}),
  };
}
