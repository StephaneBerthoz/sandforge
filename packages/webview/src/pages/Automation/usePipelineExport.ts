import { useCallback, useEffect, useState } from 'react';
import type {
  PipelineDefinition,
  PipelineExport,
  PipelineExportOutcome,
  PipelineOutsideRunner,
  PipelineRunsOutside,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { SAVE_DIALOG_WAIT_MS } from '../../hooks/useFileSave';
import { useLatestRef } from '../../hooks/useLatestRef';

/** What the host answers to `file:save`. */
export type FileSaveOutcome =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** How long the page waits on a Save dialog, as every export does: see `useFileSave`. */
export { SAVE_DIALOG_WAIT_MS };

/** The launcher a person picks in the export dialog, or none: the pipeline file alone. */
export type ExportLauncherChoice = PipelineOutsideRunner | 'none';

/** One of the saves an export makes, in the order it makes them. */
export type ExportSaveStep = 'file' | 'launcher' | 'handOver';

/**
 * Why a hand-over was not made though the launcher was saved: the launcher
 * runs the file by the name the export gave it, from its own folder, and the
 * file was saved under another name, or in another folder. Its schedule then
 * stays on in VS Code: switched off, nothing would start the pipeline at all.
 */
export type HandOverWithheld = 'renamed' | 'apart';

/** Where the saves of an export are, and what each left. */
export interface ExportSaveProgress {
  phase: 'idle' | ExportSaveStep | 'done' | 'stopped';
  /** Where the pipeline file was saved. */
  filePath?: string;
  /** Where the launcher was saved. */
  launcherPath?: string;
  /** The hand-over saved with the pipeline: its schedule is off in VS Code. */
  handedOver?: PipelineRunsOutside;
  /** Why the hand-over asked for was not made. */
  withheld?: HandOverWithheld;
  /** Where the saves stopped, and why: nothing after that step was saved. */
  stopped?: { at: ExportSaveStep; reason: 'cancelled' | 'error'; message?: string };
}

/** What the person chose in the dialog: the launcher, and whether it takes the schedule over. */
export interface ExportSavePlan {
  launcher: ExportLauncherChoice;
  handOver: boolean;
}

/** A file's name, from the path the Save dialog gave: either separator, as Windows writes one. */
export function baseNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** The folder of a saved file, as its path writes it. */
export function folderOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}

/**
 * Whether a launcher saved at `launcherPath` finds the pipeline file saved at
 * `filePath`: by the name the export gave the file, and, for the launchers
 * that run beside it, in the same folder. A GitHub Actions workflow is
 * committed under `.github/workflows` and the file at the repository's root:
 * where both were saved here says nothing of where they will be.
 */
export function handOverWithheld(
  exported: Pick<PipelineExport, 'fileName'>,
  runner: PipelineOutsideRunner,
  filePath: string,
  launcherPath: string,
): HandOverWithheld | undefined {
  if (baseNameOf(filePath) !== exported.fileName) return 'renamed';
  if (runner !== 'githubActions' && folderOf(filePath) !== folderOf(launcherPath)) return 'apart';
  return undefined;
}

/**
 * The pipeline as saved, its schedule handed over to a launcher: its schedule
 * triggers off, so VS Code no longer starts it, and `runsOutside` naming who
 * does, since when and from which file. Read back with the fields the store
 * stamps on a save (`key`, `savedAt`) left out: the save stamps them again.
 */
export function handedOverPipeline(
  saved: PipelineDefinition,
  runsOutside: PipelineRunsOutside,
): PipelineDefinition {
  const pipeline: PipelineDefinition & { key?: unknown; savedAt?: unknown } = { ...saved };
  delete pipeline.key;
  delete pipeline.savedAt;
  return {
    ...pipeline,
    triggers: (pipeline.triggers ?? []).map((trigger) =>
      trigger.type === 'schedule' ? { ...trigger, enabled: false } : trigger,
    ),
    runsOutside,
  };
}

/**
 * The export of a saved pipeline, then its saves: `pipeline:export` as the
 * dialog opens, which writes nothing; then, once the person says so, the
 * pipeline file through the Save dialog (`file:save`), the launcher beside
 * it, and the hand-over of its schedule (`pipeline:save`). Each waits for the
 * one before it to be saved: a Save dialog closed, or a save refused, stops
 * there and says so, and nothing after it is saved — above all, a schedule is
 * never switched off for a launcher that was not saved.
 *
 * @param pipeline - The pipeline as saved: what the export reads, and what the hand-over saves again.
 * @param onHandedOver - Told once the hand-over is saved, with the pipeline as saved then.
 */
export function usePipelineExport(
  pipeline: PipelineDefinition,
  onHandedOver: (saved: PipelineDefinition) => void,
): {
  /** The export, or why it was not made; null while it is read. */
  outcome: PipelineExportOutcome | null;
  /** Why the export could not be asked for or answered: a timeout, a refused request. */
  error: string | null;
  /** Save the file, then the launcher chosen, then hand the schedule over if asked. */
  save: (plan: ExportSavePlan) => void;
  progress: ExportSaveProgress;
} {
  const exportRequest = useBridgeMutation<PipelineExportOutcome>('pipeline:export');
  const fileSave = useBridgeMutation<FileSaveOutcome>('file:save', {
    responseType: 'file:save:response',
    timeoutMs: SAVE_DIALOG_WAIT_MS,
  });
  const launcherSave = useBridgeMutation<FileSaveOutcome>('file:save', {
    responseType: 'file:save:response',
    timeoutMs: SAVE_DIALOG_WAIT_MS,
  });
  const handOverSave = useBridgeMutation<{ success: boolean; id: string }>('pipeline:save');
  const [progress, setProgress] = useState<ExportSaveProgress>({ phase: 'idle' });
  const [plan, setPlan] = useState<ExportSavePlan | null>(null);

  const pipelineId = pipeline.id;
  const askExport = exportRequest.mutate;
  useEffect(() => {
    askExport({ pipelineId });
  }, [askExport, pipelineId]);

  const outcome = exportRequest.data;
  const exported = outcome?.exported ? outcome : undefined;

  const stop = useCallback(
    (at: ExportSaveStep, reason: 'cancelled' | 'error', message?: string) => {
      setProgress((previous) => ({
        ...previous,
        phase: 'stopped',
        stopped: { at, reason, ...(message ? { message } : {}) },
      }));
    },
    [],
  );
  /** Where a Save dialog's answer other than a save leaves the saves. */
  const notSaved = (at: ExportSaveStep, answer: Exclude<FileSaveOutcome, { status: 'saved' }>) => {
    if (answer.status === 'error') stop(at, 'error', answer.message);
    else stop(at, 'cancelled');
  };

  const save = useCallback(
    (next: ExportSavePlan) => {
      if (!exported) return;
      setPlan(next);
      setProgress({ phase: 'file' });
      fileSave.mutate({
        suggestedName: exported.fileName,
        content: exported.text,
        extensions: ['json'],
      });
    },
    [exported, fileSave],
  );

  const onFileSaved = useLatestRef((answer: FileSaveOutcome) => {
    if (progress.phase !== 'file') return;
    if (answer.status !== 'saved') {
      notSaved('file', answer);
      return;
    }
    const launcher =
      exported && plan && plan.launcher !== 'none' ? exported.launchers[plan.launcher] : undefined;
    if (!launcher) {
      setProgress({ phase: 'done', filePath: answer.path });
      return;
    }
    setProgress({ phase: 'launcher', filePath: answer.path });
    launcherSave.mutate({
      suggestedName: launcher.fileName,
      content: launcher.text,
      extensions: [launcher.fileName.slice(launcher.fileName.lastIndexOf('.') + 1)],
    });
  });
  useEffect(() => {
    if (fileSave.data) onFileSaved.current(fileSave.data);
  }, [fileSave.data, onFileSaved]);

  const onLauncherSaved = useLatestRef((answer: FileSaveOutcome) => {
    if (progress.phase !== 'launcher') return;
    if (answer.status !== 'saved') {
      notSaved('launcher', answer);
      return;
    }
    const filePath = progress.filePath ?? '';
    const runner = plan && plan.launcher !== 'none' ? plan.launcher : undefined;
    if (!exported || !runner || !plan?.handOver) {
      setProgress({ phase: 'done', filePath, launcherPath: answer.path });
      return;
    }
    const withheld = handOverWithheld(exported, runner, filePath, answer.path);
    if (withheld) {
      setProgress({ phase: 'done', filePath, launcherPath: answer.path, withheld });
      return;
    }
    const runsOutside: PipelineRunsOutside = {
      since: new Date().toISOString(),
      runner,
      file: baseNameOf(filePath),
      digest: exported.digest,
    };
    setProgress({
      phase: 'handOver',
      filePath,
      launcherPath: answer.path,
      handedOver: runsOutside,
    });
    const handedOver = handedOverPipeline(pipeline, runsOutside);
    handOverSave.mutate({
      id: pipeline.id,
      config: handedOver as unknown as Record<string, unknown>,
    });
  });
  useEffect(() => {
    if (launcherSave.data) onLauncherSaved.current(launcherSave.data);
  }, [launcherSave.data, onLauncherSaved]);

  const onHandOverSaved = useLatestRef((answer: { success: boolean }) => {
    if (progress.phase !== 'handOver' || !progress.handedOver) return;
    if (!answer.success) {
      stop('handOver', 'error');
      return;
    }
    setProgress((previous) => ({ ...previous, phase: 'done' }));
    onHandedOver(handedOverPipeline(pipeline, progress.handedOver));
  });
  useEffect(() => {
    if (handOverSave.data) onHandOverSaved.current(handOverSave.data);
  }, [handOverSave.data, onHandOverSaved]);

  // A save the bridge gave up on, or the host refused outside its answer.
  const failed = useLatestRef((at: ExportSaveStep, message: string) => {
    if (progress.phase === at) stop(at, 'error', message);
  });
  useEffect(() => {
    if (fileSave.error) failed.current('file', fileSave.error);
  }, [fileSave.error, failed]);
  useEffect(() => {
    if (launcherSave.error) failed.current('launcher', launcherSave.error);
  }, [launcherSave.error, failed]);
  useEffect(() => {
    if (handOverSave.error) failed.current('handOver', handOverSave.error);
  }, [handOverSave.error, failed]);

  return { outcome, error: exportRequest.error, save, progress };
}
