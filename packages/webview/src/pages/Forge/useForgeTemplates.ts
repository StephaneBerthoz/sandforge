import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeTemplate } from '../../stores/useForgeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useFileSave } from '../../hooks/useFileSave';
import { useSaveForgeTemplate } from './useSaveForgeTemplate';
import {
  TEMPLATE_FILE_MAX_BYTES,
  readTemplateFile,
  templateFileContent,
  templateFileName,
} from './forgeTemplateFile';
import type { TemplateFileRefusal } from './forgeTemplateFile';

/** The text of a file the user picked. */
function fileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsText(file);
  });
}

/** Options for the useForgeTemplates hook. */
export interface UseForgeTemplatesOptions {
  /** Currently selected template id in the form (cleared when it is deleted). */
  selectedTemplate: string;
  /** Form setter used to clear the selection when the selected template is deleted. */
  setSelectedTemplate: (id: string) => void;
}

/** Return type for the useForgeTemplates hook. */
export interface ForgeTemplatesManager {
  /** Saved templates, as the extension keeps them. */
  templates: ForgeTemplate[];
  /** Why the saved templates could not be listed, or null. */
  loadError: string | null;
  /**
   * Why the templates a profile import left for this workspace are not listed
   * yet — the workspace refused the write — or null. The next list tries again.
   */
  importNotMerged: string | null;

  /* Inline rename */
  editingTemplateId: string | null;
  editName: string;
  setEditName: (v: string) => void;
  editDescription: string;
  setEditDescription: (v: string) => void;
  handleStartEdit: (tpl: ForgeTemplate) => void;
  handleSaveEdit: () => void;
  handleCancelEdit: () => void;
  /** A rename is waiting for the extension's answer. */
  saving: boolean;
  /** Why the last rename failed, or null. */
  saveError: string | null;

  /* Delete confirmation */
  deleteConfirmId: string | null;
  requestDeleteTemplate: (id: string) => void;
  cancelDeleteTemplate: () => void;
  handleDeleteTemplate: () => void;
  /** Why the last delete failed, or null. */
  deleteError: string | null;

  /* Files */
  /** Offer the template to save as a file of its own, through the host's Save dialog. */
  exportTemplate: (tpl: ForgeTemplate) => void;
  /**
   * Read a file the user picked as a template and save it with the others
   * once it reads as one; refuse it, and say why, otherwise.
   */
  importTemplateFile: (file: File) => void;
  /** Why the last file picked was not taken as a template, or null. */
  importRefused: TemplateFileRefusal | null;
  /** Why the extension did not save the template the last file held, or null. */
  importError: string | null;
  /** The template the last file held, once the extension saved it. */
  imported: ForgeTemplate | null;
}

/**
 * Hook managing the saved Forge templates: the list the extension keeps,
 * inline renaming, and delete confirmation.
 *
 * The list used to live in this panel's store only: a template created here
 * was gone with the panel, and the extension's `forge:templates:*` handlers —
 * which keep templates in `.sandforge/forge-templates.json`, or in the config
 * store when no folder is open — had no caller. The list is now read from the
 * extension on mount, and every rename and delete is written through it; the
 * store changes once the extension answered that the write happened.
 */
export function useForgeTemplates({
  selectedTemplate,
  setSelectedTemplate,
}: UseForgeTemplatesOptions): ForgeTemplatesManager {
  const { t } = useTranslation();
  const templates = useForgeStore((s) => s.templates);
  const setTemplates = useForgeStore((s) => s.setTemplates);
  const removeTemplate = useForgeStore((s) => s.removeTemplate);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const list = useBridgeQuery<{ templates: ForgeTemplate[]; importNotMerged?: string }>(
    'forge:templates:list',
  );
  useEffect(() => {
    if (list.data) setTemplates(list.data.templates);
  }, [list.data, setTemplates]);

  const saver = useSaveForgeTemplate();
  const removal = useBridgeMutation<{ success: boolean }>('forge:templates:delete', {
    errorType: 'forge:templates:delete:error',
  });
  const { mutate: sendDelete } = removal;

  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  /** The rename waiting for the extension's answer. */
  const renaming = useRef<string | null>(null);
  /** The template whose delete is waiting for the extension's answer. */
  const deleting = useRef<ForgeTemplate | null>(null);

  /** Start renaming a template. */
  const handleStartEdit = useCallback((tpl: ForgeTemplate) => {
    setEditingTemplateId(tpl.id);
    setEditName(tpl.name);
    setEditDescription(tpl.description);
  }, []);

  /** Write the new name and description through the extension. */
  const handleSaveEdit = useCallback(() => {
    const tpl = templates.find((candidate) => candidate.id === editingTemplateId);
    if (!tpl || !editName.trim()) return;
    renaming.current = tpl.id;
    saver.save({ ...tpl, name: editName.trim(), description: editDescription.trim() });
  }, [templates, editingTemplateId, editName, editDescription, saver]);

  useEffect(() => {
    if (!saver.saved || saver.saved.id !== renaming.current) return;
    renaming.current = null;
    setEditingTemplateId(null);
    addNotification({
      level: 'success',
      title: t('forge.templateUpdated'),
      message: saver.saved.name,
      autoDismissMs: 3000,
    });
  }, [saver.saved, addNotification, t]);

  const handleCancelEdit = useCallback(() => setEditingTemplateId(null), []);

  const { save: saveFile } = useFileSave();
  const exportTemplate = useCallback(
    (tpl: ForgeTemplate) => saveFile(templateFileName(tpl), templateFileContent(tpl), ['json']),
    [saveFile],
  );

  // A save of its own: an import in flight holds no rename back, nor the
  // reverse, and each says its own failure where it was asked for.
  const importer = useSaveForgeTemplate();
  const { save: saveImported } = importer;
  const [importRefused, setImportRefused] = useState<TemplateFileRefusal | null>(null);
  const [importAsked, setImportAsked] = useState(false);
  const importTemplateFile = useCallback(
    (file: File) => {
      setImportRefused(null);
      setImportAsked(false);
      if (file.size > TEMPLATE_FILE_MAX_BYTES) {
        setImportRefused({ reason: 'too_large' });
        return;
      }
      fileText(file).then(
        (text) => {
          const reading = readTemplateFile(text);
          if (!reading.ok) {
            setImportRefused(
              reading.reason === 'not_template'
                ? { reason: reading.reason, where: reading.where }
                : { reason: reading.reason },
            );
            return;
          }
          setImportAsked(true);
          saveImported(reading.template);
        },
        () => setImportRefused({ reason: 'not_json' }),
      );
    },
    [saveImported],
  );

  const requestDeleteTemplate = useCallback((id: string) => setDeleteConfirmId(id), []);

  const cancelDeleteTemplate = useCallback(() => setDeleteConfirmId(null), []);

  /** Delete the confirmed template through the extension. */
  const handleDeleteTemplate = useCallback(() => {
    const tpl = templates.find((candidate) => candidate.id === deleteConfirmId);
    setDeleteConfirmId(null);
    if (!tpl) return;
    deleting.current = tpl;
    sendDelete({ templateId: tpl.id });
  }, [templates, deleteConfirmId, sendDelete]);

  useEffect(() => {
    const tpl = deleting.current;
    if (!removal.data?.success || !tpl) return;
    deleting.current = null;
    removeTemplate(tpl.id);
    if (selectedTemplate === tpl.id) setSelectedTemplate('');
    addNotification({
      level: 'info',
      title: t('forge.templateDeleted'),
      message: tpl.name,
      autoDismissMs: 3000,
    });
  }, [removal.data, removeTemplate, selectedTemplate, setSelectedTemplate, addNotification, t]);

  return {
    templates,
    loadError: list.error,
    importNotMerged: list.data?.importNotMerged ?? null,
    editingTemplateId,
    editName,
    setEditName,
    editDescription,
    setEditDescription,
    handleStartEdit,
    handleSaveEdit,
    handleCancelEdit,
    saving: saver.saving,
    saveError: saver.error,
    deleteConfirmId,
    requestDeleteTemplate,
    cancelDeleteTemplate,
    handleDeleteTemplate,
    deleteError: removal.error,
    exportTemplate,
    importTemplateFile,
    importRefused,
    importError: importAsked ? importer.error : null,
    imported: importAsked ? importer.saved : null,
  };
}
