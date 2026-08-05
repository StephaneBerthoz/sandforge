import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plug, Download, Globe, Smartphone, Key, UserCircle, Loader2, X } from 'lucide-react';
import type { SalesforceOrg, OrgSafetyTier, AuthMethod } from '@sandforge/shared';
import { cn } from '../../theme';
import { useOrgStore } from '../../stores/useOrgStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { OrgCard } from './OrgCard';
import type { ConnectOrgPayload } from './OrgConnectDialog';
import { OrgEditDialog } from './OrgEditDialog';
import type { OrgEditPayload } from './OrgEditDialog';

/** Payload shape returned by org:list:response. */
interface OrgListPayload {
  orgs: SalesforceOrg[];
}

/** Payload shape returned by org:statusChanged. */
interface OrgStatusPayload {
  orgId: string;
  status: string;
}

/** Auth method card definition. */
interface AuthMethodCard {
  method: AuthMethod;
  icon: React.ReactNode;
  labelKey: string;
  descKey: string;
  needsForm: boolean;
}

/** Available auth methods shown in the banner. */
const AUTH_METHODS: AuthMethodCard[] = [
  {
    method: 'sfdx_import',
    icon: <Download className="w-4 h-4" />,
    labelKey: 'auth.sfdxImport',
    descKey: 'auth.sfdxImportDesc',
    needsForm: false,
  },
  {
    method: 'oauth_web',
    icon: <Globe className="w-4 h-4" />,
    labelKey: 'auth.oauthWeb',
    descKey: 'auth.oauthWebDesc',
    needsForm: true,
  },
  {
    method: 'usernamePassword',
    icon: <UserCircle className="w-4 h-4" />,
    labelKey: 'auth.usernamePassword',
    descKey: 'auth.usernamePasswordDesc',
    needsForm: true,
  },
  {
    method: 'jwt',
    icon: <Key className="w-4 h-4" />,
    labelKey: 'auth.jwt',
    descKey: 'auth.jwtDesc',
    needsForm: false,
  },
  {
    method: 'oauth_device',
    icon: <Smartphone className="w-4 h-4" />,
    labelKey: 'auth.oauthDevice',
    descKey: 'auth.oauthDeviceDesc',
    needsForm: false,
  },
];

/** OrgManager page — list, connect, edit, disconnect orgs. */
export const OrgManagerPage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const updateOrg = useOrgStore((s) => s.updateOrg);
  const removeOrg = useOrgStore((s) => s.removeOrg);

  const [activeMethod, setActiveMethod] = useState<AuthMethod | null>(null);
  const [editingOrg, setEditingOrg] = useState<SalesforceOrg | null>(null);

  // Inline form state
  const [alias, setAlias] = useState('');
  const [loginUrl, setLoginUrl] = useState('https://login.salesforce.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [securityToken, setSecurityToken] = useState('');

  const loginUrlOptions = [
    { value: 'https://login.salesforce.com', label: t('auth.loginProduction') },
    { value: 'https://test.salesforce.com', label: t('auth.loginSandbox') },
  ];

  // Fetch org list on mount via bridge
  const orgListQuery = useBridgeQuery<OrgListPayload>('org:list');

  useEffect(() => {
    if (orgListQuery.data) {
      useOrgStore.getState().setOrgs(orgListQuery.data.orgs);
    }
  }, [orgListQuery.data]);

  const connectMutation = useBridgeMutation<OrgStatusPayload>('org:connect', {
    responseType: 'org:statusChanged',
  });

  const disconnectMutation = useBridgeMutation<OrgStatusPayload>('org:disconnect', {
    responseType: 'org:statusChanged',
  });

  const isConnecting = connectMutation.loading;

  const connectMutate = connectMutation.mutate;
  const handleConnect = useCallback(
    (payload: ConnectOrgPayload) => {
      connectMutate({
        orgId: '',
        authMethod: payload.authMethod,
        alias: payload.alias,
        loginUrl: payload.loginUrl,
        username: payload.username,
        password: payload.password,
        securityToken: payload.securityToken,
      });
    },
    [connectMutate],
  );

  // Collapse inline form when connect mutation completes
  const prevConnecting = useRef(isConnecting);
  useEffect(() => {
    if (prevConnecting.current && !isConnecting) {
      setActiveMethod(null);
      resetForm();
    }
    prevConnecting.current = isConnecting;
  }, [isConnecting]);

  const resetForm = (): void => {
    setAlias('');
    setLoginUrl('https://login.salesforce.com');
    setUsername('');
    setPassword('');
    setSecurityToken('');
  };

  /** Handle clicking an auth method button. */
  const handleMethodClick = useCallback(
    (card: AuthMethodCard) => {
      if (card.method === activeMethod) {
        setActiveMethod(null);
        resetForm();
        return;
      }
      resetForm();

      // Methods that trigger immediately
      if (card.method === 'sfdx_import') {
        handleConnect({ alias: '', authMethod: 'sfdx_import', loginUrl: '' });
        return;
      }
      if (card.method === 'jwt' || card.method === 'oauth_device') {
        setActiveMethod(card.method);
        return;
      }

      setActiveMethod(card.method);
    },
    [activeMethod, handleConnect],
  );

  /** Submit the inline form. */
  const handleInlineSubmit = useCallback(() => {
    if (!activeMethod) return;
    handleConnect({
      alias: alias.trim(),
      authMethod: activeMethod,
      loginUrl,
      ...(activeMethod === 'usernamePassword'
        ? { username: username.trim(), password, securityToken: securityToken.trim() }
        : {}),
    });
  }, [activeMethod, alias, loginUrl, username, password, securityToken, handleConnect]);

  const canSubmit =
    activeMethod === 'oauth_web'
      ? alias.trim().length > 0
      : activeMethod === 'usernamePassword'
        ? alias.trim().length > 0 && username.trim().length > 0 && password.length > 0
        : false;

  const handleEdit = useCallback((org: SalesforceOrg) => {
    setEditingOrg(org);
  }, []);

  const handleSave = useCallback(
    (orgId: string, payload: OrgEditPayload) => {
      updateOrg(orgId, {
        alias: payload.alias,
        safetyTier: payload.safetyTier as OrgSafetyTier,
        appearance: { color: payload.color, icon: 'cloud', position: 0 },
        tags: payload.tags,
      });
      setEditingOrg(null);
    },
    [updateOrg],
  );

  const disconnectMutate = disconnectMutation.mutate;
  const handleDisconnect = useCallback(
    (orgId: string) => {
      disconnectMutate({ orgId });
      removeOrg(orgId);
    },
    [disconnectMutate, removeOrg],
  );

  return (
    <div className="flex flex-col gap-4" data-testid="org-manager-page">
      {/* Banner with integrated auth methods */}
      <div
        className="rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg-primary)] overflow-hidden"
        data-testid="org-connect-banner"
      >
        {/* Header row */}
        <div className="flex items-center gap-3 px-4 py-3">
          <Plug className="w-5 h-5 text-text-secondary shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">{t('org.title')}</h2>
            <p className="text-xs text-text-secondary mt-0.5">
              {orgs.length > 0
                ? t('org.bannerConnected', { count: connectedOrgs.length, total: orgs.length })
                : t('org.bannerEmpty')}
            </p>
          </div>
        </div>

        {/* Auth method buttons row */}
        <div className="flex items-center gap-2 px-4 pb-3 flex-wrap" data-testid="org-auth-methods">
          {AUTH_METHODS.map((card) => {
            const isActive = activeMethod === card.method;
            const isNotSupported = card.method === 'jwt' || card.method === 'oauth_device';
            return (
              <button
                key={card.method}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                  'border transition-all',
                  isActive
                    ? 'bg-[var(--sf-button-bg)] text-[var(--sf-button-fg)] border-[var(--sf-button-bg)]'
                    : 'bg-[var(--sf-button-secondary-bg)] text-[var(--sf-button-secondary-fg)] border-transparent hover:bg-[var(--sf-button-secondary-hover)]',
                  isNotSupported && 'opacity-50',
                  isConnecting && 'pointer-events-none opacity-60',
                )}
                onClick={() => handleMethodClick(card)}
                disabled={isConnecting}
                title={t(card.descKey)}
                data-testid={`org-auth-${card.method}`}
              >
                {card.method === 'sfdx_import' && isConnecting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  card.icon
                )}
                <span>{t(card.labelKey)}</span>
              </button>
            );
          })}
        </div>

        {/* Inline form — expands when a method with form is selected */}
        {activeMethod && (activeMethod === 'oauth_web' || activeMethod === 'usernamePassword') && (
          <div
            className="border-t border-[var(--sf-border)] bg-[var(--sf-bg-secondary)] px-4 py-3"
            data-testid="org-inline-form"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-text-primary">
                {t(AUTH_METHODS.find((m) => m.method === activeMethod)?.labelKey ?? '')}
              </span>
              <button
                className="text-text-secondary hover:text-text-primary transition-colors"
                onClick={() => {
                  setActiveMethod(null);
                  resetForm();
                }}
                data-testid="org-inline-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid gap-3 max-w-lg">
              <Select
                label={t('auth.loginUrl')}
                options={loginUrlOptions}
                value={loginUrl}
                onChange={(e) => setLoginUrl(e.target.value)}
              />

              <Input
                label={t('org.alias')}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder={t('org.aliasPlaceholder')}
                data-testid="inline-alias-input"
              />

              {activeMethod === 'usernamePassword' && (
                <>
                  <Input
                    label={t('auth.username')}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('auth.usernamePlaceholder')}
                    data-testid="inline-username-input"
                  />
                  <Input
                    label={t('auth.password')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    data-testid="inline-password-input"
                  />
                  <Input
                    label={t('auth.securityToken')}
                    value={securityToken}
                    onChange={(e) => setSecurityToken(e.target.value)}
                    placeholder={t('auth.securityTokenHint')}
                    data-testid="inline-token-input"
                  />
                </>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button
                  onClick={handleInlineSubmit}
                  loading={isConnecting}
                  disabled={!canSubmit}
                  data-testid="org-inline-connect"
                >
                  {activeMethod === 'oauth_web' ? t('auth.openBrowser') : t('org.connect')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setActiveMethod(null);
                    resetForm();
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Not supported message for JWT / Device */}
        {activeMethod && (activeMethod === 'jwt' || activeMethod === 'oauth_device') && (
          <div
            className="border-t border-[var(--sf-border)] bg-[var(--sf-bg-secondary)] px-4 py-3"
            data-testid="org-inline-not-supported"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs text-text-secondary">{t('auth.notSupported')}</p>
              <button
                className="text-text-secondary hover:text-text-primary transition-colors"
                onClick={() => setActiveMethod(null)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {orgListQuery.error && (
        <div className="text-[var(--sf-error)]" data-testid="org-list-error">
          {orgListQuery.error}
        </div>
      )}

      {orgs.length === 0 && !orgListQuery.loading ? (
        <EmptyState title={t('org.noOrgs')} description={t('org.bannerEmpty')} />
      ) : (
        <div className="grid gap-3">
          {orgs.map((org) => (
            <OrgCard
              key={org.id}
              org={org}
              selected={org.id === selectedOrgId}
              onSelect={selectOrg}
              onEdit={handleEdit}
              onDisconnect={handleDisconnect}
            />
          ))}
        </div>
      )}

      <OrgEditDialog
        org={editingOrg}
        open={editingOrg !== null}
        onClose={() => setEditingOrg(null)}
        onSave={handleSave}
      />
    </div>
  );
};
