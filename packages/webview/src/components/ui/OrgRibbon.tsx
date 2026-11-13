import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowRight, ShieldAlert } from 'lucide-react';
import { registeredOrgType, orgDisplayName } from '@sandforge/shared';
import { cn } from '../../theme';
import { OrgTypeBadge } from './OrgBadge';
import { isNotHeld, type OrgRibbonOrg } from './ribbonOrg';

/** How the two sides of a ribbon are named. */
export type OrgRibbonKind = 'copy' | 'compare' | 'load';

/** The words of each side, by what the page does between the two orgs. */
const SIDE_KEYS: Readonly<Record<OrgRibbonKind, { source: string; target: string }>> = {
  copy: { source: 'common.orgRibbon.copiedFrom', target: 'common.orgRibbon.writtenInto' },
  compare: { source: 'common.orgRibbon.source', target: 'common.orgRibbon.target' },
  load: { source: 'common.orgRibbon.frozenFrom', target: 'common.orgRibbon.writtenInto' },
};

/** Props for {@link OrgRibbon}. */
export interface OrgRibbonProps {
  /** Where the data comes from: a dataset's source may be known by its name alone. */
  source: OrgRibbonOrg;
  /** Where the page writes, or what it compares the source with. */
  target: OrgRibbonOrg;
  /** What the page does between the two orgs: `copy` unless it says otherwise. */
  kind?: OrgRibbonKind;
  /**
   * The controls that pick each org, drawn where the ribbon names it, with
   * their own label: a page that picks the orgs on the screen that compares
   * them named each twice, once in its picker and once in the ribbon under it.
   */
  pickers?: { source: React.ReactNode; target: React.ReactNode };
  className?: string;
}

/** Whether an org is read as a production org, as its type label names it. */
function isProduction(org: OrgRibbonOrg): boolean {
  if (org === undefined || typeof org === 'string' || isNotHeld(org)) return false;
  return registeredOrgType(org.orgType, org.metadata?.edition) === 'Production';
}

/** Props of {@link RibbonSide}. */
interface RibbonSideProps {
  org: OrgRibbonOrg;
  label: string;
  /** The side the page writes to: framed, where the other is left quiet. */
  target: boolean;
  /** The control that picks the org, named by its own label, in place of the side's name. */
  picker?: React.ReactNode;
  testId: string;
}

/** One side of the ribbon: what it is, the org, its type and its instance. */
const RibbonSide: React.FC<RibbonSideProps> = ({ org, label, target, picker, testId }) => {
  const { t, i18n } = useTranslation();
  const notHeld = isNotHeld(org) ? org.notHeld : undefined;
  const known = typeof org === 'object' && !isNotHeld(org) ? org : undefined;
  const name = known ? orgDisplayName(known) : typeof org === 'string' ? org : undefined;
  const production = isProduction(org);
  const statusKey = known ? `common.orgStatus_${known.status}` : '';
  const host = known?.instanceUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const hostSpan = host && (
    <span
      data-testid={`${testId}-url`}
      title={known?.instanceUrl}
      className="min-w-0 truncate text-[11px]"
    >
      {host}
    </span>
  );
  /** The production word and a status other than connected: beside the name, or under a picker. */
  const marks = (
    <>
      {/* The word beside the type's: a red badge says nothing to someone who
          does not see the red, and PROD is an abbreviation. */}
      {production && (
        <span data-testid={`${testId}-production`} className="text-xs font-bold text-text-primary">
          {t('common.orgRibbon.production')}
        </span>
      )}
      {known && known.status !== 'connected' && (
        <span data-testid={`${testId}-status`} className="text-xs text-status-warning">
          {i18n.exists(statusKey) ? t(statusKey) : known.status}
        </span>
      )}
    </>
  );
  const shield = production && (
    <ShieldAlert size={16} aria-hidden="true" className="shrink-0 text-status-error" />
  );
  return (
    <div
      data-testid={testId}
      data-production={production ? 'true' : undefined}
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-3 py-2',
        // The source on the card ground, where the secondary text is measured
        // to read: on the side bar's, the label fell to 4.2:1 under the colours
        // a host that sets none leaves in place.
        target ? 'border-2 border-(--sf-text-secondary) bg-(--sf-bg-primary)' : 'bg-surface-1',
        production && 'border-2 border-status-error bg-status-error/10',
      )}
    >
      {picker !== undefined ? (
        <>
          {/* The picker says the org, and its type in its options: under it,
              what the ribbon adds — production said in words, a status, the
              instance, or that the org picked is no longer held, its id
              second: disconnected while Compare kept it picked, the picker
              showed another org and nothing said the one picked was gone. */}
          {picker}
          {(production ||
            host ||
            (known && known.status !== 'connected') ||
            notHeld !== undefined) && (
            <span
              className={cn(
                'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs',
                production ? 'text-text-primary' : 'text-text-secondary',
              )}
            >
              {shield}
              {marks}
              {hostSpan}
              {notHeld !== undefined && (
                <>
                  <span data-testid={`${testId}-not-held`} className="text-status-warning">
                    {t('common.orgRibbon.notHeld')}
                  </span>
                  <span
                    data-testid={`${testId}-id`}
                    className="min-w-0 font-mono [overflow-wrap:anywhere]"
                  >
                    {notHeld}
                  </span>
                </>
              )}
            </span>
          )}
        </>
      ) : (
        <>
          {/* In the primary colour on a production org's tint, where the
              secondary one fell to 3.7:1 under a host that sets no colours. */}
          <span
            className={cn(
              'flex items-baseline justify-between gap-2 text-xs',
              production ? 'text-text-primary' : 'text-text-secondary',
            )}
          >
            <span className="shrink-0">{label}</span>
            {hostSpan}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {shield}
            <span
              data-testid={`${testId}-name`}
              className={cn(
                'min-w-0 text-base text-text-primary [overflow-wrap:anywhere]',
                target && name ? 'font-semibold' : 'font-medium',
              )}
            >
              {name ||
                (notHeld !== undefined
                  ? t('common.orgRibbon.notHeld')
                  : t('common.orgRibbon.notChosen'))}
            </span>
            {/* The id second, for whoever has to find the org again. */}
            {notHeld !== undefined && !name && (
              <span
                data-testid={`${testId}-id`}
                className={cn(
                  'min-w-0 font-mono text-xs [overflow-wrap:anywhere]',
                  // On a production org's tint the secondary colour fell to
                  // 3.6:1 under Light+, as the label above it once did.
                  production ? 'text-text-primary' : 'text-text-secondary',
                )}
              >
                {notHeld}
              </span>
            )}
            {known && <OrgTypeBadge org={known} />}
            {marks}
          </span>
        </>
      )}
    </div>
  );
};

/**
 * Where a run comes from and where it writes, with the type of each org, from
 * past the choice of the orgs to the results: Forge's Review, Execution and
 * Results, Sync, Autopilot, a Frozen load and Compare, whose pickers it holds.
 *
 * The target is framed and bolder than the source, whatever the theme's
 * colours; a production org takes a shield, the word and a coloured border, so
 * that it reads without its red. Side by side from 560 pixels up, and stacked
 * under: a VS Code panel can be dragged that narrow, and two names did not fit
 * on a line once each said its type and its instance.
 */
export const OrgRibbon: React.FC<OrgRibbonProps> = ({
  source,
  target,
  kind = 'copy',
  pickers,
  className,
}) => {
  const { t } = useTranslation();
  const sides = SIDE_KEYS[kind];
  return (
    <div
      role="group"
      aria-label={t('common.orgRibbon.label')}
      data-testid="org-ribbon"
      className={cn(
        'flex flex-col items-stretch gap-1',
        'min-[560px]:flex-row min-[560px]:items-center min-[560px]:gap-2',
        className,
      )}
    >
      <RibbonSide
        org={source}
        label={t(sides.source)}
        target={false}
        picker={pickers?.source}
        testId="org-ribbon-source"
      />
      <ArrowRight
        size={18}
        aria-hidden="true"
        className="hidden shrink-0 text-text-secondary min-[560px]:block"
      />
      <ArrowDown
        size={16}
        aria-hidden="true"
        className="self-center text-text-secondary min-[560px]:hidden"
      />
      <RibbonSide
        org={target}
        label={t(sides.target)}
        target
        picker={pickers?.target}
        testId="org-ribbon-target"
      />
    </div>
  );
};
