/**
 * Shared mock org fixtures for E2E tests.
 *
 * These match the shape used across seed.spec.ts, compare.spec.ts, etc.
 * Org objects follow the structure returned by the extension's org:list:response.
 */

export interface MockOrg {
  id: string;
  alias: string;
  username: string;
  instanceUrl: string;
  orgType: string;
  status: string;
  /**
   * `SalesforceOrg` requires it, and the Organizations page reads it without a
   * guard (`orgTypeLabel`), so a fixture without it is a shape the product
   * never sends — and the page it crashed was the one this fixture exists to
   * open. The degraded shape, which older stored entries really do have, is
   * covered where it enters: `OrgRegistry.loadAll`.
   */
  tags: string[];
}

/** Standard dev sandbox org for source scenarios. */
export const DEV_SANDBOX: MockOrg = {
  id: 'org-src-1',
  alias: 'DevSandbox',
  username: 'dev@sandbox.com',
  instanceUrl: 'https://dev.salesforce.com',
  orgType: 'Sandbox',
  status: 'connected',
  tags: [],
};

/** Standard QA sandbox org for target scenarios. */
export const QA_SANDBOX: MockOrg = {
  id: 'org-tgt-1',
  alias: 'QASandbox',
  username: 'qa@sandbox.com',
  instanceUrl: 'https://qa.salesforce.com',
  orgType: 'Sandbox',
  status: 'connected',
  tags: [],
};

/** Default pair of connected orgs used by most module specs. */
export const MOCK_ORGS: MockOrg[] = [DEV_SANDBOX, QA_SANDBOX];

/** Empty org list for no-connection scenarios. */
export const MOCK_EMPTY_ORGS: MockOrg[] = [];

/**
 * Factory to create a mock org with custom overrides.
 */
export function createMockOrg(overrides?: Partial<MockOrg>): MockOrg {
  return {
    id: `org-${Date.now()}`,
    alias: 'TestOrg',
    username: 'test@org.com',
    instanceUrl: 'https://test.salesforce.com',
    orgType: 'Sandbox',
    status: 'connected',
    ...overrides,
  };
}
