import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { syncLanguageFromSettings } from './i18n';
import {
  Flame,
  AlertCircle,
  CheckCircle,
  XCircle,
  Ban,
  Loader,
  Plug,
  ChevronDown,
  Star,
  ArrowRight,
  Sprout,
  Globe,
  Download,
  House,
  ListChecks,
  Plus,
} from 'lucide-react';
import { BrandMark } from './components/ui/BrandMark';
import { MODULE_ITEMS, NAV_GROUPS, TOOL_ITEMS, isNavItemShown } from './navigation/navGroups';
import type { NavItem } from './navigation/navGroups';
import { afterRefreshOf, heroFor } from './navigation/heroFor';
import type { ModuleRoute } from './stores/useAppStore';
import { cn } from './theme';
import { ORG_TYPE_STYLES, ORG_TYPE_STYLE_DEFAULT } from './theme/orgStyles';
import { orgTypeLabel } from './utils/orgFormatters';
import {
  dateTimeFormat,
  formatRelativeTime,
  formatRelativeTimeI18n,
  formatStoredDate,
} from './utils/formatters';
import { useVSCodeApi } from './hooks/useVSCodeApi';
import { useRecentOpsFeed } from './hooks/useRecentOpsFeed';
import { useRecentOpsStore } from './stores/useRecentOpsStore';
import type { RecentOp } from './stores/useRecentOpsStore';
import { useOrgStore } from './stores/useOrgStore';
import { useFavoritesStore } from './stores/useFavoritesStore';
import { isDevelopmentOrg, orgDisplayName } from '@sandforge/shared';
import type { OrgListResponse, OrgPageAction, RecoveryProgress } from '@sandforge/shared';

/**
 * The word each status is read by: the one Home's badges print, so a status
 * reads the same on both.
 */
const STATUS_NAME_KEYS: Record<RecentOp['status'], string> = {
  success: 'home.opStatus.success',
  partial: 'home.opStatus.partial',
  failed: 'home.opStatus.failed',
  running: 'home.opStatus.running',
  cancelled: 'home.opStatus.cancelled',
};

/**
 * Status icon of an operation, beside the word that says its status: hidden
 * from a screen reader, which reads the word.
 */
const StatusIcon: React.FC<{ status: RecentOp['status'] }> = ({ status }) => {
  const hidden = { 'aria-hidden': true } as const;
  switch (status) {
    case 'success':
      return (
        <CheckCircle
          className="w-3.5 h-3.5 text-status-success"
          data-testid="op-status-success"
          {...hidden}
        />
      );
    case 'partial':
      return (
        <AlertCircle
          className="w-3.5 h-3.5 text-status-warning"
          data-testid="op-status-partial"
          {...hidden}
        />
      );
    case 'failed':
      return (
        <XCircle
          className="w-3.5 h-3.5 text-status-error"
          data-testid="op-status-failed"
          {...hidden}
        />
      );
    case 'running':
      return (
        <Loader
          className="w-3.5 h-3.5 text-status-info animate-spin"
          data-testid="op-status-running"
          {...hidden}
        />
      );
    // A run someone stopped: neither the success tick nor the failure cross.
    case 'cancelled':
      return (
        <Ban
          className="w-3.5 h-3.5 text-text-secondary"
          data-testid="op-status-cancelled"
          {...hidden}
        />
      );
  }
};

/**
 * Whether the launcher lists a row: Back into service once a sandbox is
 * registered, the only kind of org a refresh happens to. Grappe's page is
 * retired: its row is listed under no setting.
 */
function listedIn(sandboxRegistered: boolean): (item: NavItem) => boolean {
  return (item) => isNavItemShown(item, { sandboxRegistered, grappeEnabled: false });
}

/**
 * A module's name in the launcher's lists: wrapped on two lines at most rather
 * than cut on one. "Eingefrorenes Dataset", 134 pixels, read "Eingefrorenes
 * Dat…" in a sidebar column about 125 wide.
 */
const NAV_LABEL = 'text-xs font-medium leading-tight min-w-0 line-clamp-2 break-words';

/** Props for one module row of the launcher. */
interface ModuleRowProps {
  item: NavItem;
  /** What the module does, said on hover. */
  title: string;
  active: boolean;
  favorite: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  /** The id of a line under the row that describes its button, which keeps the module's name. */
  describedBy?: string;
}

/** One module of the launcher's lists: its button, and its favourite star. */
const ModuleRow: React.FC<ModuleRowProps> = ({
  item,
  title,
  active,
  favorite,
  onOpen,
  onToggleFavorite,
  describedBy,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center group">
      <button
        className={cn(
          // min-w-0 so a long label wraps instead of pushing the star out of
          // the row: "Eingefrorenes Dataset" is 134 pixels in a column
          // about 125 wide (NAV_LABEL).
          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left flex-1 min-w-0',
          'transition-all duration-150',
          'focus-visible:outline-2 focus-visible:-outline-offset-2',
          'focus-visible:outline-(--sf-accent)',
          active
            ? 'text-text-primary bg-surface-1 shadow-xs'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-1 hover:shadow-xs',
        )}
        onClick={onOpen}
        title={title}
        aria-current={active ? 'page' : undefined}
        aria-describedby={describedBy}
        data-testid={`sidepanel-nav-${item.id}`}
      >
        <span className={cn('shrink-0', item.accent)}>{item.icon}</span>
        <span className={NAV_LABEL}>{t(item.labelKey)}</span>
      </button>
      <button
        className={cn(
          // No opacity dimming: at 40% the unstarred outline fell far
          // below the 3:1 contrast a control's icon needs.
          'p-1 rounded-md transition-all duration-150',
          'hover:bg-surface-1',
          favorite ? 'text-hue-amber' : 'text-text-secondary hover:text-text-primary',
        )}
        onClick={onToggleFavorite}
        data-testid={`sidepanel-star-${item.id}`}
        // Named by the title alone, every star of the list was "Add to
        // favorites": a screen reader could not tell which module one
        // stood for, nor whether it was already a favourite.
        aria-label={t('sidePanel.favoriteModule', { module: t(item.labelKey) })}
        aria-pressed={favorite}
        title={
          favorite
            ? t('sidePanel.unfavorite', 'Remove from favorites')
            : t('sidePanel.favorite', 'Add to favorites')
        }
      >
        <Star className={cn('w-3 h-3', favorite && 'fill-current')} />
      </button>
    </div>
  );
};

/** The latest checkpoint of an org that can be rewound to, as the extension names it. */
interface LastCheckpoint {
  checkpointId: string;
  name: string;
  /** When its take ended, on the org's clock. */
  takenAt: string;
}

/** The extension's answer for the line under Checkpoints: the org asked about, and its checkpoint, if any. */
interface LastCheckpointAnswer {
  orgId: string;
  checkpoint?: LastCheckpoint;
}

/**
 * How often the line under Checkpoints is asked again while a sandbox,
 * scratch or Developer Edition org is selected: its age moves on, and a
 * checkpoint taken from the command line or another window shows. The
 * extension answers from what it read within the last minute.
 */
const LAST_CHECKPOINT_REFRESH_MS = 60_000;

/** The id of the line under Checkpoints, which describes the row's button. */
const LAST_CHECKPOINT_LINE_ID = 'sidepanel-last-checkpoint';

/** The answer `sidebar:lastCheckpoint` carries, or undefined when it is not one. */
function lastCheckpointAnswerOf(payload: unknown): LastCheckpointAnswer | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { orgId, checkpoint } = payload as Record<string, unknown>;
  if (typeof orgId !== 'string') return undefined;
  if (checkpoint === undefined) return { orgId };
  if (typeof checkpoint !== 'object' || checkpoint === null) return undefined;
  const { checkpointId, name, takenAt } = checkpoint as Record<string, unknown>;
  if (typeof checkpointId !== 'string' || typeof name !== 'string' || typeof takenAt !== 'string') {
    return undefined;
  }
  return { orgId, checkpoint: { checkpointId, name, takenAt } };
}

/** Props for {@link LastCheckpointLine}. */
interface LastCheckpointLineProps {
  orgName: string;
  checkpoint: LastCheckpoint;
}

/**
 * A reminder under Checkpoints: when the selected org's latest checkpoint was
 * taken, its name and date in the title. Not a control of its own: the row
 * above opens the page, and its button is described by this line. The age is
 * read from the org's clock, which may run ahead of this machine's: a take
 * that ended "in 5 seconds" is said to have ended now.
 */
const LastCheckpointLine: React.FC<LastCheckpointLineProps> = ({ orgName, checkpoint }) => {
  const { t } = useTranslation();
  const takenAt = Date.parse(checkpoint.takenAt);
  const age =
    formatStoredDate(Math.min(takenAt, Date.now()), (d) => formatRelativeTime(d)) ??
    t('common.dateUnknown');
  const date =
    formatStoredDate(checkpoint.takenAt, (d) =>
      dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(d),
    ) ?? t('common.dateUnknown');
  return (
    <p
      id={LAST_CHECKPOINT_LINE_ID}
      // Under the row's label: its padding, its icon and the gap after it.
      className="pl-9 pr-2.5 pb-1 text-[11px] leading-tight text-text-secondary line-clamp-2 break-words"
      title={t('sidePanel.lastCheckpointTitle', { name: checkpoint.name, date })}
      data-testid="sidepanel-last-checkpoint"
    >
      {t('sidePanel.lastCheckpoint', { org: orgName, age })}
    </p>
  );
};

/** Props for a button of the launcher's first-org card. */
interface FirstOrgButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  testId: string;
  /** The card's main way in, filled; the other is outlined. */
  primary?: boolean;
}

/** A way to connect the first org, on the launcher's first card. */
const FirstOrgButton: React.FC<FirstOrgButtonProps> = ({
  label,
  icon,
  onClick,
  testId,
  primary = false,
}) => (
  <button
    type="button"
    className={cn(
      'w-full flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--sf-accent)',
      'transition-colors',
      primary
        ? 'bg-(--sf-button-bg) text-(--sf-button-fg) hover:bg-(--sf-button-hover)'
        : 'bg-(--sf-button-secondary-bg) text-(--sf-button-secondary-fg) hover:bg-(--sf-button-secondary-hover)',
    )}
    onClick={onClick}
    data-testid={testId}
  >
    {icon}
    <span className="truncate">{label}</span>
  </button>
);

/** Props for the launcher's hero: the one thing it leads with. */
interface HeroCardProps {
  testId: string;
  icon: React.ReactNode;
  /** What a click does, on a line of its own, wrapped and never cut. */
  verb: string;
  /** The org, under the verb: cut where it must be, the title says it whole. */
  alias?: string;
  aliasTestId?: string;
  detail?: string;
  title?: string;
  /** How far, from 0 to 1: a bar under the words, which say it too. */
  progress?: number;
  progressTestId?: string;
  onClick: () => void;
}

/**
 * The hero on a panel with room for it. The verb has a line of its own: the
 * title truncated to one line, and a scratch org named by its long username
 * took the verb with it.
 */
const HeroCard: React.FC<HeroCardProps> = ({
  testId,
  icon,
  verb,
  alias,
  aliasTestId,
  detail,
  title,
  progress,
  progressTestId,
  onClick,
}) => (
  <div className="px-3 pt-3">
    <button
      type="button"
      className={cn(
        'w-full flex items-center gap-3 rounded-lg px-3 py-3 group',
        'bg-surface-1 border border-subtle',
        'hover:bg-surface-2 hover:border-active',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
        'transition-all duration-200',
      )}
      onClick={onClick}
      title={title}
      data-testid={testId}
    >
      <div className="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="text-left flex-1 min-w-0">
        <div className="text-sm font-bold text-text-primary leading-tight break-words">{verb}</div>
        {alias !== undefined && (
          <div className="text-xs text-text-primary truncate" data-testid={aliasTestId}>
            {alias}
          </div>
        )}
        {detail !== undefined && (
          <div className="text-[10px] text-text-secondary leading-tight">{detail}</div>
        )}
        {progress !== undefined && (
          <div aria-hidden="true" className="mt-1.5 h-1 rounded-full bg-surface-3 overflow-hidden">
            <div
              className="h-full rounded-full bg-hue-teal"
              style={{ width: `${Math.min(Math.max(progress, 0), 1) * 100}%` }}
              data-testid={progressTestId}
            />
          </div>
        )}
      </div>
      <ArrowRight className="w-3.5 h-3.5 text-text-secondary group-hover:translate-x-0.5 transition-all shrink-0" />
    </button>
  </div>
);

/** The hero on a short panel: one row, so the modules stay in view. */
const HeroCompact: React.FC<
  Pick<HeroCardProps, 'testId' | 'icon' | 'verb' | 'alias' | 'title' | 'onClick'>
> = ({ testId, icon, verb, alias, title, onClick }) => (
  <div className="px-3 pt-2">
    <button
      type="button"
      className={cn(
        'w-full flex items-center gap-2 rounded-lg px-2.5 py-2',
        'bg-surface-1 border border-subtle',
        'hover:bg-surface-2 transition-all text-left',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
      )}
      onClick={onClick}
      title={title}
      data-testid={testId}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex flex-col min-w-0">
        <span className="text-xs font-bold text-text-primary leading-tight">{verb}</span>
        {alias !== undefined && (
          <span className="text-[10px] text-text-primary truncate">{alias}</span>
        )}
      </span>
      <ArrowRight className="w-3 h-3 text-text-secondary ml-auto shrink-0" />
    </button>
  </div>
);

/**
 * The launcher in the VS Code sidebar: the org, what to do first with it,
 * the modules grouped by what they are for, the run in flight or the last
 * one, and the tools. Each module opens in its own editor tab.
 */
export const SidePanel: React.FC = () => {
  const { t } = useTranslation();
  const vscodeApi = useVSCodeApi();
  // Feed the recent-ops store from operation lifecycle messages so the
  // activity line below has real data.
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
  /** The switcher's trigger: the focus comes back to it once the list closes under it. */
  const orgTriggerRef = useRef<HTMLButtonElement>(null);
  const orgSwitcherRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the extension has answered with the org list yet.
   *
   * The view is recreated every time VS Code hides and shows the side panel,
   * so the list starts empty on each one. Rendering "No org connected" while
   * the answer is still in flight told users, several times a session, that
   * nothing was connected when everything was.
   */
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  /**
   * The module this panel last sent the user to. Navigation is a one-way
   * message, so this is what the sidebar knows; without it no row ever looked
   * selected and eleven identical rows gave no sense of place at all.
   */
  const [activeRoute, setActiveRoute] = useState<string | null>(null);
  /**
   * The refreshed sandboxes not yet back into service, as the extension tells
   * them: undefined until it has.
   */
  const [afterRefresh, setAfterRefresh] = useState<RecoveryProgress[] | undefined>(undefined);
  /**
   * How many orgs the Salesforce CLI holds, said by the extension while no
   * org is registered; null until it says.
   */
  const [cliOrgCount, setCliOrgCount] = useState<number | null>(null);
  /**
   * The extension's last answer for the line under Checkpoints. Shown only
   * while it is of the org selected: an answer for the org before is let be.
   */
  const [lastCheckpoint, setLastCheckpoint] = useState<LastCheckpointAnswer | null>(null);
  /** Moved on each minute, so the line's age is written again. */
  const [, setAgeTick] = useState(0);

  /** Sorted orgs: connected first, then alphabetical by alias/username within each group. */
  const sortedOrgs = useMemo(() => {
    return [...orgs].sort((a, b) => {
      const aConn = a.status === 'connected' ? 0 : 1;
      const bConn = b.status === 'connected' ? 0 : 1;
      if (aConn !== bConn) return aConn - bConn;
      const aName = orgDisplayName(a).toLowerCase();
      const bName = orgDisplayName(b).toLowerCase();
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

  /**
   * Escape and a click elsewhere close the org list.
   *
   * It opened on a click of its own trigger and closed only on a second one.
   * Anywhere else in the product that is how a menu gets stuck: people click
   * away, the list stays over the content, and the panel looks broken.
   */
  useEffect(() => {
    if (!orgDropdownOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setOrgDropdownOpen(false);
      // Closed from inside the list, the focus would fall with it.
      if (document.activeElement?.closest('[data-org-switcher]')) orgTriggerRef.current?.focus();
    };
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-org-switcher]')) return;
      setOrgDropdownOpen(false);
    };
    // Tabbing out left the list open over the launcher: it closes once the
    // focus has left the switcher.
    const switcher = orgSwitcherRef.current;
    const onFocusOut = (e: FocusEvent): void => {
      if (!switcher?.contains(e.relatedTarget as Node | null)) setOrgDropdownOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    switcher?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
      switcher?.removeEventListener('focusout', onFocusOut);
    };
  }, [orgDropdownOpen]);

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
        payload?: Partial<OrgListResponse['payload']> & {
          settings?: unknown;
          orgId?: string;
          count?: unknown;
        };
      };
      if (msg.type === 'org:list:response' && msg.payload?.orgs) {
        setOrgsLoaded(true);
        useOrgStore.getState().setOrgs(msg.payload.orgs);
        // The payload also carries the extension-side selection — adopt it
        // when this document has none (the view is recreated on hide/show).
        const selected = msg.payload.selectedOrgId;
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
      if (msg.type === 'sidebar:cliOrgs' && typeof msg.payload?.count === 'number') {
        setCliOrgCount(msg.payload.count);
      }
      if (msg.type === 'sidebar:lastCheckpoint') {
        const answer = lastCheckpointAnswerOf(msg.payload);
        if (answer) setLastCheckpoint(answer);
      }
      // The refreshed sandboxes, told with the org list and at each change.
      if (msg.type === 'sidebar:afterRefresh') {
        const told = afterRefreshOf(msg.payload);
        if (told) setAfterRefresh(told);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [vscodeApi]);

  /**
   * The line under Checkpoints is asked of the org selected, when it is one a
   * checkpoint can be taken of: never of a production org. Asked again each
   * minute while it stays selected.
   */
  const lastCheckpointOffered = selectedOrg !== undefined && isDevelopmentOrg(selectedOrg);
  useEffect(() => {
    if (!lastCheckpointOffered || selectedOrgId === null) return;
    const ask = (): void =>
      vscodeApi.postMessage({
        type: 'sidebar:requestLastCheckpoint',
        payload: { orgId: selectedOrgId },
      });
    ask();
    const timer = setInterval(() => {
      setAgeTick((tick) => tick + 1);
      ask();
    }, LAST_CHECKPOINT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [lastCheckpointOffered, selectedOrgId, vscodeApi]);
  const shownCheckpoint =
    lastCheckpointOffered && lastCheckpoint?.orgId === selectedOrgId
      ? lastCheckpoint.checkpoint
      : undefined;

  /**
   * Send navigation message to extension host via vscode API. The launcher's
   * first card also names what Organizations should start as it opens.
   */
  const navigate = (route: string, intent?: { orgAction: OrgPageAction }): void => {
    setActiveRoute(route);
    vscodeApi.postMessage({
      type: 'sidebar:navigate',
      payload: intent ? { route, intent } : { route },
    });
  };

  /**
   * Open a module's page on an org: select it everywhere first, so the page
   * opens on it. Seed's gallery for the one org to fill, Back into service
   * for the sandbox refreshed.
   */
  const openOn = (orgId: string, route: ModuleRoute): void => {
    if (orgId !== selectedOrgId) {
      selectOrg(orgId);
      vscodeApi.postMessage({ type: 'sidebar:selectOrg', payload: { orgId } });
    }
    navigate(route);
  };

  /** Open Home in an editor tab. */
  const openFull = (): void => {
    vscodeApi.postMessage({ type: 'sidebar:openFull' });
  };

  const connectedCount = connectedOrgs.length;

  /**
   * What the launcher leads with: the rule Home follows too (`heroFor`). The
   * hero always opened Forge, which with one org showed "Source and target
   * must be different", and with a production org alone could only refuse.
   */
  const hero = heroFor({ orgs: orgsLoaded ? orgs : undefined, selectedOrgId, afterRefresh });
  const noOrgYet = hero.kind === 'firstOrg';
  const listed = listedIn(orgs.some((org) => org.orgType === 'Sandbox'));
  /**
   * Under Copy between orgs, once an org is registered: every module of the
   * group copies from one org to another, and fewer than two are connected.
   */
  const needsSecondOrg = orgsLoaded && orgs.length > 0 && connectedCount < 2;
  /** The run in flight, else the last one: one line, which opens its module. */
  const activity = runningOp ?? lastOp;

  return (
    <div
      className={cn(
        'h-screen w-full flex flex-col overflow-auto',
        'bg-surface-0 text-text-primary',
      )}
      data-testid="sidepanel-root"
    >
      {/* Branding: the product's own mark, not the Forge module's flame, and
          Home beside it. "Open Full UI", at the foot, promised a fuller
          launcher and opened Home. */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 border-b border-subtle"
        data-testid="sidepanel-brand"
      >
        <BrandMark className="w-5 h-5" />
        <span className="text-sm font-bold tracking-tight flex-1 min-w-0 truncate">SandForge</span>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1.5 shrink-0',
            'text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-1',
            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
            'transition-colors',
          )}
          onClick={openFull}
          data-testid="sidepanel-open-full"
        >
          <House className="w-3.5 h-3.5" aria-hidden="true" />
          {t('nav.home')}
        </button>
      </div>

      {/* Org Switcher */}
      <div ref={orgSwitcherRef} className="px-3 pt-3 relative" data-org-switcher>
        <button
          ref={orgTriggerRef}
          className={cn(
            'w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5',
            'bg-surface-1 border border-subtle',
            'hover:bg-surface-2 hover:border-active transition-all text-left',
            'focus-visible:outline-2 focus-visible:-outline-offset-2',
            'focus-visible:outline-(--sf-accent)',
            'group',
          )}
          onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
          aria-expanded={orgDropdownOpen}
          aria-controls={orgDropdownOpen ? 'sidepanel-org-dropdown' : undefined}
          data-testid="sidepanel-org"
        >
          <span
            className={cn(
              'h-2.5 w-2.5 rounded-full shrink-0',
              selectedOrg?.status === 'connected'
                ? 'bg-status-success ring-2 ring-status-success/20'
                : selectedOrg?.status === 'refreshing'
                  ? 'bg-status-warning ring-2 ring-status-warning/20'
                  : selectedOrg
                    ? 'bg-status-error ring-2 ring-status-error/20'
                    : // No ring when nothing is selected: there is no severity to
                      // halo, and `text-secondary` has no ring tint in the scale.
                      'bg-text-secondary',
            )}
          />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold truncate block">
              {selectedOrg
                ? orgDisplayName(selectedOrg)
                : !orgsLoaded
                  ? t('sidePanel.loadingOrgs', 'Loading orgs…')
                  : connectedCount > 0
                    ? t('sidePanel.selectOrg', 'Select an org')
                    : t('sidePanel.noOrg', 'No org connected')}
            </span>
            {/* Its connection, said: the dot's colour told it alone. */}
            {selectedOrg && (
              <span className="sr-only">{t(`sidePanel.orgStatus.${selectedOrg.status}`)}</span>
            )}
          </div>
          {selectedOrg && (
            <span
              className={cn(
                'text-[10px] font-bold px-1.5 py-0.5 rounded-md border shrink-0 uppercase',
                ORG_TYPE_STYLES[selectedOrg.orgType] ?? ORG_TYPE_STYLE_DEFAULT,
              )}
            >
              {orgTypeLabel(selectedOrg, t)}
            </span>
          )}
          <ChevronDown
            className={cn(
              'w-3.5 h-3.5 text-text-secondary transition-transform duration-200',
              orgDropdownOpen && 'rotate-180',
            )}
          />
        </button>

        {/* Org dropdown */}
        {orgDropdownOpen && (
          <div
            id="sidepanel-org-dropdown"
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
                          // The option goes with the list: the focus goes back to the trigger.
                          orgTriggerRef.current?.focus();
                          vscodeApi.postMessage({
                            type: 'sidebar:selectOrg',
                            payload: { orgId: org.id },
                          });
                        }}
                        aria-current={org.id === selectedOrgId ? 'true' : undefined}
                        data-testid={`sidepanel-org-option-${org.id}`}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-1.5 w-1.5 rounded-full shrink-0',
                            isOrgConnected ? 'bg-status-success' : 'bg-text-secondary',
                          )}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{orgDisplayName(org)}</div>
                          <span className="sr-only">{t(`sidePanel.orgStatus.${org.status}`)}</span>
                          <div className="text-[10px] text-text-secondary truncate">
                            {org.username}
                          </div>
                        </div>
                        <span
                          className={cn(
                            'text-[10px] font-bold px-1.5 py-0.5 rounded-md border shrink-0',
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
                          'text-text-secondary hover:text-text-primary hover:bg-surface-3',
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
              <div className="px-3 py-3 text-xs text-text-secondary text-center">
                {orgsLoaded
                  ? t('sidePanel.noOrgHint', 'No org yet — connect one below')
                  : t('sidePanel.loadingOrgs', 'Loading orgs…')}
              </div>
            )}
            <button
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 text-left text-xs',
                'text-hue-orange hover:bg-surface-2 border-t border-subtle',
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

      {/* First org: the way to connect, at the top. It was the last entry of
          the org dropdown, under 0/0 counters and a hero that opened Forge. */}
      {noOrgYet && (
        <div className="px-3 pt-3">
          <section
            className="rounded-lg bg-surface-1 border border-subtle px-3 py-3 flex flex-col gap-2"
            aria-labelledby="sidepanel-first-org-title"
            data-testid="sidepanel-first-org"
          >
            <h2 id="sidepanel-first-org-title" className="text-sm font-bold text-text-primary">
              {t('sidePanel.firstOrg.title')}
            </h2>
            <p className="text-xs text-text-secondary leading-snug">
              {t('sidePanel.firstOrg.desc')}
            </p>
            {cliOrgCount === 0 ? (
              <>
                <FirstOrgButton
                  primary
                  icon={<Globe className="w-3.5 h-3.5" />}
                  label={t('sidePanel.firstOrg.loginWeb')}
                  onClick={() => navigate('orgs', { orgAction: 'login-web' })}
                  testId="sidepanel-first-org-login"
                />
                <FirstOrgButton
                  icon={<Download className="w-3.5 h-3.5" />}
                  label={t('sidePanel.firstOrg.import')}
                  onClick={() => navigate('orgs', { orgAction: 'import-cli' })}
                  testId="sidepanel-first-org-import"
                />
              </>
            ) : (
              <>
                <FirstOrgButton
                  primary
                  icon={<Download className="w-3.5 h-3.5" />}
                  label={
                    cliOrgCount === null
                      ? t('sidePanel.firstOrg.import')
                      : t('sidePanel.firstOrg.importCount', { count: cliOrgCount })
                  }
                  onClick={() => navigate('orgs', { orgAction: 'import-cli' })}
                  testId="sidepanel-first-org-import"
                />
                <FirstOrgButton
                  icon={<Globe className="w-3.5 h-3.5" />}
                  label={t('sidePanel.firstOrg.loginWeb')}
                  onClick={() => navigate('orgs', { orgAction: 'login-web' })}
                  testId="sidepanel-first-org-login"
                />
              </>
            )}
          </section>
        </div>
      )}

      {hero.kind === 'afterRefresh' &&
        (isCompact ? (
          <HeroCompact
            testId="sidepanel-after-refresh-hero-compact"
            icon={<ListChecks className="w-4 h-4 text-hue-teal" />}
            verb={t('sidePanel.afterRefresh.compact', { done: hero.done, total: hero.total })}
            alias={hero.alias}
            title={t('sidePanel.afterRefresh.title', { alias: hero.alias })}
            onClick={() => openOn(hero.orgId, 'recovery')}
          />
        ) : (
          <HeroCard
            testId="sidepanel-after-refresh-hero"
            icon={<ListChecks className="w-5 h-5 text-hue-teal" />}
            verb={t('sidePanel.afterRefresh.title', { alias: hero.alias })}
            detail={t('sidePanel.afterRefresh.desc', {
              age:
                formatStoredDate(Math.min(Date.parse(hero.detectedAt), Date.now()), (d) =>
                  formatRelativeTime(d),
                ) ?? t('common.dateUnknown'),
              done: hero.done,
              total: hero.total,
            })}
            progress={hero.total > 0 ? hero.done / hero.total : 0}
            progressTestId="sidepanel-after-refresh-bar"
            onClick={() => openOn(hero.orgId, 'recovery')}
          />
        ))}

      {hero.kind === 'reconnect' &&
        (isCompact ? (
          <HeroCompact
            testId="sidepanel-reconnect-hero-compact"
            icon={<Plug className="w-4 h-4 text-status-warning" />}
            verb={t('sidePanel.reconnect.title', { alias: hero.alias })}
            title={t('sidePanel.reconnect.desc')}
            onClick={() => navigate('orgs')}
          />
        ) : (
          <HeroCard
            testId="sidepanel-reconnect-hero"
            icon={<Plug className="w-5 h-5 text-status-warning" />}
            verb={t('sidePanel.reconnect.title', { alias: hero.alias })}
            detail={t('sidePanel.reconnect.desc')}
            onClick={() => navigate('orgs')}
          />
        ))}

      {/* One org to fill, connected alone: Seed on it, since Forge, Sync and
          Autopilot all need a second org. */}
      {hero.kind === 'seed' &&
        (isCompact ? (
          <HeroCompact
            testId="sidepanel-seed-hero-compact"
            icon={<Sprout className="w-4 h-4 text-hue-green" />}
            verb={t('sidePanel.fillOrgAction')}
            alias={hero.alias}
            title={t('sidePanel.fillOrg', { alias: hero.alias })}
            onClick={() => openOn(hero.orgId, 'seed')}
          />
        ) : (
          <HeroCard
            testId="sidepanel-seed-hero"
            icon={<Sprout className="w-5 h-5 text-hue-green" />}
            verb={t('sidePanel.fillOrgAction')}
            alias={hero.alias}
            aliasTestId="sidepanel-seed-hero-alias"
            detail={t('sidePanel.fillOrgDesc')}
            title={t('sidePanel.fillOrg', { alias: hero.alias })}
            onClick={() => openOn(hero.orgId, 'seed')}
          />
        ))}

      {/* Forge Hero: once there are two orgs to copy between */}
      {hero.kind === 'forge' && !isCompact && (
        <div className="px-3 pt-3">
          <button
            type="button"
            className={cn(
              'w-full flex items-center gap-3 rounded-lg px-3 py-3 group',
              // A flat tint: text on a gradient has no single background to be read against.
              'bg-forge/10 border border-forge/20',
              'hover:bg-forge/15 hover:border-forge/40',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
              'transition-all duration-200',
            )}
            onClick={() => navigate('forge')}
            data-testid="sidepanel-forge"
          >
            <div className="relative shrink-0">
              <div className="w-8 h-8 rounded-lg bg-forge/15 flex items-center justify-center">
                <Flame className="w-5 h-5 text-hue-orange" />
              </div>
              <div className="absolute -inset-0.5 bg-hue-orange/10 rounded-lg blur-xs -z-10 group-hover:bg-hue-orange/20 transition-colors" />
            </div>
            <div className="text-left flex-1 min-w-0">
              <div className="text-sm font-bold text-hue-orange">{t('sidePanel.forge')}</div>
              {/* On the tint, only the editor foreground keeps its contrast. */}
              <div className="text-[10px] text-text-primary leading-tight">
                {t('sidePanel.forgeDesc')}
              </div>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-text-secondary group-hover:text-hue-orange group-hover:translate-x-0.5 transition-all shrink-0" />
          </button>
        </div>
      )}
      {hero.kind === 'forge' && isCompact && (
        <div className="px-3 pt-2">
          <button
            type="button"
            className={cn(
              'w-full flex items-center gap-2 rounded-lg px-2.5 py-2',
              'bg-forge/10 border border-forge/20',
              'hover:bg-forge/20 transition-all text-left',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
            )}
            onClick={() => navigate('forge')}
            data-testid="sidepanel-forge-compact"
          >
            <Flame className="w-4 h-4 text-hue-orange shrink-0" />
            <span className="text-xs font-bold text-hue-orange">{t('sidePanel.forge')}</span>
            <ArrowRight className="w-3 h-3 text-text-secondary ml-auto shrink-0" />
          </button>
        </div>
      )}

      {/* Production orgs alone: Forge copies from them, into a sandbox still
          to add. Forge was offered, and could only refuse. */}
      {hero.kind === 'addSandbox' &&
        (isCompact ? (
          <HeroCompact
            testId="sidepanel-add-sandbox-hero-compact"
            icon={<Plus className="w-4 h-4 text-hue-orange" />}
            verb={t('sidePanel.addSandbox.title')}
            title={t('sidePanel.addSandbox.desc', { alias: hero.alias })}
            onClick={() => navigate('orgs', { orgAction: 'login-web' })}
          />
        ) : (
          <HeroCard
            testId="sidepanel-add-sandbox-hero"
            icon={<Plus className="w-5 h-5 text-hue-orange" />}
            verb={t('sidePanel.addSandbox.title')}
            detail={t('sidePanel.addSandbox.desc', { alias: hero.alias })}
            onClick={() => navigate('orgs', { orgAction: 'login-web' })}
          />
        ))}

      {/* Favorite Modules (if any) */}
      {favorites.length > 0 && (
        <div className="px-3 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary px-1 mb-1.5">
            {t('sidePanel.favorites', 'Favorites')}
          </div>
          <nav
            className="flex flex-col gap-0.5"
            aria-label={t('sidePanel.favorites', 'Favorites')}
            data-testid="sidepanel-favorites"
          >
            {MODULE_ITEMS.filter(listed)
              .filter((item) => favorites.includes(item.id))
              .map((item) => (
                // The same geometry as the Modules row below. They were a
                // different height and a different corner radius, forty pixels
                // apart, for the same module.
                <div key={item.id} className="flex items-center group">
                  <button
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left flex-1 min-w-0',
                      'transition-all duration-150',
                      'focus-visible:outline-2 focus-visible:-outline-offset-2',
                      'focus-visible:outline-(--sf-accent)',
                      activeRoute === item.id
                        ? 'text-text-primary bg-surface-1 shadow-xs'
                        : 'text-text-secondary hover:text-text-primary hover:bg-surface-1 hover:shadow-xs',
                    )}
                    onClick={() => navigate(item.id)}
                    title={t(`moduleSummary.${item.id}`)}
                    aria-current={activeRoute === item.id ? 'page' : undefined}
                    data-testid={`sidepanel-fav-${item.id}`}
                  >
                    <span className={cn('shrink-0', item.accent)}>{item.icon}</span>
                    <span className={NAV_LABEL}>{t(item.labelKey)}</span>
                  </button>
                  {/* Removing a favourite meant scrolling down to find the same
                    row again in Modules. */}
                  <button
                    className={cn(
                      'p-1 rounded-md transition-all duration-150 text-hue-amber',
                      'hover:bg-surface-1',
                      'focus-visible:outline-2 focus-visible:-outline-offset-2',
                      'focus-visible:outline-(--sf-accent)',
                    )}
                    onClick={() => toggleFavorite(item.id)}
                    data-testid={`sidepanel-fav-star-${item.id}`}
                    aria-label={t('sidePanel.favoriteModule', { module: t(item.labelKey) })}
                    aria-pressed={true}
                    title={t('sidePanel.unfavorite', 'Remove from favorites')}
                  >
                    <Star className="w-3 h-3 fill-current" />
                  </button>
                </div>
              ))}
          </nav>
        </div>
      )}

      {/* The modules, grouped by what they are for, in one nav: each group
          named by its heading. None folds: "Advanced" hid Masking and Compare
          from the person who needed them after a refresh. */}
      <nav
        className="px-3 pt-1 flex flex-col"
        aria-label={t('sidePanel.modules', 'Modules')}
        data-testid="sidepanel-modules"
      >
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(listed);
          if (items.length === 0) return null;
          const headingId = `sidepanel-group-${group.id}-title`;
          return (
            <div
              key={group.id}
              role="group"
              aria-labelledby={headingId}
              className="flex flex-col gap-0.5 pt-2"
              data-testid={`sidepanel-group-${group.id}`}
            >
              <h2
                id={headingId}
                className="text-[10px] leading-tight font-semibold uppercase tracking-widest text-text-secondary px-1 mb-0.5"
              >
                {t(group.labelKey)}
              </h2>
              {items.map((item) => {
                const line = item.id === 'checkpoint' && selectedOrg ? shownCheckpoint : undefined;
                return (
                  <React.Fragment key={item.id}>
                    <ModuleRow
                      item={item}
                      title={t(`moduleSummary.${item.id}`)}
                      active={activeRoute === item.id}
                      favorite={favorites.includes(item.id)}
                      onOpen={() => navigate(item.id)}
                      onToggleFavorite={() => toggleFavorite(item.id)}
                      describedBy={line ? LAST_CHECKPOINT_LINE_ID : undefined}
                    />
                    {line && selectedOrg && (
                      <LastCheckpointLine orgName={orgDisplayName(selectedOrg)} checkpoint={line} />
                    )}
                  </React.Fragment>
                );
              })}
              {group.id === 'copy' && needsSecondOrg && (
                <button
                  type="button"
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left w-full min-w-0',
                    'text-[11px] leading-tight text-text-secondary hover:text-text-primary hover:bg-surface-1',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
                  )}
                  onClick={() => navigate('orgs')}
                  data-testid="sidepanel-needs-second-org"
                >
                  <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-words">{t('sidePanel.needsSecondOrg')}</span>
                </button>
              )}
            </div>
          );
        })}
      </nav>

      {/* Spacer */}
      <div className="flex-1" />

      {/* The run in flight, else the last one, on one line that opens its
          module, where a failed run says why. The run in flight led nowhere,
          and the module and status are said in the panel's language: the
          label the extension gives a run is English. */}
      {activity && (
        <div className="px-3 pt-3">
          <button
            type="button"
            className={cn(
              'w-full flex items-center gap-2 rounded-lg bg-surface-1 px-3 py-2 text-left',
              'text-text-primary hover:bg-surface-2 transition-colors',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sf-accent)',
            )}
            onClick={() => navigate(activity.type)}
            title={t('home.openOpModule', { module: t(`nav.${activity.type}`) })}
            data-testid={
              activity.status === 'running' ? 'sidepanel-running-op' : 'sidepanel-last-op'
            }
          >
            <StatusIcon status={activity.status} />
            <span className="text-xs truncate flex-1 min-w-0">
              {`${t(`nav.${activity.type}`)} · ${t(STATUS_NAME_KEYS[activity.status])}`}
            </span>
            {activity.status !== 'running' && (
              <span className="text-[10px] text-text-secondary shrink-0">
                {formatRelativeTimeI18n(activity.timestamp, t, 'common.relativeTime')}
              </span>
            )}
          </button>
        </div>
      )}

      {/* The tools, in one bar: each its icon over its name. A tool is never
          narrower than "Organisationen", 84 pixels at this size: on a narrow
          sidebar the bar wraps rather than break the word. */}
      <nav
        className="flex flex-wrap gap-0.5 px-2 py-1.5 mt-2 border-t border-subtle"
        aria-label={t('sidePanel.tools', 'Tools')}
        data-testid="sidepanel-tools"
      >
        {TOOL_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={cn(
              'flex-1 basis-22 min-w-0 flex flex-col items-center gap-1 rounded-lg px-0.5 py-1.5',
              'transition-all duration-150',
              'focus-visible:outline-2 focus-visible:-outline-offset-2',
              'focus-visible:outline-(--sf-accent)',
              activeRoute === item.id
                ? 'text-text-primary bg-surface-1 shadow-xs'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-1 hover:shadow-xs',
            )}
            onClick={() => navigate(item.id)}
            aria-current={activeRoute === item.id ? 'page' : undefined}
            data-testid={`sidepanel-nav-${item.id}`}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="text-[11px] font-medium leading-tight text-center max-w-full line-clamp-2 break-words">
              {t(item.labelKey)}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
};
