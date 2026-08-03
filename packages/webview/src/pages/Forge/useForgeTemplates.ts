import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeTemplate } from '../../stores/useForgeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';

/** Options for the useForgeTemplates hook. */
export interface UseForgeTemplatesOptions {
  /** Currently selected template id in the form (cleared when it is deleted). */
  selectedTemplate: string;
  /** Form setter used to clear the selection when the selected template is deleted. */
  setSelectedTemplate: (id: string) => void;
}

/** Return type for the useForgeTemplates hook. */
export interface ForgeTemplatesManager {
  /** User-created templates from the Forge store. */
  templates: ForgeTemplate[];

  /* Create form */
  showCreateForm: boolean;
  newTemplateName: string;
  setNewTemplateName: (v: string) => void;
  newTemplateDescription: string;
  setNewTemplateDescription: (v: string) => void;
  openCreateForm: () => void;
  cancelCreateForm: () => void;
  /** Create a new template from the given config snapshot. */
  handleCreateTemplate: (config: ForgeTemplate['config']) => void;

  /* Inline edit */
  editingTemplateId: string | null;
  editName: string;
  setEditName: (v: string) => void;
  editDescription: string;
  setEditDescription: (v: string) => void;
  handleStartEdit: (tpl: ForgeTemplate) => void;
  handleSaveEdit: () => void;
  handleCancelEdit: () => void;

  /* Delete confirmation */
  deleteConfirmId: string | null;
  requestDeleteTemplate: (id: string) => void;
  cancelDeleteTemplate: () => void;
  handleDeleteTemplate: () => void;
}

/**
 * Hook managing the Forge template CRUD state: creation form, inline
 * name/description editing, and delete confirmation. Store reads/writes
 * go through `useForgeStore`; success/info feedback via notifications.
 */
export function useForgeTemplates({
  selectedTemplate,
  setSelectedTemplate,
}: UseForgeTemplatesOptions): ForgeTemplatesManager {
  const { t } = useTranslation();
  const templates = useForgeStore((s) => s.templates);
  const addTemplate = useForgeStore((s) => s.addTemplate);
  const updateTemplate = useForgeStore((s) => s.updateTemplate);
  const removeTemplate = useForgeStore((s) => s.removeTemplate);
  const addNotification = useNotificationStore((s) => s.addNotification);

  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateDescription, setNewTemplateDescription] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const openCreateForm = useCallback(() => setShowCreateForm(true), []);

  const cancelCreateForm = useCallback(() => {
    setShowCreateForm(false);
    setNewTemplateName('');
    setNewTemplateDescription('');
  }, []);

  /** Create a new template from the current config. */
  const handleCreateTemplate = useCallback(
    (config: ForgeTemplate['config']) => {
      if (!newTemplateName.trim()) return;
      const template: ForgeTemplate = {
        id: `tpl-${Date.now()}`,
        name: newTemplateName.trim(),
        description: newTemplateDescription.trim(),
        config,
        objectCount: 0,
        recordCount: 0,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      addTemplate(template);
      setNewTemplateName('');
      setNewTemplateDescription('');
      setShowCreateForm(false);
      addNotification({
        level: 'success',
        title: t('forge.templateCreated'),
        message: template.name,
        autoDismissMs: 3000,
      });
    },
    [newTemplateName, newTemplateDescription, addTemplate, addNotification, t],
  );

  /** Start editing a template. */
  const handleStartEdit = useCallback((tpl: ForgeTemplate) => {
    setEditingTemplateId(tpl.id);
    setEditName(tpl.name);
    setEditDescription(tpl.description);
  }, []);

  /** Save template edits. */
  const handleSaveEdit = useCallback(() => {
    if (editingTemplateId && editName.trim()) {
      updateTemplate(editingTemplateId, {
        name: editName.trim(),
        description: editDescription.trim(),
      });
      setEditingTemplateId(null);
      addNotification({
        level: 'success',
        title: t('forge.templateUpdated'),
        message: editName,
        autoDismissMs: 3000,
      });
    }
  }, [editingTemplateId, editName, editDescription, updateTemplate, addNotification, t]);

  const handleCancelEdit = useCallback(() => setEditingTemplateId(null), []);

  const requestDeleteTemplate = useCallback((id: string) => setDeleteConfirmId(id), []);

  const cancelDeleteTemplate = useCallback(() => setDeleteConfirmId(null), []);

  /** Confirm delete a template. */
  const handleDeleteTemplate = useCallback(() => {
    if (deleteConfirmId) {
      const tpl = templates.find((t2) => t2.id === deleteConfirmId);
      removeTemplate(tpl?.name ?? '');
      setDeleteConfirmId(null);
      if (selectedTemplate === tpl?.id) {
        setSelectedTemplate('');
      }
      addNotification({
        level: 'info',
        title: t('forge.templateDeleted'),
        message: tpl?.name ?? '',
        autoDismissMs: 3000,
      });
    }
  }, [
    deleteConfirmId,
    templates,
    removeTemplate,
    selectedTemplate,
    setSelectedTemplate,
    addNotification,
    t,
  ]);

  return {
    templates,
    showCreateForm,
    newTemplateName,
    setNewTemplateName,
    newTemplateDescription,
    setNewTemplateDescription,
    openCreateForm,
    cancelCreateForm,
    handleCreateTemplate,
    editingTemplateId,
    editName,
    setEditName,
    editDescription,
    setEditDescription,
    handleStartEdit,
    handleSaveEdit,
    handleCancelEdit,
    deleteConfirmId,
    requestDeleteTemplate,
    cancelDeleteTemplate,
    handleDeleteTemplate,
  };
}
