import type { UUID, ISODateString } from './common.types.js';

/**
 * Comparison mode. Metadata is the only one: the page never offered another,
 * and the data, config and permission comparators behind the others were
 * never run (`compare:execute` always asked for metadata) and could not have
 * worked if they had. The Permissions and Drift tabs have requests of their own.
 */
export type CompareMode = 'metadata';

/**
 * What a comparison says about one component.
 *
 * `modified` and `unchanged` are verdicts on content: the component was read
 * from both orgs and the two copies compared. `not_compared` is a component
 * both orgs hold whose content was not compared (see `NotComparedReason`): it
 * is neither a change nor a match.
 */
export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged' | 'not_compared';

/** Why a component both orgs hold was not compared by content. */
export type NotComparedReason =
  /** Its content cannot be read: a managed package hides its Apex source. */
  | 'unreadable'
  /** Reading it failed in one org or both, or an org did not return it. */
  | 'read_failed'
  /** One run reads a bounded number of components; this one was past the bound. */
  | 'over_budget';

/** Metadata component type */
export type MetadataComponentType =
  | 'CustomObject'
  | 'CustomField'
  | 'ApexClass'
  | 'ApexTrigger'
  | 'LightningComponentBundle'
  | 'Flow'
  | 'Layout'
  | 'Profile'
  | 'PermissionSet'
  | 'ValidationRule'
  | 'WorkflowRule'
  | 'RecordType'
  | 'CustomLabel'
  | 'CustomMetadata'
  | 'CustomSetting'
  | 'StaticResource'
  | 'EmailTemplate'
  | 'Report'
  | 'Dashboard'
  | 'Other';

/** Compare configuration */
export interface CompareConfig {
  id: UUID;
  name: string;
  sourceOrgId: UUID;
  targetOrgId: UUID;
  thirdOrgId?: UUID;
  mode: CompareMode;
  componentTypes: MetadataComponentType[];
  /**
   * Whether the components a managed package installed are compared with the
   * rest. When false they are left out of both listings, and the result says
   * how many (`CompareContentCoverage.managedLeftOut`).
   */
  includeManaged: boolean;
  createdAt: ISODateString;
}

/** Compare result — full comparison output */
export interface CompareResult {
  configId: UUID;
  sourceOrgId: UUID;
  targetOrgId: UUID;
  mode: CompareMode;
  summary: CompareSummary;
  /** How far the content comparison went; see `CompareContentCoverage`. */
  content: CompareContentCoverage;
  diffs: CompareItem[];
  timestamp: ISODateString;
  duration: number;
}

/** Summary statistics for a comparison */
export interface CompareSummary {
  totalItems: number;
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  /** In both orgs, content not compared: counted apart, never as a change. */
  notCompared: number;
  byType: Record<string, { added: number; removed: number; modified: number }>;
}

/**
 * What one comparison read, so that its result never reads as more than it
 * checked. Every component both orgs hold is in exactly one of `compared` or
 * `notCompared`.
 */
export interface CompareContentCoverage {
  /** Read from both orgs and compared: the `modified` and `unchanged` components. */
  compared: number;
  /** Not compared, by reason; together they are `summary.notCompared`. */
  notCompared: Record<NotComparedReason, number>;
  /**
   * Components a managed package installed, left out of both listings because
   * the run was asked to leave them out: they are in no other count. Absent
   * when none were left out.
   */
  managedLeftOut?: number;
  /**
   * The bound one run reads within: at most `components` from each org, and
   * no read started after `seconds`.
   */
  budget: { components: number; seconds: number };
}

/** A single compared item with its diff */
export interface CompareItem {
  componentType: MetadataComponentType;
  fullName: string;
  status: DiffStatus;
  /** Why a `not_compared` component was not compared; absent for every other status. */
  notComparedReason?: NotComparedReason;
  /**
   * What the component is in the source org. For `modified`, the part of its
   * content where the two orgs first differ; for `removed`, its listing.
   * Absent for `unchanged` and `not_compared`.
   */
  sourceValue?: string;
  targetValue?: string;
  fieldDiffs?: FieldDiff[];
  severity: CompareSeverity;
  deployable: boolean;
  /**
   * Installed by a managed package, as either org lists it: the package owns
   * it, and no deployment from a comparison can carry it. Absent otherwise.
   */
  managed?: boolean;
}

/** Field-level diff within a component */
export interface FieldDiff {
  fieldPath: string;
  sourceValue: string;
  targetValue: string;
  status: DiffStatus;
}

/** Severity of a difference */
export type CompareSeverity = 'info' | 'warning' | 'breaking';

/** Snapshot of org state at a point in time */
export interface OrgSnapshot {
  id: UUID;
  orgId: UUID;
  name: string;
  componentTypes: MetadataComponentType[];
  componentCount: number;
  createdAt: ISODateString;
  expiresAt?: ISODateString;
}

/**
 * Why a component a comparison found cannot be deployed from it.
 *
 * A deployment retrieves what the source holds and deploys it to the target,
 * so it can carry a component only the source holds, or one that differs,
 * provided the source can hand it over whole.
 */
export type NotDeployableReason =
  /** Installed by a managed package: the package owns it, not the org. */
  | 'managed'
  /** Its content was not compared, beyond the read budget or after a failed read: nobody knows it differs. */
  | 'not_compared'
  /** Its content cannot be read, as with the Apex of a managed package. */
  | 'unreadable'
  /** Compare lists it under a type the Metadata API does not deploy. */
  | 'type_not_deployable'
  /**
   * A profile or a permission set. Retrieved on its own it carries its label
   * and a few flags, and its access only to the components retrieved with it:
   * not the difference the comparison found.
   */
  | 'permissions_in_part'
  /** Only the target holds it: taking it out is a destructive change, which is not deployed. */
  | 'only_in_target';

/** A component of a comparison, as the Deploy tab offers it, or does not and why. */
export interface DeploymentCandidate {
  componentType: MetadataComponentType;
  fullName: string;
  /** The comparison's verdict: `removed` is only in the source, `added` only in the target. */
  status: DiffStatus;
  /** The risk the risk card gives the change; `none` for a component it does not score. */
  riskLevel: DiffRiskLevel;
  /** The risk card's group, which orders the list. */
  group: string;
  /** Why it cannot be deployed; absent when it can. */
  notDeployable?: NotDeployableReason;
}

/**
 * What a comparison offers to deploy: every change and every component left
 * unread, split into those a deployment can carry and those it cannot, in the
 * risk card's groups. The tests it advises follow from the same rule as the
 * card's advice (see `advisedTestLevel` in the webview).
 */
export interface DeploymentSuggestion {
  deployable: DeploymentCandidate[];
  notDeployable: DeploymentCandidate[];
}

/**
 * Which Apex tests a deployment runs, as the Metadata API names the levels.
 * `RunLocalTests` runs the org's own tests, none of an installed package's.
 */
export type DeployTestLevel = 'NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests';

/** A component a deployment is asked to carry. */
export interface DeploymentComponentRef {
  componentType: MetadataComponentType;
  fullName: string;
}

/**
 * What became of one component, as the target org reports it. For a
 * validation, `created` and `changed` say what a deployment would do.
 */
export type DeploymentOutcome =
  | 'created'
  | 'changed'
  | 'unchanged'
  | 'failed'
  /** Asked for, and the source did not return it: it was left out of the deployment. */
  | 'not_retrieved';

/** One component of a deployment, as the org reports it. */
export interface DeploymentComponentResult {
  /**
   * The type as the org names it. A component can be reported through the
   * file that holds it: a label's file is `CustomLabels`, a field's object
   * `CustomObject`.
   */
  componentType: string;
  fullName: string;
  outcome: DeploymentOutcome;
  /** What the org said is wrong, or why the source did not return the component. */
  problem?: string;
  /** `Warning` when the org reports a warning; a warning fails the deployment all the same. */
  problemType?: 'Error' | 'Warning';
  fileName?: string;
  line?: number;
  column?: number;
}

/** An Apex test that failed during a deployment. */
export interface DeploymentTestFailure {
  className: string;
  methodName?: string;
  message: string;
  stackTrace?: string;
  /** The first line the stack trace names, where the test failed. */
  line?: number;
}

/** What one deployment, or one validation, did in the target org. */
export interface DeploymentReport {
  /**
   * The deployment's id in the target org (0Af…), which Setup › Deployment
   * Status lists; absent when the source returned none of the components and
   * nothing was sent to the target.
   */
  deployId?: string;
  /** A validation: the org checked everything, ran the tests, and kept nothing. */
  checkOnly: boolean;
  /** The org's own status: Succeeded, Failed, Canceled…; `NotStarted` when nothing was sent. */
  status: string;
  /**
   * The org took everything it was sent, and the source returned everything
   * asked for. A validation that falls short on either is no ground for a
   * deployment.
   */
  success: boolean;
  /** Why the deployment stopped as a whole, when it did. */
  errorMessage?: string;
  sourceOrgId: string;
  targetOrgId: string;
  testLevel: DeployTestLevel;
  runTests: string[];
  /** Every component the org reports on, then those the source did not return. */
  components: DeploymentComponentResult[];
  counts: {
    componentsTotal: number;
    componentsDeployed: number;
    componentErrors: number;
    testsTotal: number;
    testsCompleted: number;
    testErrors: number;
  };
  testFailures: DeploymentTestFailure[];
  /** Coverage the org found short; in a sandbox, a warning only. */
  coverageWarnings: string[];
  /** What the source said while packing the components that names none of them. */
  retrieveProblems?: string[];
  startedAt?: ISODateString;
  completedAt?: ISODateString;
}

/** Risk level for enriched diff */
export type DiffRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** Enriched diff with intelligence */
export interface EnrichedDiff {
  category: string;
  changeType: 'added' | 'removed' | 'modified';
  name: string;
  sourceValue?: string;
  targetValue?: string;
  riskLevel: DiffRiskLevel;
  riskReasons: string[];
  group: string;
  dependencies: string[];
}

/**
 * One piece of deployment advice, as a code the page words in the reader's
 * language. It used to be an English sentence built where the diffs are
 * enriched, and it read in English in every locale.
 */
export type DeploymentAdvice =
  | { kind: 'critical'; count: number }
  | { kind: 'high'; count: number }
  | { kind: 'apexTests' }
  | { kind: 'lowRisk' }
  | { kind: 'review' };

/** Compare report with risk scoring */
export interface CompareReport {
  diffs: EnrichedDiff[];
  summary: {
    total: number;
    added: number;
    removed: number;
    modified: number;
    byRisk: Record<string, number>;
  };
  riskScore: number;
  deploymentAdvice: DeploymentAdvice[];
}
