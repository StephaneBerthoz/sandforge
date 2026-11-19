import type { TFunction } from 'i18next';

/**
 * Why the target takes no record of an object. `notInTarget`: the target
 * would not describe it — it has no such object, or the user SandForge
 * connects as there may not see it, which the platform answers alike;
 * `notCreateable`: that user may not create its records.
 */
export type ObjectAdminNeed = 'notInTarget' | 'notCreateable';

/** An object the target takes no record of, and why. */
export interface ObjectAdminStep {
  object: string;
  need: ObjectAdminNeed;
}

/**
 * The changes to make in the Setup of `org` for SandForge to write the
 * records of `steps`' objects there, as they are copied for its admin: a
 * heading naming the org, then a step an object — deploy it and give Read and
 * Create on it, or give Create on it. Empty when no object needs anything.
 *
 * Seed's clone, Autopilot's objects and Frozen's load each said, in a line
 * per object, to deploy it or to grant Create on it, and the user wrote the
 * list out again to hand it to whoever administers the target.
 */
export function objectAdminText(
  t: TFunction,
  org: string,
  steps: readonly ObjectAdminStep[],
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { object, need } of steps) {
    if (seen.has(object)) continue;
    seen.add(object);
    lines.push(
      `- ${t(need === 'notInTarget' ? 'adminCopy.step.deploy' : 'adminCopy.step.grantCreate', {
        object,
        org,
      })}`,
    );
  }
  if (lines.length === 0) return '';
  return [t('adminCopy.heading', { org }), '', ...lines].join('\n');
}
