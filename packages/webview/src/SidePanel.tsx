import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { syncLanguageFromSettings } from './i18n';
import {
  Flame,
  Activity,
  Bot,
  ExternalLink,
  CheckCircle,
  XCircle,
  Loader,
  Shield,
  Zap,
  Plug,
  Settings,
  HelpCircle,
  GitCompare,
  ChevronDown,
  Star,
  ArrowRight,
  Snowflake,
  Sprout,
  RefreshCw,
  Grape,
  Globe,
  Rocket,
  FileUp,
} from 'lucide-react';
import { cn } from './theme';
import { ORG_TYPE_STYLES, ORG_TYPE_STYLE_DEFAULT } from './theme/orgStyles';
import { orgTypeLabel } from './utils/orgFormatters';
import { formatRelativeTimeI18n } from './utils/formatters';
import { useVSCodeApi } from './hooks/useVSCodeApi';
import { useRecentOpsFeed } from './hooks/useRecentOpsFeed';
import { useRecentOpsStore } from './stores/useRecentOpsStore';
import type { RecentOp } from './stores/useRecentOpsStore';
import { useOrgStore } from './stores/useOrgStore';
import { useFavoritesStore } from './stores/useFavoritesStore';
import type { SalesforceOrg } from '@sandforge/shared';

/** Status icon component for a recent operation. */
const StatusIcon: React.FC<{ status: RecentOp['status'] }> = ({ status }) => {
  switch (status) {
    case 'success':
      return <CheckCircle className="w-3.5 h-3.5 text-green-400" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    case 'running':
      return <Loader className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
  }
};

/** Navigation item definition for the sidebar. */
interface NavItem {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
  accent?: string;
}

/** Module navigation items. */
const MODULE_ITEMS: NavItem[] = [
  {
    id: 'monitor',
    labelKey: 'nav.monitor',
    icon: <Activity className="w-4 h-4" />,
    accent: 'text-blue-400',
  },
  {
    id: 'seed',
    labelKey: 'nav.seed',
    icon: <Sprout className="w-4 h-4" />,
    accent: 'text-green-400',
  },
  {
    id: 'sync',
    labelKey: 'nav.sync',
    icon: <RefreshCw className="w-4 h-4" />,
    accent: 'text-sky-400',
  },
  {
    id: 'grappe',
    labelKey: 'nav.grappe',
    icon: <Grape className="w-4 h-4" />,
    accent: 'text-indigo-400',
  },
  {
    id: 'autopilot',
    labelKey: 'nav.autopilot',
    icon: <Rocket className="w-4 h-4" />,
    accent: 'text-rose-400',
  },
  {
    id: 'frozen',
    labelKey: 'nav.frozen',
    icon: <Snowflake className="w-4 h-4" />,
    accent: 'text-cyan-400',
  },
  {
    id: 'compare',
    labelKey: 'nav.compare',
    icon: <GitCompare className="w-4 h-4" />,
    accent: 'text-purple-400',
  },
  {
    id: 'dataops',
    labelKey: 'nav.dataops',
    icon: <Shield className="w-4 h-4" />,
    accent: 'text-yellow-400',
  },
  {
    id: 'automation',
    labelKey: 'nav.automation',
    icon: <Zap className="w-4 h-4" />,
    accent: 'text-amber-400',
  },
  {
    id: 'migration',
    labelKey: 'nav.migration',
    icon: <FileUp className="w-4 h-4" />,
    accent: 'text-teal-400',
  },
  {
    id: 'ai',
    labelKey: 'nav.ai',
    icon: <Bot className="w-4 h-4" />,
    accent: 'text-fuchsia-400',
  },
];

/** Tool navigation items. */
const TOOL_ITEMS: NavItem[] = [
  { id: 'orgs', labelKey: 'nav.orgs', icon: <Plug className="w-4 h-4" /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings className="w-4 h-4" /> },
  { id: 'help', labelKey: 'nav.help', icon: <HelpCircle className="w-4 h-4" /> },
];

/**
 * Premium sidebar navigation for the VSCode side panel.
 * Features:
 * - SandForge branding with flame icon
 * - Full module navigation with accent colors and favorites
 * - Org switcher with live connection indicator
 * - Quick metrics (connected orgs / recent ops count)
 * - Running/last operation status
 * - "Open Full UI" button
 */
export const SidePanel: React.FC = () => {
  const { t } = useTranslation();
  const vscodeApi = useVSCodeApi();
  // Feed the recent-ops store from operation lifecycle messages so the
  // Running/Last operation blocks below have real data.
  useRecentOpsFeed();
  const ops = useRecentOpsStore((s) => s.ops);
  const lastOp = ops[0] as RecentOp | undefined;
  const runningOp = ops.find((op) => op.status === 'running');

  // Org store
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const connectedOrgs = orgs.filter((o) => o.status === 'connected');
  const selectedOrg = orgs.find((o) => o.id === selectedOrgId);
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);

  /** Sorted orgs: connected first, then alphabetical by alias/username within each group. */
  const sortedOrgs = useMemo(() => {
    return [...orgs].sort((a, b) => {
      const aConn = a.status === 'connected' ? 0 : 1;
      const bConn = b.status === 'connected' ? 0 : 1;
      if (aConn !== bConn) return aConn - bConn;
      const aName = (a.alias || a.username).toLowerCase();
      const bName = (b.alias || b.username).toLowerCase();
      return aName.localeCompare(bName);
    });
  }, [orgs]);

  // Compact mode for short viewports
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const checkHeight = (): void => {
      setIsCompact(window.innerHeight < 650);
    };
    checkHeight();
    window.addEventListener('resize', checkHeight);
    return () => window.removeEventListener('resize', checkHeight);
  }, []);

  // Collapsible Quick Metrics
  const [metricsExpanded, setMetricsExpanded] = useState(true);

  useEffect(() => {
    if (isCompact) setMetricsExpanded(false);
  }, [isCompact]);

  // Favorites store
  const favorites = useFavoritesStore((s) => s.favorites);
  const toggleFavorite = useFavoritesStore((s) => s.toggle);

  // Request orgs on mount and listen for updates from the extension
  useEffect(() => {
    vscodeApi.postMessage({ type: 'sidebar:requestOrgs' });
    // Ask for the settings blob so the sidebar adopts the configured language
    // (its own webview state is per-document and starts empty). Later
    // `settings:response` broadcasts — posted to every registered webview when
    // another panel saves settings — keep the sidebar language in sync live.
    vscodeApi.postMessage({ type: 'sidebar:requestSettings' });

    const handleMessage = (event: MessageEvent): void => {
      // SECURITY: Validate origin — only accept messages from the VSCode webview host.
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      const msg = event.data as {
        type?: string;
        payload?: { orgs?: SalesforceOrg[]; settings?: unknown; orgId?: string };
      };
      if (msg.type === 'org:list:response' && msg.payload?.orgs) {
        useOrgStore.getState().setOrgs(msg.payload.orgs);
        // The payload also carries the extension-side selection — adopt it
        // when this document has none (the view is recreated on hide/show).
        const selected = (msg.payload as { selectedOrgId?: string | null }).selectedOrgId;
        if (selected != null && useOrgStore.getState().selectedOrgId === null) {
          useOrgStore.getState().selectOrg(selected);
        }
      }
      // Selection made elsewhere (another panel, extension command) — the
      // sidebar adopts it so every surface shows the same org.
      if (msg.type === 'org:selected' && msg.payload?.orgId) {
        useOrgStore.getState().selectOrg(msg.payload.orgId);
      }
      if (msg.type === 'settings:response') {
        syncLanguageFromSettings(msg.payload?.settings);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [vscodeApi]);

  /** Send navigation message to extension host via vscode API. */
  const navigate = (route: string): void => {
    vscodeApi.postMessage({ type: 'sidebar:navigate', payload: { route } });
  };

  /** Open the full editor panel. */
  const openFull = (): void => {
    vscodeApi.postMessage({ type: 'sidebar:openFull' });
  };

  // Metrics: connected orgs and recent ops
  const connectedCount = connectedOrgs.length;
  const recentOpsCount = ops.length;

  return (
    <div
      className={cn(
        'h-screen w-full flex flex-col overflow-auto',
        'bg-surface-0 text-text-primary',
      )}
      data-testid="sidepanel-root"
    >
      {/* Branding */}
      <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-subtle">
        <div className="relative">
          <Flame className="w-5 h-5 text-orange-400" />
          <div className="absolute -inset-1 bg-orange-400/10 rounded-full blur-sm -z-10" />
        </div>
        <span className="text-sm font-bold tracking-tight">SandForge</span>
      </div>

      {/* Org Switcher */}
      <div className="px-3 pt-3 relative">
        <button
          className={cn(
            'w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5',
            'bg-surface-1 border border-subtle',
            'hover:bg-surface-2 hover:border-active transition-all text-left',
            'group',
          )}
          onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
          data-testid="sidepanel-org"
        >
          <span
            className={cn(
              'h-2.5 w-2.5 rounded-full shrink-0 ring-2',
              selectedOrg?.status === 'connected'
                ? 'bg-green-500 ring-green-500/20 shadow-[0_0_6px_rgba(34,197,94,0.4)]'
                : selectedOrg?.status === 'refreshing'
                  ? 'bg-yellow-500 ring-yellow-500/20'
                  : selectedOrg
                    ? 'bg-red-500 ring-red-500/20'
                    : 'bg-gray-500 ring-gray-500/20',
            )}
          />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold truncate block">
              {selectedOrg
                ? selectedOrg.alias || selectedOrg.username
                : connectedCount > 0
                  ? t('sidePanel.selectOrg', 'Select an org')
                  : t('sidePanel.noOrg', 'No org connected')}
            </span>
          </div>
          {selectedOrg && (
            <span
              className={cn(
                'text-[9px] font-bold px-1.5 py-0.5 rounded-md border shrink-0 uppercase',
                ORG_TYPE_STYLES[selectedOrg.orgType] ?? ORG_TYPE_STYLE_DEFAULT,
              )}
            >
              {orgTypeLabel(selectedOrg, t)}
            </span>
          )}
          <ChevronDown
            className={cn(
              'w-3.5 h-3.5 text-text-muted transition-transform duration-200',
              orgDropdownOpen && 'rotate-180',
            )}
          />
        </button>

        {/* Org dropdown */}
        {orgDropdownOpen && (
          <div
            className="absolute left-3 right-3 top-full mt-1 z-50 rounded-lg bg-surface-1 border border-subtle shadow-lg overflow-hidden"
            data-testid="sidepanel-org-dropdown"
          >
            {orgs.length > 0 ? (
              <div className="max-h-[240px] overflow-y-auto">
                {sortedOrgs.map((org) => {
                  const isOrgConnected = org.status === 'connected';
                  return (
                    <div
                      key={org.id}
                      className={cn(
                        'flex items-center',
                        org.id === selectedOrgId && 'bg-surface-2',
                      )}
                    >
                      <button
                        className={cn(
                          'flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left text-xs',
                          'hover:bg-surface-2 transition-colors',
                        )}
                        onClick={() => {
                          selectOrg(org.id);
                          setOrgDropdownOpen(false);
                          vscodeApi.postMessage({
                            type: 'sidebar:selectOrg',
                            payload: { orgId: org.id },
                          });
                        }}
                        data-testid={`sidepanel-org-option-${org.id}`}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full shrink-0',
                            isOrgConnected ? 'bg-green-500' : 'bg-gray-500',
                          )}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{org.alias || org.username}</div>
                          <div className="text-[10px] text-text-muted truncate">{org.username}</div>
                        </div>
                        <span
                          className={cn(
                            'text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0',
                            ORG_TYPE_STYLES[org.orgType] ?? ORG_TYPE_STYLE_DEFAULT,
                          )}
                        >
                          {orgTypeLabel(org, t)}
                        </span>
                      </button>
                      {/* Survivor of the removed native Organizations tree: open the org in a browser. */}
                      <button
                        type="button"
                        className={cn(
                          'p-1.5 mr-2 rounded-md shrink-0',
                          'text-text-muted hover:text-text-primary hover:bg-surface-3',
                          'transition-colors',
                        )}
                        title={t('sidePanel.openInBrowser', 'Open in browser')}
                        aria-label={t('sidePanel.openInBrowser', 'Open in browser')}
                        onClick={() => {
                          vscodeApi.postMessage({
                            type: 'sidebar:openOrgInBrowser',
                            payload: { orgId: org.id },
                          });
                        }}
                        data-testid={`sidepanel-org-open-${org.id}`}
                      >
                        <Globe className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-3 text-xs text-text-muted text-center">
                {t('sidePanel.noOrgHint', 'No org yet — connect one below')}
              </div>
            )}
            <button
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 text-left text-xs',
                'text-orange-400 hover:bg-surface-2 border-t border-subtle',
                'font-medium',
              )}
              onClick={() => {
                setOrgDropdownOpen(false);
                navigate('orgs');
              }}
              data-testid="sidepanel-org-new"
            >
              <Plug className="w-3.5 h-3.5" />
              {t('sidePanel.newOrg', 'New organization...')}
            </button>
          </div>
        )}
      </div>

      {/* Quick Metrics */}
      <div className="px-3 pt-2.5">
        <button
          className="w-full flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted px-1 mb-1"
          onClick={() => setMetricsExpanded(!metricsExpanded)}
          aria-label={metricsExpanded ? t('sidePanel.hideMetrics') : t('sidePanel.showMetrics')}
          data-testid="sidepanel-metrics-toggle"
        >
          <ChevronDown
            className={cn(
              'w-3 h-3 transition-transform duration-200',
              !metricsExpanded && '-rotate-90',
            )}
          />
          {t('sidePanel.connectedOrgs', 'Orgs')} / {t('sidePanel.recentOps', 'Ops')}
        </button>
        {metricsExpanded && (
          <div className="grid grid-cols-2 gap-2" data-testid="sidepanel-metrics">
            <div className="rounded-lg bg-surface-1 border border-subtle px-2.5 py-2 text-center">
              <div className="text-[10px] text-text-muted uppercase tracking-wide">
                {t('sidePanel.connectedOrgs', 'Orgs')}
              </div>
              <div className="text-lg font-bold tabular-nums">{connectedCount}</div>
            </div>
            <div className="rounded-lg bg-surface-1 border border-subtle px-2.5 py-2 text-center">
              <div className="text-[10px] text-text-muted uppercase tracking-wide">
                {t('sidePanel.recentOps', 'Ops')}
              </div>
              <div className="text-lg font-bold tabular-nums">{recentOpsCount}</div>
            </div>
          </div>
        )}
      </div>

      {/* Forge Hero */}
      {!isCompact && (
        <div className="px-3 pt-3">
          <button
            className={cn(
              'w-full flex items-center gap-3 rounded-xl px-3.5 py-3 group',
              'bg-gradient-to-r from-orange-500/10 via-amber-500/8 to-orange-500/5',
              'border border-orange-500/20',
              'hover:from-orange-500/20 hover:via-amber-500/15 hover:to-orange-500/10',
              'hover:border-orange-500/40 hover:shadow-[0_0_16px_rgba(249,115,22,0.12)]',
              'transition-all duration-200',
            )}
            onClick={() => navigate('forge')}
            data-testid="sidepanel-forge"
          >
            <div className="relative shrink-0">
              <div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center">
                <Flame className="w-5 h-5 text-orange-400" />
              </div>
              <div className="absolute -inset-0.5 bg-orange-400/10 rounded-lg blur-sm -z-10 group-hover:bg-orange-400/20 transition-colors" />
            </div>
            <div className="text-left flex-1 min-w-0">
              <div className="text-sm font-bold text-orange-400">{t('sidePanel.forge')}</div>
              <div className="text-[10px] text-text-muted leading-tight">
                {t('sidePanel.forgeDesc', 'Seed, sync & transform data')}
              </div>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-orange-400/40 group-hover:text-orange-400/80 group-hover:translate-x-0.5 transition-all shrink-0" />
          </button>
        </div>
      )}
      {isCompact && (
        <div className="px-3 pt-2">
          <button
            className={cn(
              'w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5',
              'bg-orange-500/10 border border-orange-500/20',
              'hover:bg-orange-500/20 transition-all text-left',
            )}
            onClick={() => navigate('forge')}
            data-testid="sidepanel-forge-compact"
          >
            <Flame className="w-4 h-4 text-orange-400 shrink-0" />
            <span className="text-xs font-bold text-orange-400">{t('sidePanel.forge')}</span>
            <ArrowRight className="w-3 h-3 text-orange-400/40 ml-auto shrink-0" />
          </button>
        </div>
      )}

      {/* Favorite Modules (if any) */}
      {favorites.length > 0 && (
        <div className="px-3 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-1 mb-1.5">
            {t('sidePanel.favorites', 'Favorites')}
          </div>
          <nav
            className="flex flex-col gap-0.5"
            aria-label={t('sidePanel.favorites', 'Favorites')}
            data-testid="sidepanel-favorites"
          >
            {MODULE_ITEMS.filter((item) => favorites.includes(item.id)).map((item) => (
              <button
                key={item.id}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left w-full',
                  'text-text-secondary hover:text-text-primary hover:bg-surface-1',
                  'transition-colors',
                )}
                onClick={() => navigate(item.id)}
                data-testid={`sidepanel-fav-${item.id}`}
              >
                <span className={cn('shrink-0', item.accent)}>{item.icon}</span>
                <span className="text-xs font-medium">{t(item.labelKey)}</span>
              </button>
            ))}
          </nav>
        </div>
      )}

      {/* Module Navigation */}
      <div className="px-3 pt-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1 mb-2">
          {t('sidePanel.modules', 'Modules')}
        </div>
        <nav
          className="flex flex-col gap-0.5"
          aria-label={t('sidePanel.modules', 'Modules')}
          data-testid="sidepanel-modules"
        >
          {MODULE_ITEMS.map((item) => (
            <div key={item.id} className="flex items-center group">
              <button
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left flex-1',
                  'text-text-secondary hover:text-text-primary',
                  'hover:bg-surface-1 hover:shadow-sm',
                  'transition-all duration-150',
                )}
                onClick={() => navigate(item.id)}
                data-testid={`sidepanel-nav-${item.id}`}
              >
                <span className={cn('shrink-0', item.accent)}>{item.icon}</span>
                <span className="text-xs font-medium">{t(item.labelKey)}</span>
              </button>
              <button
                className={cn(
                  'p-1 rounded-md opacity-40 hover:opacity-100 transition-all duration-150',
                  'hover:bg-surface-1',
                  favorites.includes(item.id) ? 'text-amber-400 opacity-100' : 'text-text-muted',
                )}
                onClick={() => toggleFavorite(item.id)}
                data-testid={`sidepanel-star-${item.id}`}
                title={
                  favorites.includes(item.id)
                    ? t('sidePanel.unfavorite', 'Remove from favorites')
                    : t('sidePanel.favorite', 'Add to favorites')
                }
              >
                <Star className={cn('w-3 h-3', favorites.includes(item.id) && 'fill-current')} />
              </button>
            </div>
          ))}
        </nav>
      </div>

      {/* Tool Navigation */}
      <div className="px-3 pt-3">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1 mb-2">
          {t('sidePanel.tools', 'Tools')}
        </div>
        <nav
          className="flex flex-col gap-0.5"
          aria-label={t('sidePanel.tools', 'Tools')}
          data-testid="sidepanel-tools"
        >
          {TOOL_ITEMS.map((item) => (
            <button
              key={item.id}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left w-full',
                'text-text-secondary hover:text-text-primary',
                'hover:bg-surface-1 hover:shadow-sm',
                'transition-all duration-150',
              )}
              onClick={() => navigate(item.id)}
              data-testid={`sidepanel-nav-${item.id}`}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="text-xs font-medium">{t(item.labelKey)}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Running Operation */}
      {runningOp && (
        <div className="px-3 pt-3">
          <div
            className="rounded-lg bg-surface-1 px-3 py-2 flex items-center gap-2"
            data-testid="sidepanel-running-op"
          >
            <Loader className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-text-muted">{t('sidePanel.running')}</div>
              <div className="text-xs font-medium truncate">{runningOp.label}</div>
            </div>
          </div>
        </div>
      )}

      {/* Last Operation */}
      {lastOp && !runningOp && (
        <div className="px-3 pt-3">
          <div className="rounded-lg bg-surface-1 px-3 py-2" data-testid="sidepanel-last-op">
            <div className="text-[10px] text-text-muted mb-1">{t('sidePanel.lastOp')}</div>
            <div className="flex items-center gap-2">
              <StatusIcon status={lastOp.status} />
              <span className="text-xs truncate flex-1">{lastOp.label}</span>
              <span className="text-[10px] text-text-muted shrink-0">
                {formatRelativeTimeI18n(lastOp.timestamp, t, 'sidePanel.relativeTime')}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Open Full UI */}
      <div className="px-3 py-3 border-t border-subtle">
        <button
          className={cn(
            'w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 group',
            'bg-surface-1 border border-subtle',
            'hover:bg-surface-2 hover:border-active transition-all duration-150',
            'text-xs font-medium text-text-secondary hover:text-text-primary',
          )}
          onClick={openFull}
          data-testid="sidepanel-open-full"
        >
          <ExternalLink className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
          {t('sidePanel.openFull')}
        </button>
      </div>
    </div>
  );
};
