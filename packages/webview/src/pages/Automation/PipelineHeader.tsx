import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineDefinition } from '@sandforge/shared';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';

/** The longest name the extension runs or schedules a pipeline under (`pipelineRunPayloadSchema`). */
export const PIPELINE_NAME_MAX = 200;

/** Props for {@link PipelineHeader}. */
export interface PipelineHeaderProps {
  /** The pipeline on the canvas; none before one is created or opened. */
  pipeline: PipelineDefinition | undefined;
  /** How many steps it has. */
  stepCount: number;
  /** Whether it holds work its save does not. */
  unsaved: boolean;
  /** Whether its save is on its way to the extension. */
  saving: boolean;
  /** Whether a run this page started is going. */
  running: boolean;
  /** Whether a step of it keeps it from running. */
  runBlocked: boolean;
  /** Id of the note that names those steps, beside the Run button. */
  blockedNoticeId: string;
  /** Whether the saved list Open… shows is open. */
  listOpen: boolean;
  /** Id of that list. */
  listId: string;
  /** The name field, which takes the keyboard once another pipeline is opened. */
  nameRef?: React.Ref<HTMLInputElement>;
  /** Create pipeline, and New: start an empty pipeline. */
  onCreate: () => void;
  /** Open…: show or hide the saved pipelines. */
  onToggleList: () => void;
  onRename: (name: string) => void;
  onSave: () => void;
  onRun: () => void;
}

/**
 * The header of the Automation page and of the pipeline on its canvas: the
 * pipeline's name as a field, what is not saved of it, and New, Open…, Save
 * and Run beside each other.
 *
 * The name was only in the subtitle, and the page had nothing to rename a
 * pipeline, open another, start a new one or leave one: Create Pipeline and
 * the saved list showed only while no pipeline was open, so every pipeline
 * built by hand was saved as "New Pipeline", and the way out of one was to
 * leave the page.
 */
export const PipelineHeader: React.FC<PipelineHeaderProps> = ({
  pipeline,
  stepCount,
  unsaved,
  saving,
  running,
  runBlocked,
  blockedNoticeId,
  listOpen,
  listId,
  nameRef,
  onCreate,
  onToggleList,
  onRename,
  onSave,
  onRun,
}) => {
  const { t } = useTranslation();
  const nameId = useId();
  // A blank name is saved, and then never runs: the extension reads a
  // pipeline without one as no pipeline, and its schedules start nothing.
  const named = pipeline !== undefined && pipeline.name.trim() !== '';
  const nameErrorId = `${nameId}-error`;
  const runDescribedBy =
    [runBlocked ? blockedNoticeId : undefined, named ? undefined : nameErrorId]
      .filter((id) => id !== undefined)
      .join(' ') || undefined;

  return (
    <div className="flex flex-col" data-testid="pipeline-header">
      <PageHeader
        title={t('automation.title')}
        subtitle={t('automation.subtitle')}
        icon="circuit-board"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-(--sf-space-2)">
            {pipeline === undefined ? (
              <Button
                variant="primary"
                size="sm"
                onClick={onCreate}
                data-testid="create-pipeline-btn"
              >
                {t('automation.createPipeline')}
              </Button>
            ) : (
              <>
                {/* Not while a run lasts: its progress is drawn on the
                    pipeline on the canvas, step by step. */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onCreate}
                  disabled={running}
                  data-testid="new-pipeline-btn"
                >
                  {t('automation.lifecycle.new')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onToggleList}
                  disabled={running}
                  aria-expanded={listOpen}
                  // Only while the list is there: a reference to an element
                  // the page does not draw is an error of its own.
                  aria-controls={listOpen ? listId : undefined}
                  data-testid="open-pipeline-btn"
                >
                  {t('automation.lifecycle.open')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onSave}
                  loading={saving}
                  disabled={!named}
                  aria-describedby={named ? undefined : nameErrorId}
                  data-testid="save-pipeline-btn"
                >
                  {saving ? t('automation.saving') : t('automation.savePipeline')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onRun}
                  loading={running}
                  disabled={runBlocked || !named}
                  aria-describedby={runDescribedBy}
                  data-testid="run-pipeline-btn"
                >
                  {running ? t('automation.running') : t('automation.run')}
                </Button>
              </>
            )}
          </div>
        }
      />
      {pipeline && (
        <div
          className="flex flex-wrap items-start gap-x-(--sf-space-3) gap-y-(--sf-space-1)"
          data-testid="pipeline-identity"
        >
          <div className="w-72 max-w-full">
            <Input
              ref={nameRef}
              id={nameId}
              label={t('automation.lifecycle.pipelineName')}
              value={pipeline.name}
              maxLength={PIPELINE_NAME_MAX}
              onChange={(event) => onRename(event.target.value)}
              error={named ? undefined : t('automation.lifecycle.nameRequired')}
              data-testid="pipeline-name-input"
            />
          </div>
          {/* On the line of the field, under its label. */}
          <div className="flex items-center gap-(--sf-space-2) min-[560px]:pt-6">
            <span className="text-xs text-text-secondary" data-testid="pipeline-meta">
              v{pipeline.version} · {t('automation.stepCount', { count: stepCount })}
            </span>
            {unsaved && (
              <Badge variant="warning" data-testid="pipeline-unsaved">
                {t('automation.lifecycle.unsaved')}
              </Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
