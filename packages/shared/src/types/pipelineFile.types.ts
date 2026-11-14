import type { ISODateString } from './common.types.js';
import type { PipelineVariable } from './automation.types.js';

/**
 * A pipeline file: one saved pipeline of the Automation page, with all it
 * needs to run where VS Code is not — the orgs it names, by alias and by
 * Organization Id; the Sync configurations, Seed templates and masking
 * templates the editor keeps in its own storage; the settings its steps read;
 * and its schedule. The command line runs it (`sandforge pipeline`), and the
 * launchers the export writes beside it call that command.
 *
 * It never holds a username, a token or a secret variable's value: a file
 * like this one is committed, attached to a ticket, copied to a CI secret's
 * neighbour. An org is named by its alias of its own, or not at all, and the
 * command line maps it to an alias of the machine it runs on.
 *
 * Read by `parsePipelineFile` (`utils/pipelineFile.ts`), written by
 * `writePipelineFile`; the schema there is pinned to these types by its test.
 */

/**
 * What an org of a pipeline file is: a sandbox, a scratch org, a Developer
 * Edition org, or a production org. The command line types each org again
 * when it connects; the file says what the export saw.
 */
export type PipelineFileOrgKind = 'sandbox' | 'scratch' | 'developer' | 'production';

/** An org a pipeline names, as the file carries it, under the id the editor's registry gave it. */
export interface PipelineFileOrg {
  /**
   * Its alias of its own, as the Salesforce CLI knows it on the machine that
   * exported it. Absent when it had none — an org known by its username
   * alone: the run then needs `--org <key>=<alias>`, and the file a note
   * that says so. Never a username, nor shaped as one.
   */
  alias?: string;
  /** The Organization Id (`00D…`) the export read: a sandbox refreshed since is another org. */
  organizationId: string;
  kind: PipelineFileOrgKind;
  /**
   * Marked Staging in Org Manager: a sandbox holding real data. Read of a
   * sandbox alone, as Production Guard reads the mark; a file that marks
   * another kind of org does not read.
   */
  staging: boolean;
  /** Its own name (`Organization.Name`), when the export knew it; never a username. */
  name?: string;
}

/** When the pipeline's schedule starts it: its cron expression, and the time zone it is read in. */
export interface PipelineFileSchedule {
  cron: string;
  /**
   * The IANA time zone, always written: the editor reads a schedule saved
   * without one in its own zone, which another machine — a CI runner in UTC —
   * does not share.
   */
  timezone: string;
}

/**
 * A step of the pipeline, as the editor saved it. Its type is any text: a
 * step SandForge no longer has, or does not have yet, still reads, and the
 * run refuses it before its first step, naming it — as the editor does. Its
 * other fields — `continueOnError`, `timeout`, `retries`, `condition`, the
 * routes `onSuccess` and `onFailure` — travel as they were written, and the
 * run reads them as the editor's run does.
 */
export interface PipelineFileStep {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  [field: string]: unknown;
}

/** The saved pipeline, without its triggers: the schedule is the file's own. */
export interface PipelineFilePipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineFileStep[];
  /** Its variables; a secret one never carries its value (`defaultValue`). */
  variables: PipelineVariable[];
  tags: string[];
}

/**
 * A Sync configuration, a Seed template or a masking template as the editor
 * stored it, under its id. The command line hands it to the same store the
 * editor reads, and the step that names it checks it as the editor does: a
 * configuration that no longer validates is refused by the plan, naming the
 * step, never at the file's door.
 */
export interface PipelineFileStored {
  id: string;
  [field: string]: unknown;
}

/** A Sync configuration as stored, with the two orgs it names, by their keys in `orgs`. */
export interface PipelineFileSyncConfig extends PipelineFileStored {
  sourceOrgId?: string;
  targetOrgId?: string;
}

/**
 * The settings the steps of a pipeline read, as they were where it was
 * exported. A setting the file does not hold is read at its default, as an
 * editor that never set it would.
 */
export interface PipelineFileSettings {
  'pipeline.timeout'?: number;
  'sync.maxRecordsPerObject'?: number;
  'sync.defaultBatchSize'?: number;
  'seed.defaultBatchSize'?: number;
  'backup.maxRecordsPerObject'?: number;
  'backup.maxCount'?: number;
  'backup.maxAgeDays'?: number;
  'safety.auditLogging'?: boolean;
  'safety.confirmAboveRecords'?: number;
  'grappe.enabled'?: boolean;
  'grappe.autoActivateThreshold'?: number;
  'grappe.grappeSize'?: number;
}

/** A setting a pipeline file may hold. */
export type PipelineFileSettingKey = keyof PipelineFileSettings;

/**
 * The notes an export writes: what a run of the file asks of the machine it
 * runs on, or of a person, and what it leaves behind.
 *
 * - `APPROVAL_NEEDS_PERSON`: an Approval step asks a person — at the
 *   terminal, or answered ahead by `--approve "<step>"`.
 * - `STAGING_NEEDS_PERSON`: an Approval step guards a write to a sandbox
 *   marked Staging, which only a person at a terminal answers.
 * - `REWIND_NEEDS_CONFIRMATION`: a Rewind step runs once its org's alias is
 *   typed for it (`pipeline confirm`) or given by `--confirm-rewind <alias>`.
 * - `REWIND_CHECKPOINT_ELSEWHERE`: a Rewind step's checkpoint is on the
 *   machine that exported the pipeline, and must be on the one that runs it.
 * - `ORG_NO_ALIAS`: an org has no alias of its own: set one with the
 *   Salesforce CLI, then map it with `--org <key>=<alias>`.
 * - `ORG_NOT_SIGNED_IN`: the Salesforce CLI of the exporting machine knows no
 *   org by that alias: sign in to it under that alias.
 * - `SECRET_NOT_EXPORTED`: a secret variable's value stays out of the file:
 *   give it with `--var-env <name>=<environment variable>`.
 * - `NOTIFICATION_PRINTED`: a Notification step prints its message, with no
 *   VS Code window to show it in.
 * - `STEP_REFUSED`: a step a pipeline refuses everywhere — Restore, Delete,
 *   one SandForge no longer has.
 * - `TRIGGER_NOT_EXPORTED`: a trigger only the editor watches — a sandbox
 *   refresh, an event, a webhook — does not start the file's runs.
 */
export type PipelineFileNoteCode =
  | 'APPROVAL_NEEDS_PERSON'
  | 'STAGING_NEEDS_PERSON'
  | 'REWIND_NEEDS_CONFIRMATION'
  | 'REWIND_CHECKPOINT_ELSEWHERE'
  | 'ORG_NO_ALIAS'
  | 'ORG_NOT_SIGNED_IN'
  | 'SECRET_NOT_EXPORTED'
  | 'NOTIFICATION_PRINTED'
  | 'STEP_REFUSED'
  | 'TRIGGER_NOT_EXPORTED';

/**
 * A note of the export, in English, with the code a page translates it by:
 * one of {@link PipelineFileNoteCode}. A code this release does not know
 * still reads, and its text says it.
 */
export interface PipelineFileNote {
  code: string;
  text: string;
  /** The step it is about, by name. */
  step?: string;
  /** The org it is about, by its key in `orgs`. */
  org?: string;
}

/** A pipeline file, version 1, as it is written and read. */
export interface SandforgePipelineFile {
  /** The version of the format: what tells a pipeline file from any other JSON. */
  sandforgePipeline: 1;
  exportedAt: ISODateString;
  /** `SandForge <version>`: the release that wrote it, which a newer format names. */
  exportedBy: string;
  /**
   * `sha256:` and 64 hex digits, of everything the file says a run does — its
   * pipeline, schedule, orgs, configurations, templates and settings — and of
   * nothing else: not when it was written, by which release, nor its notes.
   * The editor compares it with the pipeline it saves since, and the command
   * line tells a file edited by hand.
   */
  digest: string;
  pipeline: PipelineFilePipeline;
  schedule: PipelineFileSchedule | null;
  /** Each org the pipeline names, under the id the editor's registry gave it. */
  orgs: Record<string, PipelineFileOrg>;
  /** The Sync configurations its Sync steps run, by id. */
  syncConfigs: Record<string, PipelineFileSyncConfig>;
  /** The Seed templates the Seed page saved that its Seed steps name; a shipped one (`prebuilt-*`) goes by its id alone. */
  seedTemplates: Record<string, PipelineFileStored>;
  /** The masking templates the DataOps page saved that its Anonymize steps name; a shipped one (`tpl-*`) goes by its id alone. */
  maskingTemplates: Record<string, PipelineFileStored>;
  settings: PipelineFileSettings;
  notes: PipelineFileNote[];
}

/** What an export hands `writePipelineFile`: the file, less what the writing works out. */
export interface PipelineFileDraft {
  exportedAt: ISODateString;
  /** The release exporting it: `1.81.0`. */
  sandforgeVersion: string;
  pipeline: PipelineFilePipeline;
  schedule: PipelineFileSchedule | null;
  orgs: Record<string, PipelineFileOrg>;
  syncConfigs: Record<string, PipelineFileSyncConfig>;
  seedTemplates: Record<string, PipelineFileStored>;
  maskingTemplates: Record<string, PipelineFileStored>;
  settings: PipelineFileSettings;
  notes: PipelineFileNote[];
}

/** One thing wrong with a pipeline file: where, as a dotted path, and what. */
export interface PipelineFileIssue {
  path: string;
  message: string;
}

/**
 * Why a pipeline file does not read:
 *
 * - `PIPELINE_FILE_NOT_JSON`: the text is not JSON.
 * - `PIPELINE_FILE_NOT_A_PIPELINE`: it is JSON, and no pipeline file: no
 *   `sandforgePipeline` version — a saved pipeline copied by hand, a profile
 *   export.
 * - `PIPELINE_FILE_NEWER`: a later release wrote it, in a version of the
 *   format this one does not read.
 * - `PIPELINE_FILE_INVALID`: a version-1 file this release refuses, with
 *   every issue found, not the first alone.
 */
export type PipelineFileRefusalCode =
  | 'PIPELINE_FILE_NOT_JSON'
  | 'PIPELINE_FILE_NOT_A_PIPELINE'
  | 'PIPELINE_FILE_NEWER'
  | 'PIPELINE_FILE_INVALID';

/** A pipeline file refused, with what a person needs to fix it or to run it elsewhere. */
export interface PipelineFileRefusal {
  code: PipelineFileRefusalCode;
  /** What is wrong, in English. */
  message: string;
  /** Each issue, for `PIPELINE_FILE_INVALID`; empty otherwise. */
  issues: PipelineFileIssue[];
  /** The version of the format the file says it is in, when it says one. */
  fileVersion?: number;
  /** The release that wrote it, `1.83.0`, when `exportedBy` names one: what reads a newer file. */
  exporterVersion?: string;
}

/**
 * A pipeline file read: the file, and whether its digest is still that of
 * what it holds — false once it was edited by hand since it was exported.
 */
export type PipelineFileRead =
  | { ok: true; file: SandforgePipelineFile; digestMatches: boolean }
  | { ok: false; refusal: PipelineFileRefusal };

/** A pipeline file written: the file, and its text, ready to save. */
export type PipelineFileWritten =
  | { ok: true; file: SandforgePipelineFile; text: string }
  | { ok: false; issues: PipelineFileIssue[] };

/**
 * Where an org of a pipeline file is named: by a step's configuration, or by
 * a Sync configuration a Sync step runs. What the command line rewrites once
 * it has connected the org, and what the reading checks `orgs` holds.
 */
export interface PipelineFileOrgRef {
  /** The org's key in `orgs`. */
  key: string;
  /** The field that names it: `orgId`, `sourceOrgId`, `targetOrgId`. */
  field: string;
  /** The step's configuration that names it, by step id. */
  stepId?: string;
  /** The Sync configuration that names it, by id. */
  syncConfigId?: string;
}
