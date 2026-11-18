import type React from 'react';
import {
  Activity,
  Bot,
  ChartColumn,
  FileUp,
  Flame,
  GitCompare,
  HelpCircle,
  History,
  ListChecks,
  Plug,
  RefreshCw,
  Rocket,
  Settings,
  Shield,
  Snowflake,
  Sprout,
  Zap,
} from 'lucide-react';
import type { ModuleRoute } from '../stores/useAppStore';

/**
 * The modules by what they are for, as the launcher, Home and Help list them.
 *
 * The launcher put seven modules first and folded the others under
 * "Advanced": a classing by difficulty, which hid Masking and Compare from
 * the person who needed them after a refresh, and four modules that copy
 * between orgs sat side by side with nothing to tell them apart. Each group
 * says what its modules do, in a fixed order — filling an org first, which
 * works with one empty org — and no group folds, which would make another
 * "Advanced".
 *
 * Only `lucide-react` is imported here: the launcher's bundle reaches this
 * file, and none of the panel's pages. The rows keep the literal shape
 * `id: '…', labelKey: '…', icon: <…` that the guides' tests and Help's read
 * from the text.
 */

/** A condition a row is listed under, which the list that renders it applies. */
export type NavItemCondition =
  /** Back into service: once a sandbox is registered, the only kind of org a refresh happens to. */
  'sandboxRegistered';

/** One row: the route it opens, its name, its icon and its colour. */
export interface NavItem {
  id: ModuleRoute;
  labelKey: string;
  icon: React.ReactNode;
  /** The module's colour, a `text-hue-*` class; the tools have none. */
  accent?: string;
  /** Listed only while this holds; always when absent. */
  shownWhen?: NavItemCondition;
}

/** The groups, by what their modules are for. */
export type NavGroupId = 'fill' | 'copy' | 'protect' | 'watch' | 'automate';

/** A group of modules, named by its heading. */
export interface NavGroup {
  id: NavGroupId;
  labelKey: string;
  items: readonly NavItem[];
}

/** The five groups, in the order every list shows them. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'fill',
    labelKey: 'sidePanel.group.fill',
    items: [
      {
        id: 'seed',
        labelKey: 'nav.seed',
        icon: <Sprout className="w-4 h-4" />,
        accent: 'text-hue-green',
      },
      {
        id: 'frozen',
        labelKey: 'nav.frozen',
        icon: <Snowflake className="w-4 h-4" />,
        accent: 'text-hue-cyan',
      },
    ],
  },
  {
    id: 'copy',
    labelKey: 'sidePanel.group.copy',
    items: [
      {
        id: 'forge',
        labelKey: 'nav.forge',
        icon: <Flame className="w-4 h-4" />,
        accent: 'text-hue-orange',
      },
      {
        id: 'sync',
        labelKey: 'nav.sync',
        icon: <RefreshCw className="w-4 h-4" />,
        accent: 'text-hue-sky',
      },
      {
        id: 'autopilot',
        labelKey: 'nav.autopilot',
        icon: <Rocket className="w-4 h-4" />,
        accent: 'text-hue-rose',
      },
      {
        id: 'migration',
        labelKey: 'nav.migration',
        icon: <FileUp className="w-4 h-4" />,
        accent: 'text-hue-teal',
      },
    ],
  },
  {
    id: 'protect',
    labelKey: 'sidePanel.group.protect',
    items: [
      {
        id: 'recovery',
        labelKey: 'nav.recovery',
        icon: <ListChecks className="w-4 h-4" />,
        accent: 'text-hue-teal',
        shownWhen: 'sandboxRegistered',
      },
      {
        id: 'checkpoint',
        labelKey: 'nav.checkpoint',
        icon: <History className="w-4 h-4" />,
        accent: 'text-hue-indigo',
      },
      {
        id: 'dataops',
        labelKey: 'nav.dataops',
        icon: <Shield className="w-4 h-4" />,
        accent: 'text-hue-yellow',
      },
    ],
  },
  {
    id: 'watch',
    labelKey: 'sidePanel.group.watch',
    items: [
      {
        id: 'monitor',
        labelKey: 'nav.monitor',
        icon: <Activity className="w-4 h-4" />,
        accent: 'text-hue-blue',
      },
      {
        id: 'compare',
        labelKey: 'nav.compare',
        icon: <GitCompare className="w-4 h-4" />,
        accent: 'text-hue-purple',
      },
      {
        id: 'reports',
        labelKey: 'nav.reports',
        icon: <ChartColumn className="w-4 h-4" />,
        accent: 'text-hue-sky',
      },
    ],
  },
  {
    id: 'automate',
    labelKey: 'sidePanel.group.automate',
    items: [
      {
        id: 'automation',
        labelKey: 'nav.automation',
        icon: <Zap className="w-4 h-4" />,
        accent: 'text-hue-amber',
      },
      {
        id: 'ai',
        labelKey: 'nav.ai',
        icon: <Bot className="w-4 h-4" />,
        accent: 'text-hue-fuchsia',
      },
    ],
  },
];

/** Every module, in the groups' order: what favourites are picked from. */
export const MODULE_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** The tools: the orgs, the settings, the help. */
export const TOOL_ITEMS: readonly NavItem[] = [
  { id: 'orgs', labelKey: 'nav.orgs', icon: <Plug className="w-4 h-4" /> },
  { id: 'settings', labelKey: 'nav.settings', icon: <Settings className="w-4 h-4" /> },
  { id: 'help', labelKey: 'nav.help', icon: <HelpCircle className="w-4 h-4" /> },
];

/**
 * Whether a row is listed, given what holds now: always, unless it names a
 * condition that does not.
 */
export function isNavItemShown(
  item: NavItem,
  facts: Readonly<Record<NavItemCondition, boolean>>,
): boolean {
  return item.shownWhen === undefined || facts[item.shownWhen];
}
