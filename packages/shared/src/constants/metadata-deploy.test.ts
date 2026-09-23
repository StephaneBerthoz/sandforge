import { describe, it, expect } from 'vitest';
import type { MetadataComponentType } from '../types/compare.types.js';
import {
  DEPLOYABLE_COMPONENT_TYPES,
  DEPLOY_MAX_COMPONENTS,
  DEPLOY_MAX_TESTS,
  DEPLOY_TEST_NAME_PATTERN,
  DEPLOY_WAIT_MINUTES,
  typeNotDeployable,
} from './metadata-deploy.js';

describe('typeNotDeployable', () => {
  it('lets through every type the Metadata API deploys under its own name', () => {
    const deployable: MetadataComponentType[] = [
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
    ];
    for (const type of deployable) expect(typeNotDeployable(type), type).toBeUndefined();
    expect([...DEPLOYABLE_COMPONENT_TYPES].sort()).toEqual([...deployable].sort());
  });

  it('holds back profiles and permission sets, which a retrieval returns only in part', () => {
    expect(typeNotDeployable('Profile')).toBe('permissions_in_part');
    expect(typeNotDeployable('PermissionSet')).toBe('permissions_in_part');
  });

  it('refuses the two names that are no Metadata API type', () => {
    expect(typeNotDeployable('CustomSetting')).toBe('type_not_deployable');
    expect(typeNotDeployable('Other')).toBe('type_not_deployable');
  });
});

describe('deployment bounds', () => {
  it('lets a deployment carry many components and name several tests, within bounds', () => {
    expect(DEPLOY_MAX_COMPONENTS).toBeGreaterThan(1);
    expect(DEPLOY_MAX_TESTS).toBeGreaterThan(1);
    expect(Number.isInteger(DEPLOY_MAX_COMPONENTS)).toBe(true);
    expect(Number.isInteger(DEPLOY_MAX_TESTS)).toBe(true);
  });

  it('waits longer for a deployment, which runs tests, than for a retrieval', () => {
    expect(DEPLOY_WAIT_MINUTES.deploy).toBeGreaterThan(DEPLOY_WAIT_MINUTES.retrieve);
  });

  it('reads a test class by its name, or by its namespace and name, and nothing else', () => {
    expect(DEPLOY_TEST_NAME_PATTERN.test('InvoicingTest')).toBe(true);
    expect(DEPLOY_TEST_NAME_PATTERN.test('pkg.InvoicingTest')).toBe(true);
    expect(DEPLOY_TEST_NAME_PATTERN.test('Invoicing Test')).toBe(false);
    expect(DEPLOY_TEST_NAME_PATTERN.test('1Test')).toBe(false);
    expect(DEPLOY_TEST_NAME_PATTERN.test("Test'; --")).toBe(false);
    expect(DEPLOY_TEST_NAME_PATTERN.test('')).toBe(false);
  });
});
