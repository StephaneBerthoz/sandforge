import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { registeredOrgType } from '@sandforge/shared';
import { Dialog } from '../../components/ui/Dialog';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';

/**
 * OrgEditPayload — fields that can be edited. The safety tier is not one of
 * them: the production guard decides from the org type, so a tier picked here
 * would change nothing it checks. What it does read of a sandbox is whether
 * it is marked Staging: a full copy or UAT holding real data, where it asks
 * before every delete.
 */
export interface OrgEditPayload {
  alias: string;
  color: string;
  tags: string[];
  /** A sandbox's alone: marked Staging. */
  staging?: boolean;
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

  const colorOptions = [
    { value: '#EF4444', label: t('org.color_red') },
    { value: '#F59E0B', label: t('org.color_amber') },
    { value: '#10B981', label: t('org.color_green') },
    { value: '#3B82F6', label: t('org.color_blue') },
    { value: '#8B5CF6', label: t('org.color_purple') },
    { value: '#F97316', label: t('org.color_orange') },
  ];
  const [alias, setAlias] = useState('');
  const [color, setColor] = useState('#3B82F6');
  const [tagsStr, setTagsStr] = useState('');
  const [staging, setStaging] = useState(false);
  // Read as every guard reads it: a scratch org, a Developer Edition org and a
  // production org are told apart by Salesforce, a staging sandbox is not.
  const isSandbox =
    org !== null && registeredOrgType(org.orgType, org.metadata?.edition) === 'Sandbox';

  useEffect(() => {
    if (org) {
      setAlias(org.alias);
      setColor(org.appearance.color);
      setTagsStr(org.tags.join(', '));
      setStaging(org.staging === true);
    }
  }, [org]);

  const handleSave = useCallback(() => {
    if (!org || !alias.trim()) return;
    const tags = tagsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onSave(org.id, { alias: alias.trim(), color, tags, ...(isSandbox ? { staging } : {}) });
  }, [org, alias, color, tagsStr, staging, isSandbox, onSave]);

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
          <span className="text-xs text-(--sf-text-primary)">{t('org.username')}:</span>
          <span className="text-xs text-(--sf-text-secondary)">{org?.username}</span>
        </div>
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
        {isSandbox && (
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-xs text-(--sf-text-primary)">
              <input
                type="checkbox"
                checked={staging}
                onChange={(e) => setStaging(e.target.checked)}
                aria-describedby="edit-staging-hint"
                data-testid="edit-staging-input"
              />
              {t('org.staging')}
            </label>
            <p id="edit-staging-hint" className="text-[11px] text-(--sf-text-secondary)">
              {t('org.stagingHint')}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
};
