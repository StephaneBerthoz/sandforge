import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg, OrgSafetyTier } from '@sandforge/shared';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';

/** OrgEditPayload — fields that can be edited. */
export interface OrgEditPayload {
  alias: string;
  safetyTier: OrgSafetyTier;
  color: string;
  tags: string[];
}

/** OrgEditDialog component props. */
export interface OrgEditDialogProps {
  org: SalesforceOrg | null;
  open: boolean;
  onClose: () => void;
  onSave: (orgId: string, payload: OrgEditPayload) => void;
}

/** Dialog for editing an existing org's metadata. */
export const OrgEditDialog: React.FC<OrgEditDialogProps> = ({ org, open, onClose, onSave }) => {
  const { t } = useTranslation();

  const tierOptions = [
    { value: 'critical', label: t('org.tier_critical_desc') },
    { value: 'high', label: t('org.tier_high_desc') },
    { value: 'medium', label: t('org.tier_medium_desc') },
    { value: 'low', label: t('org.tier_low_desc') },
  ];

  const colorOptions = [
    { value: '#EF4444', label: t('org.color_red') },
    { value: '#F59E0B', label: t('org.color_amber') },
    { value: '#10B981', label: t('org.color_green') },
    { value: '#3B82F6', label: t('org.color_blue') },
    { value: '#8B5CF6', label: t('org.color_purple') },
    { value: '#F97316', label: t('org.color_orange') },
  ];
  const [alias, setAlias] = useState('');
  const [safetyTier, setSafetyTier] = useState<OrgSafetyTier>('low' as OrgSafetyTier);
  const [color, setColor] = useState('#3B82F6');
  const [tagsStr, setTagsStr] = useState('');

  useEffect(() => {
    if (org) {
      setAlias(org.alias);
      setSafetyTier(org.safetyTier);
      setColor(org.appearance.color);
      setTagsStr(org.tags.join(', '));
    }
  }, [org]);

  const handleSave = useCallback(() => {
    if (!org || !alias.trim()) return;
    const tags = tagsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onSave(org.id, { alias: alias.trim(), safetyTier, color, tags });
  }, [org, alias, safetyTier, color, tagsStr, onSave]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('org.edit')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!alias.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label={t('org.alias')}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          data-testid="edit-alias-input"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--sf-text-primary)]">{t('org.username')}:</span>
          <span className="text-xs text-[var(--sf-text-secondary)]">{org?.username}</span>
        </div>
        <Select
          label={t('org.safetyTier')}
          options={tierOptions}
          value={safetyTier}
          onChange={(e) => setSafetyTier(e.target.value as OrgSafetyTier)}
        />
        <Select
          label={t('org.color')}
          options={colorOptions}
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
        <Input
          label={t('org.tags')}
          value={tagsStr}
          onChange={(e) => setTagsStr(e.target.value)}
          hint={t('org.tagsHint')}
          placeholder={t('org.tagsPlaceholder')}
          data-testid="edit-tags-input"
        />
      </div>
    </Dialog>
  );
};
