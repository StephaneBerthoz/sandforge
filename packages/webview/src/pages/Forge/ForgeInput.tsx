import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Database, FileCode, Sparkles, Layers, Search, Loader2, X,
  ArrowLeftRight, Lock, Ban, AlertTriangle, Flame, RefreshCw,
  Plus, Pencil, Trash2, Check,
} from 'lucide-react';
import { cn } from '../../theme';
import { OrgDropdown } from '../../components/ui/OrgDropdown';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { useForgeStore } from '../../stores/useForgeStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import type { ForgeConfig, ForgeDepth, ForgeInputMode, ForgeTemplate } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSendMessage, useMessageListener } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import type { BaseMessage, SalesforceOrg } from '@sandforge/shared';

/** Tab configuration for the Forge input modes. */
interface TabConfig {
  /** Tab identifier matching ForgeInputMode. */
  id: ForgeInputMode;
  /** i18n key for the tab label. */
  labelKey: string;
  /** Icon component rendered inside the trigger. */
  icon: React.ReactNode;
  /** data-testid for the tab trigger. */
  testId: string;
}

/** Static tab configuration. */
const TABS: TabConfig[] = [
  { id: 'record', labelKey: 'forge.recordTab', icon: <Database size={14} />, testId: 'forge-tab-record' },
  { id: 'soql', labelKey: 'forge.soqlTab', icon: <FileCode size={14} />, testId: 'forge-tab-soql' },
  { id: 'template', labelKey: 'forge.templateTab', icon: <Layers size={14} />, testId: 'forge-tab-template' },
  { id: 'ai', labelKey: 'forge.aiTab', icon: <Sparkles size={14} />, testId: 'forge-tab-ai' },
];

/** Preview data returned by the extension for a Salesforce record. */
interface RecordPreview {
  objectApiName: string;
  objectLabel: string;
  recordId: string;
  fields: Array<{ name: string; value: string }>;
}

/** Common PII field name patterns for badge detection. */
const PII_FIELD_PATTERNS = [
  /email/i, /phone/i, /mobile/i, /fax/i,
  /street/i, /address/i, /city/i, /postal/i, /zip/i,
  /ssn/i, /birth/i, /personal/i,
];

/** Check if a field name matches common PII patterns. */
function isPiiField(fieldName: string): boolean {
  return PII_FIELD_PATTERNS.some((p) => p.test(fieldName));
}

/** Extract a Salesforce Record ID from a plain ID or Salesforce URL. */
function extractRecordId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$|\?)/);
  return match?.[1] ?? null;
}

/** Extract the hostname/pod from a Salesforce URL or instanceUrl. */
function extractSalesforceDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

/** Depth option values for the chip selector. */
const DEPTH_OPTIONS: ForgeDepth[] = ['direct', 'full', 'custom'];

/** Map depth value to its i18n key. */
const DEPTH_KEYS: Record<ForgeDepth, string> = {
  direct: 'forge.depthDirect',
  full: 'forge.depthFull',
  custom: 'forge.depthCustom',
};

/** Map depth value to its tooltip i18n key. */
const DEPTH_TOOLTIP_KEYS: Record<ForgeDepth, string> = {
  direct: 'forge.depthDirectTooltip',
  full: 'forge.depthFullTooltip',
  custom: 'forge.depthCustomTooltip',
};

/**
 * Forge input form -- Mission Control + Live Preview hybrid layout.
 * Org cards with status indicators at top, tabbed input in a card,
 * depth chips, option toggles, and a live preview panel on the right.
 */
export const ForgeInput: React.FC = () => {
  const { t } = useTranslation();
  const setConfig = useForgeStore((s) => s.setConfig);
  const setPhase = useForgeStore((s) => s.setPhase);
  const templates = useForgeStore((s) => s.templates);
  const addTemplate = useForgeStore((s) => s.addTemplate);
  const updateTemplate = useForgeStore((s) => s.updateTemplate);
  const removeTemplate = useForgeStore((s) => s.removeTemplate);
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const addNotification = useNotificationStore((s) => s.addNotification);
  const sendMessage = useSendMessage();

  /* ---- Local form state ---- */
  const [inputMode, setInputMode] = useState<ForgeInputMode>('record');
  const [recordId, setRecordId] = useState('');
  const [soqlQuery, setSoqlQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [depth, setDepth] = useState<ForgeDepth>('direct');
  const [customDepth, setCustomDepth] = useState(3);
  const [sourceOrgId, setSourceOrgId] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [anonymize, setAnonymize] = useState(false);
  const [skipEmpty, setSkipEmpty] = useState(false);

  /* ---- Template management state ---- */
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateDescription, setNewTemplateDescription] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  /* ---- UX-01: Auto-select source org from global selectedOrgId on mount ---- */
  useEffect(() => {
    if (!sourceOrgId && selectedOrgId) {
      setSourceOrgId(selectedOrgId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- Record preview state ---- */
  const [preview, setPreview] = useState<RecordPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useMessageListener<BaseMessage & { payload: RecordPreview }>(
    'forge:preview:response',
    useCallback((msg) => {
      setPreview(msg.payload);
      setPreviewLoading(false);
      setPreviewError(null);
    }, []),
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'forge:preview:error',
    useCallback((msg) => {
      setPreviewLoading(false);
      setPreviewError(msg.payload.message);
    }, []),
  );

  /* ---- Derived state ---- */
  const sourceOrg = useMemo(() => orgs.find((o) => o.id === sourceOrgId), [orgs, sourceOrgId]);
  const targetOrg = useMemo(() => orgs.find((o) => o.id === targetOrgId), [orgs, targetOrgId]);

  const piiFieldCount = useMemo(
    () => preview?.fields.filter((f) => isPiiField(f.name)).length ?? 0,
    [preview],
  );

  /** Whether the current input has enough data to proceed. */
  const hasInput = useCallback((): boolean => {
    switch (inputMode) {
      case 'record':
        return recordId.trim().length > 0;
      case 'soql':
        return soqlQuery.trim().length > 0;
      case 'template':
        return selectedTemplate.length > 0;
      case 'ai':
        return aiPrompt.trim().length > 0;
    }
  }, [inputMode, recordId, soqlQuery, selectedTemplate, aiPrompt]);

  const sameOrgSelected = sourceOrgId.length > 0 && sourceOrgId === targetOrgId;
  const canDiscover = hasInput() && sourceOrgId.length > 0 && targetOrgId.length > 0 && !sameOrgSelected;

  /** Fetch a preview of the record from the source org. */
  const handlePreview = useCallback(() => {
    const id = extractRecordId(recordId);
    if (!id || !sourceOrgId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    sendMessage(buildMessage<{ recordId: string; orgId: string }>('forge:preview', {
      recordId: id,
      orgId: sourceOrgId,
    }));
  }, [recordId, sourceOrgId, sendMessage]);

  /* ---- Auto-trigger preview when record ID is valid ---- */
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    const id = extractRecordId(recordId);
    if (id && sourceOrgId && !previewLoading) {
      previewTimerRef.current = setTimeout(() => handlePreview(), 400);
    }
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current); };
  }, [recordId, sourceOrgId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Create a new template from the current config. */
  const handleCreateTemplate = useCallback(() => {
    if (!newTemplateName.trim()) return;
    const template: ForgeTemplate = {
      id: `tpl-${Date.now()}`,
      name: newTemplateName.trim(),
      description: newTemplateDescription.trim(),
      config: {
        inputMode,
        depth,
        customDepth: depth === 'custom' ? customDepth : undefined,
        anonymizePII: anonymize,
        skipEmpty,
        batchSize: 'auto',
        ...(inputMode === 'record' && recordId ? { recordId: extractRecordId(recordId) ?? undefined } : {}),
        ...(inputMode === 'soql' && soqlQuery ? { soqlQuery } : {}),
        ...(inputMode === 'ai' && aiPrompt ? { aiPrompt } : {}),
      },
      objectCount: 0,
      recordCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    addTemplate(template);
    setNewTemplateName('');
    setNewTemplateDescription('');
    setShowCreateForm(false);
    addNotification({ level: 'success', title: t('forge.templateCreated'), message: template.name, autoDismissMs: 3000 });
  }, [newTemplateName, newTemplateDescription, inputMode, depth, customDepth, anonymize, skipEmpty, recordId, soqlQuery, aiPrompt, addTemplate, addNotification, t]);

  /** Start editing a template. */
  const handleStartEdit = useCallback((tpl: ForgeTemplate) => {
    setEditingTemplateId(tpl.id);
    setEditName(tpl.name);
    setEditDescription(tpl.description);
  }, []);

  /** Save template edits. */
  const handleSaveEdit = useCallback(() => {
    if (editingTemplateId && editName.trim()) {
      updateTemplate(editingTemplateId, { name: editName.trim(), description: editDescription.trim() });
      setEditingTemplateId(null);
      addNotification({ level: 'success', title: t('forge.templateUpdated'), message: editName, autoDismissMs: 3000 });
    }
  }, [editingTemplateId, editName, editDescription, updateTemplate, addNotification, t]);

  /** Confirm delete a template. */
  const handleDeleteTemplate = useCallback(() => {
    if (deleteConfirmId) {
      const tpl = templates.find((t2) => t2.id === deleteConfirmId);
      removeTemplate(tpl?.name ?? '');
      setDeleteConfirmId(null);
      if (selectedTemplate === tpl?.name) {
        setSelectedTemplate('');
      }
      addNotification({ level: 'info', title: t('forge.templateDeleted'), message: tpl?.name ?? '', autoDismissMs: 3000 });
    }
  }, [deleteConfirmId, templates, removeTemplate, selectedTemplate, addNotification, t]);

  /** Build config and transition to discovery phase. */
  const handleDiscover = useCallback(() => {
    if (!canDiscover) return;

    const config: ForgeConfig = {
      inputMode,
      depth,
      recordId: inputMode === 'record' ? (extractRecordId(recordId) ?? undefined) : undefined,
      soqlQuery: inputMode === 'soql' ? soqlQuery.trim() : undefined,
      templateId: inputMode === 'template' ? selectedTemplate : undefined,
      aiPrompt: inputMode === 'ai' ? aiPrompt.trim() : undefined,
      customDepth: depth === 'custom' ? customDepth : undefined,
      anonymizePII: anonymize,
      skipEmpty,
      sourceOrgId,
      targetOrgId,
      batchSize: 'auto',
    };

    setConfig(config);
    sendMessage(buildMessage<{ config: ForgeConfig }>('forge:discover', { config }));
    setPhase('discovery');
  }, [
    canDiscover, inputMode, depth, recordId, soqlQuery, selectedTemplate,
    aiPrompt, customDepth, anonymize, skipEmpty, sourceOrgId, targetOrgId,
    setConfig, setPhase, sendMessage,
  ]);

  return (
    <div className="flex flex-col gap-4" data-testid="forge-input">
      {/* ===== ORG CARDS ROW ===== */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
        <OrgCard
          labelKey="forge.sourceOrg"
          org={sourceOrg}
          orgId={sourceOrgId}
          onOrgChange={setSourceOrgId}
          orgs={orgs}
          testId="forge-source-org"
        />
        <button
          type="button"
          data-testid="forge-swap-orgs"
          onClick={() => {
            const tmp = sourceOrgId;
            setSourceOrgId(targetOrgId);
            setTargetOrgId(tmp);
          }}
          className={cn(
            'text-forge hover:text-forge/80 transition-colors p-1 rounded-md',
            'hover:bg-forge/10',
          )}
          aria-label={t('forge.swapOrgs')}
          title={t('forge.swapOrgs')}
        >
          <ArrowLeftRight size={22} strokeWidth={2.5} />
        </button>
        <OrgCard
          labelKey="forge.targetOrg"
          org={targetOrg}
          orgId={targetOrgId}
          onOrgChange={setTargetOrgId}
          orgs={orgs}
          testId="forge-target-org"
        />
      </div>

      {/* UX-03: Same-org warning */}
      {sameOrgSelected && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20"
          data-testid="forge-same-org-warning"
        >
          <AlertTriangle size={14} />
          {t('forge.sameOrgWarning')}
        </div>
      )}

      {/* ===== MAIN GRID: Form + Preview ===== */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_260px] gap-4">
        {/* ---- LEFT: Form column ---- */}
        <div className="flex flex-col gap-3">
          {/* Tabs card */}
          <div className="rounded-lg border border-subtle bg-surface-1 overflow-hidden">
            <Tabs.Root
              value={inputMode}
              onValueChange={(v) => setInputMode(v as ForgeInputMode)}
            >
              <Tabs.List
                className="flex border-b border-subtle"
                aria-label={t('nav.forge')}
              >
                {TABS.map((tab) => (
                  <Tabs.Trigger
                    key={tab.id}
                    value={tab.id}
                    data-testid={tab.testId}
                    className={cn(
                      'flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm transition-colors',
                      'text-text-muted hover:text-text-primary',
                      'data-[state=active]:text-forge data-[state=active]:border-b-2 data-[state=active]:border-forge',
                      'data-[state=active]:bg-surface-2',
                    )}
                  >
                    {tab.icon}
                    {t(tab.labelKey)}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <div className="p-3">
                {/* Record tab */}
                <Tabs.Content value="record" className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <input
                      data-testid="forge-input-record"
                      type="text"
                      value={recordId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setRecordId(val);
                        setPreview(null);
                        setPreviewError(null);
                        // UX-02: Auto-detect org from pasted URL domain
                        const domain = extractSalesforceDomain(val);
                        if (domain) {
                          const matchedOrg = orgs.find((o) => {
                            const orgDomain = extractSalesforceDomain(o.instanceUrl);
                            return orgDomain && orgDomain === domain;
                          });
                          if (matchedOrg && !sourceOrgId) {
                            setSourceOrgId(matchedOrg.id);
                          }
                        }
                      }}
                      placeholder={t('forge.recordIdPlaceholder')}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-md text-sm font-mono',
                        'bg-[var(--vscode-input-background,#1e1e3a)]',
                        'text-[var(--vscode-input-foreground,#d4d4d4)]',
                        'border border-[var(--vscode-input-border,#3a3a5c)]',
                        'focus:outline-none focus:border-forge/50',
                      )}
                    />
                    <button
                      type="button"
                      data-testid="forge-preview-btn"
                      aria-label={t('forge.refreshPreview')}
                      disabled={extractRecordId(recordId) === null || sourceOrgId.length === 0 || previewLoading}
                      onClick={handlePreview}
                      title={t('forge.refreshPreview')}
                      className={cn(
                        'shrink-0 px-2.5 py-2 rounded-md text-sm transition-colors',
                        'border border-[var(--vscode-input-border,#3a3a5c)]',
                        'bg-[var(--vscode-input-background,#1e1e3a)]',
                        'text-text-muted hover:text-forge hover:border-forge/50',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                      )}
                    >
                      {previewLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    </button>
                  </div>
                  {previewError && (
                    <div className="p-2 rounded-md text-sm text-red-400 bg-red-500/10 border border-red-500/20">
                      {previewError}
                    </div>
                  )}
                </Tabs.Content>

                {/* SOQL tab */}
                <Tabs.Content value="soql">
                  <textarea
                    data-testid="forge-input-soql"
                    value={soqlQuery}
                    onChange={(e) => setSoqlQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canDiscover) {
                        e.preventDefault();
                        handleDiscover();
                      }
                    }}
                    placeholder={t('forge.soqlPlaceholder')}
                    rows={5}
                    className={cn(
                      'w-full px-3 py-2 rounded-md text-sm font-mono resize-y',
                      'bg-[var(--vscode-input-background,#1e1e3a)]',
                      'text-[var(--vscode-input-foreground,#d4d4d4)]',
                      'border border-[var(--vscode-input-border,#3a3a5c)]',
                      'focus:outline-none focus:border-forge/50',
                    )}
                  />
                </Tabs.Content>

                {/* Template tab — forceMount keeps state alive for CRUD management */}
                <Tabs.Content value="template" forceMount className={inputMode !== 'template' ? 'hidden' : ''}>
                  <div data-testid="forge-input-template" className="flex flex-col gap-2">
                    {/* Create template button/form */}
                    {showCreateForm ? (
                      <div className="flex flex-col gap-2 p-3 rounded-md border border-forge/30 bg-forge/5">
                        <input
                          type="text"
                          data-testid="forge-template-name-input"
                          value={newTemplateName}
                          onChange={(e) => setNewTemplateName(e.target.value)}
                          placeholder={t('forge.templateName')}
                          className={cn(
                            'px-3 py-1.5 rounded-md text-sm',
                            'bg-[var(--vscode-input-background,#1e1e3a)]',
                            'text-[var(--vscode-input-foreground,#d4d4d4)]',
                            'border border-[var(--vscode-input-border,#3a3a5c)]',
                            'focus:outline-none focus:border-forge/50',
                          )}
                        />
                        <input
                          type="text"
                          data-testid="forge-template-desc-input"
                          value={newTemplateDescription}
                          onChange={(e) => setNewTemplateDescription(e.target.value)}
                          placeholder={t('forge.templateDescription')}
                          className={cn(
                            'px-3 py-1.5 rounded-md text-sm',
                            'bg-[var(--vscode-input-background,#1e1e3a)]',
                            'text-[var(--vscode-input-foreground,#d4d4d4)]',
                            'border border-[var(--vscode-input-border,#3a3a5c)]',
                            'focus:outline-none focus:border-forge/50',
                          )}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            data-testid="forge-template-save"
                            onClick={handleCreateTemplate}
                            disabled={!newTemplateName.trim()}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-forge text-white disabled:opacity-40"
                          >
                            <Check size={12} />
                            {t('forge.createTemplate')}
                          </button>
                          <button
                            type="button"
                            data-testid="forge-template-cancel"
                            onClick={() => { setShowCreateForm(false); setNewTemplateName(''); setNewTemplateDescription(''); }}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs text-text-muted hover:text-text-primary"
                          >
                            <X size={12} />
                            {t('forge.cancelEdit')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid="forge-template-create"
                        onClick={() => setShowCreateForm(true)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm border border-dashed border-subtle text-text-muted hover:text-forge hover:border-forge/30 transition-colors"
                      >
                        <Plus size={14} />
                        {t('forge.createTemplate')}
                      </button>
                    )}

                    {/* Template list */}
                    {templates.length === 0 && !showCreateForm ? (
                      <p className="text-sm text-text-muted italic">{t('forge.noTemplates')}</p>
                    ) : (
                      templates.map((tpl) => (
                        <div
                          key={tpl.id}
                          className={cn(
                            'flex items-start gap-2 px-3 py-2 rounded-md text-sm border transition-colors',
                            selectedTemplate === tpl.name
                              ? 'border-forge bg-forge/10 text-text-primary'
                              : 'border-subtle bg-surface-2 text-text-secondary hover:border-forge/30',
                          )}
                        >
                          {editingTemplateId === tpl.id ? (
                            <div className="flex-1 flex flex-col gap-1">
                              <input
                                type="text"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                data-testid="forge-template-edit-name"
                                className={cn(
                                  'px-2 py-1 rounded text-sm',
                                  'bg-[var(--vscode-input-background,#1e1e3a)]',
                                  'text-[var(--vscode-input-foreground,#d4d4d4)]',
                                  'border border-[var(--vscode-input-border,#3a3a5c)]',
                                )}
                              />
                              <input
                                type="text"
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                data-testid="forge-template-edit-desc"
                                className={cn(
                                  'px-2 py-1 rounded text-xs',
                                  'bg-[var(--vscode-input-background,#1e1e3a)]',
                                  'text-[var(--vscode-input-foreground,#d4d4d4)]',
                                  'border border-[var(--vscode-input-border,#3a3a5c)]',
                                )}
                              />
                              <div className="flex gap-1">
                                <button type="button" onClick={handleSaveEdit} data-testid="forge-template-edit-save" className="text-forge text-xs hover:underline">
                                  <Check size={12} className="inline" /> {t('forge.saveTemplate')}
                                </button>
                                <button type="button" onClick={() => setEditingTemplateId(null)} className="text-text-muted text-xs hover:underline">
                                  <X size={12} className="inline" /> {t('forge.cancelEdit')}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => setSelectedTemplate(tpl.name)}
                                className="flex-1 text-left"
                              >
                                <span className="font-medium">{tpl.name}</span>
                                {tpl.description && (
                                  <span className="block text-xs text-text-muted mt-0.5">{tpl.description}</span>
                                )}
                              </button>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  data-testid={`forge-template-edit-${tpl.id}`}
                                  onClick={(e) => { e.stopPropagation(); handleStartEdit(tpl); }}
                                  className="p-1 text-text-muted hover:text-text-primary transition-colors rounded hover:bg-surface-2"
                                  title={t('forge.editTemplate')}
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  type="button"
                                  data-testid={`forge-template-delete-${tpl.id}`}
                                  onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(tpl.id); }}
                                  className="p-1 text-text-muted hover:text-red-400 transition-colors rounded hover:bg-red-500/10"
                                  title={t('forge.deleteTemplate')}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </Tabs.Content>

                {/* AI tab */}
                <Tabs.Content value="ai">
                  <textarea
                    data-testid="forge-input-ai"
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canDiscover) {
                        e.preventDefault();
                        handleDiscover();
                      }
                    }}
                    placeholder={t('forge.aiPlaceholder')}
                    rows={4}
                    className={cn(
                      'w-full px-3 py-2 rounded-md text-sm resize-y',
                      'bg-[var(--vscode-input-background,#1e1e3a)]',
                      'text-[var(--vscode-input-foreground,#d4d4d4)]',
                      'border border-[var(--vscode-input-border,#3a3a5c)]',
                      'focus:outline-none focus:border-forge/50',
                    )}
                  />
                </Tabs.Content>
              </div>
            </Tabs.Root>
          </div>

          {/* Depth chips */}
          <div>
            <div className="text-[10px] text-text-muted uppercase tracking-widest mb-2">
              {t('forge.depth')}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {DEPTH_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  data-testid={`forge-depth-${d}`}
                  onClick={() => setDepth(d)}
                  title={t(DEPTH_TOOLTIP_KEYS[d])}
                  className={cn(
                    'px-4 py-1.5 rounded-full text-xs font-medium transition-all border',
                    depth === d
                      ? 'bg-forge/15 border-forge text-forge'
                      : 'bg-transparent border-subtle text-text-muted hover:border-forge/30 hover:text-text-secondary',
                  )}
                >
                  {t(DEPTH_KEYS[d])}
                </button>
              ))}
              {depth === 'custom' && (
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={customDepth}
                  onChange={(e) => setCustomDepth(Number(e.target.value))}
                  data-testid="forge-depth-custom-input"
                  className={cn(
                    'w-16 px-2 py-1.5 rounded-full text-xs text-center',
                    'bg-[var(--vscode-input-background,#1e1e3a)]',
                    'text-[var(--vscode-input-foreground,#d4d4d4)]',
                    'border border-[var(--vscode-input-border,#3a3a5c)]',
                  )}
                />
              )}
            </div>
          </div>

          {/* Option toggles */}
          <div className="flex gap-3">
            <label
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
                anonymize
                  ? 'border-forge bg-forge/10 text-forge'
                  : 'border-subtle bg-surface-1 text-text-muted hover:border-forge/30',
              )}
            >
              <input
                type="checkbox"
                checked={anonymize}
                onChange={(e) => setAnonymize(e.target.checked)}
                data-testid="forge-anonymize-toggle"
                className="sr-only"
              />
              <Lock size={14} />
              {t('forge.anonymizePII')}
            </label>
            <label
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs',
                skipEmpty
                  ? 'border-forge bg-forge/10 text-forge'
                  : 'border-subtle bg-surface-1 text-text-muted hover:border-forge/30',
              )}
            >
              <input
                type="checkbox"
                checked={skipEmpty}
                onChange={(e) => setSkipEmpty(e.target.checked)}
                data-testid="forge-skip-empty-toggle"
                className="sr-only"
              />
              <Ban size={14} />
              {t('forge.skipEmpty')}
            </label>
          </div>

          {/* CTA -- gradient Discover button */}
          <button
            type="button"
            data-testid="forge-discover-btn"
            disabled={!canDiscover}
            onClick={handleDiscover}
            className={cn(
              'w-full py-3 rounded-lg text-white font-bold text-sm tracking-wide',
              'bg-gradient-to-br from-forge to-[#ea580c]',
              'hover:shadow-lg hover:shadow-forge/20',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none',
              'transition-all flex items-center justify-center gap-2',
            )}
          >
            <Flame size={16} />
            {t('forge.discoverGraph')}
          </button>
          {/* UX-05: Disabled CTA hint */}
          {!canDiscover && (
            <p className="text-[10px] text-text-muted text-center mt-1" data-testid="forge-discover-hint">
              {!sourceOrgId
                ? t('forge.hintNoSource')
                : !targetOrgId
                  ? t('forge.hintNoTarget')
                  : sameOrgSelected
                    ? t('forge.hintSameOrg')
                    : t('forge.hintNoInput')}
            </p>
          )}
        </div>

        {/* ---- RIGHT: Live Preview panel ---- */}
        <div className="flex flex-col gap-3 p-4 rounded-lg bg-surface-2 border border-subtle">
          <div className="text-[10px] text-text-muted uppercase tracking-widest">
            {t('forge.livePreview')}
          </div>

          {/* Record preview card or placeholder */}
          {preview ? (
            <div
              className="rounded-lg border border-subtle bg-surface-1 p-3"
              data-testid="forge-record-preview"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-forge/20 text-forge">
                  {preview.objectLabel}
                </span>
                <span className="text-[10px] font-mono text-text-muted">
                  {preview.recordId.slice(0, 5)}...{preview.recordId.slice(-4)}
                </span>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="ml-auto text-text-muted hover:text-text-primary transition-colors"
                  aria-label={t('forge.closePreview', 'Close preview')}
                >
                  <X size={12} />
                </button>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                {preview.fields.map((f) => (
                  <React.Fragment key={f.name}>
                    <span className="text-text-muted">{f.name}</span>
                    <span className="text-text-primary font-mono truncate flex items-center gap-1">
                      {isPiiField(f.name) && (
                        <span className="shrink-0 text-[9px] px-1 py-px rounded bg-red-500/20 text-red-400 font-sans">
                          PII
                        </span>
                      )}
                      {f.value}
                    </span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-subtle p-6 text-center">
              <Search size={20} className="mx-auto mb-2 text-text-muted/50" />
              <p className="text-xs text-text-muted">
                {inputMode === 'record'
                  ? (sourceOrgId ? t('forge.recordIdPlaceholder') : t('forge.noOrgSelected'))
                  : inputMode === 'soql'
                    ? t('forge.soqlPreviewHint')
                    : inputMode === 'template'
                      ? t('forge.templatePreviewHint')
                      : t('forge.aiPreviewHint')}
              </p>
            </div>
          )}

          {/* Estimated graph stats */}
          <div className="rounded-lg border border-subtle bg-surface-1 p-3">
            <div className="text-[10px] text-text-muted mb-2">
              {t('forge.estimatedGraph')}
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div>
                <div className="text-lg font-bold text-forge" data-testid="est-objects">{preview ? '1' : '\u2014'}</div>
                <div className="text-[9px] text-text-muted">{t('forge.objects')}</div>
              </div>
              <div>
                <div className="text-lg font-bold text-forge" data-testid="est-fields">{preview ? String(preview.fields?.length ?? 0) : '\u2014'}</div>
                <div className="text-[9px] text-text-muted">{t('forge.fields')}</div>
              </div>
              <div>
                <div className="text-lg font-bold text-green-500">{'\u2014'}</div>
                <div className="text-[9px] text-text-muted">{t('forge.estSize')}</div>
              </div>
              <div>
                <div className="text-lg font-bold text-yellow-500">{'\u2014'}</div>
                <div className="text-[9px] text-text-muted">{t('forge.estDuration')}</div>
              </div>
            </div>
          </div>

          {/* PII warning banner */}
          {piiFieldCount > 0 && !anonymize && (
            <div
              className="rounded-md border border-red-500/30 bg-red-500/10 p-2.5 flex items-center gap-2"
              data-testid="forge-pii-warning"
            >
              <AlertTriangle size={16} className="text-red-400 shrink-0" />
              <div>
                <div className="text-[11px] text-red-400 font-medium">
                  {t('forge.piiWarning', { count: piiFieldCount })}
                </div>
                <div className="text-[10px] text-text-muted">
                  {t('forge.piiWarningHint')}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete template confirmation dialog */}
      <DangerConfirm
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        onConfirm={handleDeleteTemplate}
        title={t('forge.deleteTemplate')}
        description={t('forge.deleteTemplateConfirm')}
        confirmText={t('forge.deleteTemplate')}
      />
    </div>
  );
};

/* ========================================================================
   Sub-components
   ======================================================================== */

/** Props for the org selection card. */
interface OrgCardProps {
  /** i18n key for the card label (e.g. "forge.sourceOrg"). */
  labelKey: string;
  /** Currently selected org, or undefined if none selected. */
  org: SalesforceOrg | undefined;
  /** ID of the currently selected org. */
  orgId: string;
  /** Callback when the user selects a different org. */
  onOrgChange: (id: string) => void;
  /** All available orgs for the dropdown. */
  orgs: SalesforceOrg[];
  /** data-testid for the select element. */
  testId: string;
}

/** Org selection card with custom dropdown, alias, and username. */
function OrgCard({ labelKey, org, orgId, onOrgChange, orgs, testId }: OrgCardProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-all',
        org ? 'border-subtle bg-surface-1' : 'border-dashed border-subtle bg-surface-1/50',
      )}
    >
      <div className="text-[10px] text-text-muted uppercase tracking-widest mb-1.5">
        {t(labelKey)}
      </div>
      <OrgDropdown
        value={orgId}
        onChange={onOrgChange}
        orgs={orgs}
        ariaLabel={t(labelKey)}
        testId={testId}
      />
      {org && (
        <div className="text-[10px] text-text-muted mt-1 truncate">{org.username}</div>
      )}
    </div>
  );
}
