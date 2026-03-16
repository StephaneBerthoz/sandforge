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
}

/** Standard dev sandbox org for source scenarios. */
export const DEV_SANDBOX: MockOrg = {
  id: 'org-src-1',
  alias: 'DevSandbox',
  username: 'dev@sandbox.com',
  instanceUrl: 'https://dev.salesforce.com',
  orgType: 'Sandbox',
  status: 'connected',
};

/** Standard QA sandbox org for target scenarios. */
export const QA_SANDBOX: MockOrg = {
  id: 'org-tgt-1',
  alias: 'QASandbox',
  username: 'qa@sandbox.com',
  instanceUrl: 'https://qa.salesforce.com',
  orgType: 'Sandbox',
  status: 'connected',
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
