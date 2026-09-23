/**
 * What a deployment from a comparison may carry, read by both ends of the
 * bridge: the Deploy tab offers only what passes, and the extension refuses a
 * request that does not.
 */
import type {
  DeployTestLevel,
  MetadataComponentType,
  NotDeployableReason,
} from '../types/compare.types.js';

/** The test levels a deployment from a comparison offers. */
export const DEPLOY_TEST_LEVELS = [
  'NoTestRun',
  'RunSpecifiedTests',
  'RunLocalTests',
] as const satisfies readonly DeployTestLevel[];

/**
 * Components one deployment carries at most. A comparison reads 500
 * components from each org, and a list longer than that is past what anyone
 * picks by hand; the Metadata API itself takes ten thousand files.
 */
export const DEPLOY_MAX_COMPONENTS = 500;

/** Test classes one deployment can name. */
export const DEPLOY_MAX_TESTS = 100;

/**
 * How long the extension follows one retrieval and one deployment before it
 * stops waiting and says where to follow it. A validation that runs every
 * local test of a sandbox takes minutes, and more on a large org.
 */
export const DEPLOY_WAIT_MINUTES = { retrieve: 5, deploy: 30 } as const;

/**
 * An Apex test class as a deployment names it: `Name`, or `namespace.Name`
 * for a class of a package.
 */
export const DEPLOY_TEST_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?$/;

/**
 * The types a deployment from a comparison carries. Each is deployed under
 * its own name, which is the Metadata API's name for it.
 */
export const DEPLOYABLE_COMPONENT_TYPES = [
  'CustomObject',
  'CustomField',
  'RecordType',
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'Flow',
  'WorkflowRule',
  'ValidationRule',
  'Layout',
  'CustomLabel',
  'CustomMetadata',
  'StaticResource',
  'EmailTemplate',
  'Report',
  'Dashboard',
] as const satisfies readonly MetadataComponentType[];

/**
 * Why no component of a type can be deployed from a comparison; `undefined`
 * for a type that can.
 *
 * A profile or a permission set passes the Metadata API but not the
 * comparison: retrieved on its own, it holds only part of what was compared.
 * Retrieved from a sandbox, a permission set whose difference lay in its app
 * visibilities came back as its label, its description and one flag — its
 * access to anything is retrieved only with the thing it opens.
 *
 * Custom settings are custom objects, and "Other" is no type at all: Compare
 * no longer lists either, and neither would reach a deployment.
 */
export function typeNotDeployable(
  componentType: MetadataComponentType,
): NotDeployableReason | undefined {
  if (componentType === 'Profile' || componentType === 'PermissionSet') {
    return 'permissions_in_part';
  }
  return (DEPLOYABLE_COMPONENT_TYPES as readonly string[]).includes(componentType)
    ? undefined
    : 'type_not_deployable';
}
