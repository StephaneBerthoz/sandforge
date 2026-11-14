import type { PipelineOutsideRunner, PipelineVariable } from './automation.types.js';
import type {
  PipelineFileIssue,
  PipelineFileNote,
  PipelineFileNoteCode,
  PipelineFileOrgKind,
  PipelineFileSchedule,
} from './pipelineFile.types.js';
import type { CronOffsetChange, CronZoneRefusalCode } from '../utils/cronZone.js';

/**
 * A saved pipeline exported from the Automation page (`pipeline:export`): its
 * pipeline file, the launchers that start it where the editor is not, and
 * what the export dialog says of each step, org and variable before anything
 * is saved.
 *
 * The page saves the file and the launcher the person picks through
 * `file:save`; nothing here is written by the export itself.
 */

/**
 * What a step does once the pipeline runs from its file:
 *
 * - `runs`: as in the editor, with nobody asked;
 * - `asks`: it needs something of a person or of the machine the run is on —
 *   an Approval's answer, a Rewind's confirmation and its checkpoint;
 * - `refused`: the run refuses it before its first step, with the words the
 *   editor's own check gives, or because the command line never writes to a
 *   production org.
 */
export type PipelineExportStepFate = 'runs' | 'asks' | 'refused';

/** A step of an exported pipeline, as the export dialog lists it. */
export interface PipelineExportStep {
  stepId: string;
  name: string;
  type: string;
  fate: PipelineExportStepFate;
  /** The export's notes about it, by code, in the order the file holds them. */
  notes: PipelineFileNoteCode[];
  /** With `refused`: why, in English, as the run would say it. */
  refusal?: string;
}

/** An org a pipeline names, as the export dialog lists it. */
export interface PipelineExportOrg {
  /** Its key in the file's `orgs`: what `--org <key>=<alias>` names. */
  key: string;
  /** Its alias of its own; absent for an org known by its username alone. */
  alias?: string;
  /** Its own name (`Organization.Name`), when it was read. */
  name?: string;
  kind: PipelineFileOrgKind;
  staging: boolean;
  /**
   * Whether the Salesforce CLI of this machine holds it: it was connected
   * through the CLI, as every way of connecting but a username and password
   * goes. Read from how it was connected, not by asking the CLI, which calls
   * every org it holds to list them.
   */
  cliHolds: boolean;
  /** The steps that write to it, by name. */
  writtenBy: string[];
  /** The steps that read it and write nothing to it, by name. */
  readBy: string[];
}

/** A variable of an exported pipeline, as the export dialog lists it. */
export interface PipelineExportVariable {
  name: string;
  type: PipelineVariable['type'];
  required: boolean;
  /** Whether the file gives it a value: never for a secret, and not for one with no default. */
  valued: boolean;
  /**
   * The environment variable a launcher reads it from, for a secret, and for
   * a variable a run requires that the file gives no value: what
   * `--var-env <name>=<env>` names.
   */
  env?: string;
}

/** How a launcher starts the pipeline on its schedule. */
export type PipelineLauncherSchedule =
  | {
      kind: 'line';
      /** The crontab line, the Task Scheduler registration, the workflow's `cron`. */
      text: string;
      /** The zone the line is read in: this machine's for cron and Task Scheduler. */
      timezone: string;
      /** How many minutes the line was moved by, from the pipeline's zone to `timezone`. */
      offsetMinutes: number;
      /**
       * Each clock change of the coming year after which the line runs that
       * many minutes off what the pipeline's schedule says (epoch milliseconds).
       */
      offsetChanges: CronOffsetChange[];
    }
  | {
      /** The launcher cannot write its scheduler's trigger itself: a person creates it, as the reason says. */
      kind: 'manual';
      reason: string;
    }
  | {
      /** No line of that scheduler runs at the moments the pipeline's schedule says. */
      kind: 'refused';
      code: CronZoneRefusalCode;
      reason: string;
    };

/** A launcher written beside the pipeline file. */
export interface PipelineLauncher {
  /** What starts it: cron (the bash launcher), Task Scheduler (PowerShell), or GitHub Actions. */
  runner: PipelineOutsideRunner;
  /** The name it is saved under, beside the pipeline file. */
  fileName: string;
  text: string;
  /** How it is started on the pipeline's schedule; absent for a pipeline with none. */
  schedule?: PipelineLauncherSchedule;
}

/** A pipeline exported: what is saved, and what the dialog says before it is. */
export interface PipelineExport {
  /** The pipeline file's name: `<pipeline name>.sandforge-pipeline.json`. */
  fileName: string;
  /** The pipeline file, ready to save. */
  text: string;
  /** Its digest (`SandforgePipelineFile.digest`): what `runsOutside.digest` keeps at a hand-over. */
  digest: string;
  schedule: PipelineFileSchedule | null;
  steps: PipelineExportStep[];
  orgs: PipelineExportOrg[];
  variables: PipelineExportVariable[];
  launchers: Record<PipelineOutsideRunner, PipelineLauncher>;
  /** The notes the file holds, in its order. */
  notes: PipelineFileNote[];
  /**
   * Every refusal the editor's check makes of the pipeline as saved, in
   * English: what a run from the file refuses before its first step too.
   * Empty when the editor runs it.
   */
  problems: string[];
}

/**
 * Why a pipeline was not exported:
 *
 * - `NOT_SAVED`: no pipeline is saved under that id — the page holds one not
 *   saved yet, or deleted since;
 * - `ORG_UNKNOWN`: a step or a Sync configuration names an org no longer
 *   registered here;
 * - `SYNC_CONFIG_UNKNOWN`: a Sync step runs a configuration no longer saved;
 * - `SCHEDULES_MANY`: more than one schedule starts it, and a file carries one;
 * - `FILE_INVALID`: the file would not read, for each of `issues` — a setting
 *   past its bounds, an Organization Id that is none;
 * - `VERSION_UNKNOWN`: this host does not say which release it is, which the
 *   file and its launchers name.
 */
export type PipelineExportRefusalCode =
  | 'NOT_SAVED'
  | 'ORG_UNKNOWN'
  | 'SYNC_CONFIG_UNKNOWN'
  | 'SCHEDULES_MANY'
  | 'FILE_INVALID'
  | 'VERSION_UNKNOWN';

/** A pipeline exported, or why it was not: nothing is saved then. */
export type PipelineExportOutcome =
  | ({ exported: true; pipelineId: string } & PipelineExport)
  | {
      exported: false;
      pipelineId: string;
      code: PipelineExportRefusalCode;
      /** Why, in English, with what to do. */
      message: string;
      /** With `FILE_INVALID`: each issue, where it is in the file. */
      issues?: PipelineFileIssue[];
    };

/**
 * A pipeline whose schedule was handed over at an export, as `pipeline:list`
 * tells the page: whether the file exported then still holds what an export
 * would write now. A save, a setting, an org's alias changed since all make
 * it differ, and the page says the file lacks the change.
 */
export interface PipelineOutsideStatus {
  pipelineId: string;
  /** Whether the digest an export writes now is the one handed over. */
  matches: boolean;
  /** The digest an export writes now; absent when no file can be written now, which `matches` is false for. */
  digest?: string;
}
