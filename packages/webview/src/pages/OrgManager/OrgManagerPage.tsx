import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plug, Download, Globe, Smartphone, Key, UserCircle, Loader2, X } from 'lucide-react';
import type { SalesforceOrg, OrgSafetyTier, AuthMethod } from '@sandforge/shared';
import { cn } from '../../theme';
import { useOrgStore } from '../../stores/useOrgStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { EmptyState } from '../../components/ui/EmptyState';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
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

/**
 * Above this many orgs the list gets a filter box. Below it every card is
 * on screen at once and a search field would only add noise.
 */
const SEARCH_THRESHOLD = 5;

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
  // Selection propagates: local store for this panel + `org:select` through
  // the broker so the extension updates the status bar and broadcasts
  // `org:selected` to the sidebar and every other panel.
  const selectOrgLocal = useOrgStore((s) => s.selectOrg);
  const selectOrg = useCallback(
    (id: string | null) => {
      selectOrgLocal(id);
      if (id) sendBridgeMessage('org:select', { orgId: id });
    },
    [selectOrgLocal],
  );
  const updateOrg = useOrgStore((s) => s.updateOrg);
  const removeOrg = useOrgStore((s) => s.removeOrg);

  const [activeMethod, setActiveMethod] = useState<AuthMethod | null>(null);
  const [search, setSearch] = useState('');
  const [editingOrg, setEditingOrg] = useState<SalesforceOrg | null>(null);
  const [orgPendingDisconnect, setOrgPendingDisconnect] = useState<SalesforceOrg | null>(null);

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
    // `oauth_web` shells out to `sf org login web`, which SfdxBridge allows
    // 120 s for the browser round trip. The 30 s default expired while the
    // user was still logging in: the form collapsed mid-login and the typed
    // credentials were wiped.
    timeoutMs: 180_000,
  });

  const disconnectMutation = useBridgeMutation<OrgStatusPayload>('org:disconnect', {
    responseType: 'org:statusChanged',
  });

  const isConnecting = connectMutation.loading;
  const connectError = connectMutation.error;

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

  // Collapse inline form when the connect mutation completes *successfully*.
  // On failure the form used to close silently: the typed credentials were
  // wiped and the user was left believing the org had been added. Keep the
  // form and its input open so the error can be read and the attempt retried.
  const prevConnecting = useRef(isConnecting);
  useEffect(() => {
    if (prevConnecting.current && !isConnecting && !connectError) {
      setActiveMethod(null);
      resetForm();
    }
    prevConnecting.current = isConnecting;
  }, [isConnecting, connectError]);

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

  // Disconnect drops the registry entry host-side, so the alias, tags, colour
  // and safety tier typed here are gone for good — a re-connect starts from
  // defaults. Too destructive for a bare click, hence the typed confirmation.
  const handleDisconnect = useCallback(
    (orgId: string) => {
      setOrgPendingDisconnect(orgs.find((o) => o.id === orgId) ?? null);
    },
    [orgs],
  );

  const confirmDisconnect = useCallback(() => {
    if (!orgPendingDisconnect) return;
    disconnectMutate({ orgId: orgPendingDisconnect.id });
    removeOrg(orgPendingDisconnect.id);
    setOrgPendingDisconnect(null);
  }, [orgPendingDisconnect, disconnectMutate, removeOrg]);

  // Filtering only appears once the list stops fitting on screen. The query is
  // ignored while the field is hidden, so disconnecting down to a short list
  // can never leave cards filtered out by a box the user can no longer see.
  const showSearch = orgs.length > SEARCH_THRESHOLD;
  const searchTerm = showSearch ? search.trim().toLowerCase() : '';
  const visibleOrgs = searchTerm
    ? orgs.filter((o) =>
        [o.alias, o.username, o.instanceUrl, o.orgType, o.tags.join(' ')].some((field) =>
          field.toLowerCase().includes(searchTerm),
        ),
      )
    : orgs;

  // Fetching the registry, or importing from the CLI, used to paint nothing at
  // all: `orgs` is still empty, so the grid rendered zero cards and the empty
  // state was suppressed. A first-time user saw a blank panel and no way to
  // tell the import from a dead extension.
  const isLoadingOrgs = (orgListQuery.loading || isConnecting) && orgs.length === 0;

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
            <h1 className="text-sm font-semibold text-text-primary">{t('org.title')}</h1>
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

        {/* Connect failure — surfaced in the banner so it is visible for the
            form-less methods (sfdx_import) too. `mutate` clears it on retry. */}
        {connectError && (
          <div
            className="border-t border-[var(--sf-border)] bg-[var(--sf-bg-secondary)] px-4 py-2 text-xs text-[var(--sf-error)]"
            role="alert"
            data-testid="org-connect-error"
          >
            <span className="font-semibold">{t('org.status_error')}</span> — {connectError}
          </div>
        )}

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

      {isLoadingOrgs ? (
        <div
          className="flex items-center justify-center gap-2 py-12 text-xs text-text-secondary"
          role="status"
          aria-live="polite"
          data-testid="org-list-loading"
        >
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          <span>{t('common.loading')}</span>
        </div>
      ) : orgs.length === 0 ? (
        // The empty state repeated the instruction "import from Salesforce CLI"
        // without offering it: the button lived in the banner, one of five.
        <EmptyState
          title={t('org.noOrgs')}
          description={t('org.bannerEmpty')}
          actionLabel={t('auth.sfdxImport')}
          onAction={() => handleConnect({ alias: '', authMethod: 'sfdx_import', loginUrl: '' })}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {showSearch && (
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
              data-testid="org-search-input"
            />
          )}

          {visibleOrgs.length === 0 ? (
            <p
              className="py-8 text-center text-xs text-text-secondary"
              data-testid="org-search-empty"
            >
              {t('common.noData')}
            </p>
          ) : (
            <div className="grid gap-3">
              {visibleOrgs.map((org) => (
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
        </div>
      )}

      <OrgEditDialog
        org={editingOrg}
        open={editingOrg !== null}
        onClose={() => setEditingOrg(null)}
        onSave={handleSave}
      />

      <DangerConfirm
        open={orgPendingDisconnect !== null}
        onClose={() => setOrgPendingDisconnect(null)}
        onConfirm={confirmDisconnect}
        title={t('org.disconnect')}
        description={t('org.disconnectConfirm', {
          alias: orgPendingDisconnect?.alias || orgPendingDisconnect?.username || '',
        })}
        confirmText={t('org.disconnect')}
      />
    </div>
  );
};
