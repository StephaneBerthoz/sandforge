import { DEPLOY_MAX_TESTS, DEPLOY_TEST_NAME_PATTERN, typeNotDeployable } from '@sandforge/shared';
import type {
  CompareItem,
  CompareReport,
  DeploymentCandidate,
  DeploymentSuggestion,
  DeployTestLevel,
  NotDeployableReason,
} from '@sandforge/shared';
import { GROUP_ORDER, groupOf, needsApexTests } from './enrichDiffs';

/** The key a component is picked by: its type and its name. */
export function candidateKey(c: { componentType: string; fullName: string }): string {
  return `${c.componentType}:${c.fullName}`;
}

/**
 * Why a component of a comparison cannot be deployed from it; `undefined`
 * when it can.
 *
 * A deployment retrieves what the source holds and deploys it to the target,
 * so it carries a component only the source holds (`removed`, in the
 * comparison's terms) or one that differs. What a package installed is the
 * package's, whatever else is true of it.
 */
export function notDeployableReason(item: CompareItem): NotDeployableReason | undefined {
  if (item.managed) return 'managed';
  if (item.status === 'not_compared') {
    return item.notComparedReason === 'unreadable' ? 'unreadable' : 'not_compared';
  }
  if (item.status === 'added') return 'only_in_target';
  return typeNotDeployable(item.componentType);
}

/**
 * What a comparison offers to deploy, from what the risk card computed of it:
 * every change and every component left unread, each with the card's risk
 * and group, split into what a deployment can carry and what it cannot. An
 * unchanged component is neither.
 *
 * Listed in the card's group order, data model first. Salesforce orders the
 * components of one deployment itself; the order is for reading.
 */
export function suggestDeployment(
  items: readonly CompareItem[],
  report: CompareReport,
): DeploymentSuggestion {
  const risk = new Map(
    report.diffs.map((d) => [candidateKey({ componentType: d.category, fullName: d.name }), d]),
  );
  const candidates: DeploymentCandidate[] = items
    .filter((item) => item.status !== 'unchanged')
    .map((item) => {
      const reason = notDeployableReason(item);
      return {
        componentType: item.componentType,
        fullName: item.fullName,
        status: item.status,
        riskLevel: risk.get(candidateKey(item))?.riskLevel ?? 'none',
        group: groupOf(item.componentType),
        ...(reason ? { notDeployable: reason } : {}),
      };
    })
    .sort(
      (a, b) =>
        GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
        a.componentType.localeCompare(b.componentType) ||
        a.fullName.localeCompare(b.fullName),
    );
  return {
    deployable: candidates.filter((c) => c.notDeployable === undefined),
    notDeployable: candidates.filter((c) => c.notDeployable !== undefined),
  };
}

/**
 * The tests the risk card advises for what is picked: the target's own when
 * it holds Apex — the card's "Run all Apex tests" — and none otherwise.
 */
export function advisedTestLevel(
  picked: ReadonlyArray<{ componentType: string }>,
): DeployTestLevel {
  return needsApexTests(picked.map((c) => c.componentType)) ? 'RunLocalTests' : 'NoTestRun';
}

/**
 * Test classes typed in one field, separated by commas, semicolons or
 * spaces: each once, the names a deployment accepts apart from the rest, and
 * whether there are more than one deployment names.
 */
export function parseTestNames(text: string): {
  names: string[];
  invalid: string[];
  tooMany: boolean;
} {
  const typed = [...new Set(text.split(/[\s,;]+/).filter((token) => token !== ''))];
  const names = typed.filter((name) => DEPLOY_TEST_NAME_PATTERN.test(name));
  return {
    names,
    invalid: typed.filter((name) => !DEPLOY_TEST_NAME_PATTERN.test(name)),
    tooMany: names.length > DEPLOY_MAX_TESTS,
  };
}
