import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';

/** Props for {@link DeleteQuestion}. */
export interface DeleteQuestionProps {
  /** Id of the question, which its delete button is described by. */
  id: string;
  /** What the delete takes and that it is gone for good, as a question. */
  question: string;
  /**
   * What the delete button says it deletes: "Delete template", "Delete these
   * 2 backups". A bare Confirm under a template's Delete sat on the row of
   * Preview and Apply, and read as confirming Apply.
   */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Prefix of its test ids: `${testId}-question`, `-confirm` and `-cancel`. */
  testId?: string;
}

/**
 * The question a Delete asks before anything is deleted, on a line of its
 * own, with its two answers: the delete, named, and Cancel.
 */
export const DeleteQuestion: React.FC<DeleteQuestionProps> = ({
  id,
  question,
  confirmLabel,
  onConfirm,
  onCancel,
  testId = 'delete-backup',
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" data-testid={`${testId}-question`}>
      <p id={id} className="text-xs text-text-primary">
        {question}
      </p>
      <div className="flex gap-2">
        <Button
          variant="danger"
          size="sm"
          aria-describedby={id}
          onClick={onConfirm}
          data-testid={`${testId}-confirm`}
        >
          {confirmLabel}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} data-testid={`${testId}-cancel`}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
