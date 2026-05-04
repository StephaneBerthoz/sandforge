import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { GovernancePolicy, GovernanceRule } from './GovernanceEngine.js';
import { GovernancePolicySchema } from './GovernanceEngine.js';

/** Key prefix for governance policies in the config store. */
const POLICY_PREFIX = 'governance:policy:';

/** Category used in the config store. */
const POLICY_CATEGORY = 'governance';

/**
 * Persists governance policies to the ConfigStore.
 *
 * Provides CRUD operations, default templates, and export/import.
 */
export class GovernancePolicyStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Retrieve all stored governance policies.
   *
   * @returns Array of governance policies.
   */
  getAll(): GovernancePolicy[] {
    const keys = this.configStore.getKeysByPrefix(POLICY_PREFIX);
    const policies: GovernancePolicy[] = [];
    for (const key of keys) {
      const raw = this.configStore.get<GovernancePolicy>(key);
      if (raw) {
        const parsed = GovernancePolicySchema.safeParse(raw);
        if (parsed.success) {
          policies.push(parsed.data);
        }
      }
    }
    return policies;
  }

  /**
   * Retrieve a single policy by ID.
   *
   * @param policyId - The policy identifier.
   * @returns The policy if found, undefined otherwise.
   */
  getById(policyId: string): GovernancePolicy | undefined {
    const raw = this.configStore.get<GovernancePolicy>(`${POLICY_PREFIX}${policyId}`);
    if (!raw) {
      return undefined;
    }
    const parsed = GovernancePolicySchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Save (create or update) a governance policy.
   *
   * @param policy - The policy to save.
   */
  save(policy: GovernancePolicy): void {
    this.configStore.set(`${POLICY_PREFIX}${policy.id}`, policy, POLICY_CATEGORY);
  }

  /**
   * Delete a governance policy by ID.
   *
   * @param policyId - The policy identifier.
   * @returns True if the policy was found and deleted.
   */
  delete(policyId: string): boolean {
    return this.configStore.delete(`${POLICY_PREFIX}${policyId}`);
  }

  /**
   * Export all policies as a JSON string.
   *
   * @returns Serialized policies array.
   */
  exportPolicies(): string {
    return JSON.stringify(this.getAll());
  }

  /**
   * Import policies from a JSON string, replacing existing ones with same ID.
   *
   * @param json - JSON string containing an array of policies.
   * @returns Number of policies imported.
   * @throws If the JSON is invalid or policies fail validation.
   */
  importPolicies(json: string): number {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) {
      throw new Error('Expected an array of policies');
    }

    let count = 0;
    for (const item of raw) {
      const parsed = GovernancePolicySchema.safeParse(item);
      if (parsed.success) {
        this.save(parsed.data);
        count++;
      }
    }
    return count;
  }

  /**
   * Get default policy templates.
   *
   * @returns Array of built-in policy templates.
   */
  static getDefaultTemplates(): GovernancePolicy[] {
    const now = new Date().toISOString();

    const securityRules: GovernanceRule[] = [
      {
        id: 'sec-mfa',
        name: 'MFA Enabled',
        description: 'Multi-factor authentication should be enabled for all users',
        category: 'security',
        condition: {
          metric: 'mfaEnabledPercent',
          operator: 'lt',
          threshold: 100,
          warningThreshold: 90,
        },
        remediation: 'Enable MFA for all user profiles in Setup > Identity Verification',
        enabled: true,
      },
      {
        id: 'sec-password',
        name: 'Password Policy Strength',
        description: 'Password policy should enforce minimum complexity',
        category: 'security',
        condition: {
          metric: 'passwordPolicyScore',
          operator: 'lt',
          threshold: 60,
          warningThreshold: 80,
        },
        remediation: 'Strengthen password policy in Setup > Password Policies',
        enabled: true,
      },
    ];

    const performanceRules: GovernanceRule[] = [
      {
        id: 'perf-api',
        name: 'API Usage Limit',
        description: 'API usage should stay below critical thresholds',
        category: 'performance',
        condition: {
          metric: 'apiUsagePercent',
          operator: 'gt',
          threshold: 90,
          warningThreshold: 75,
        },
        remediation: 'Optimize API-heavy integrations or request a limit increase',
        enabled: true,
      },
      {
        id: 'perf-storage',
        name: 'Storage Usage',
        description: 'Data storage should not exceed safe limits',
        category: 'performance',
        condition: {
          metric: 'storageUsagePercent',
          operator: 'gt',
          threshold: 90,
          warningThreshold: 75,
        },
        remediation: 'Archive old records or increase storage allocation',
        enabled: true,
      },
    ];

    const complianceRules: GovernanceRule[] = [
      {
        id: 'comp-coverage',
        name: 'Code Coverage',
        description: 'Apex code coverage must meet minimum threshold',
        category: 'compliance',
        condition: {
          metric: 'codeCoveragePercent',
          operator: 'lt',
          threshold: 75,
          warningThreshold: 85,
        },
        remediation: 'Write additional unit tests to increase code coverage',
        enabled: true,
      },
    ];

    return [
      {
        id: 'template-security',
        name: 'Security Policy',
        description: 'Default security governance rules',
        rules: securityRules,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'template-performance',
        name: 'Performance Policy',
        description: 'Default performance governance rules',
        rules: performanceRules,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'template-compliance',
        name: 'Compliance Policy',
        description: 'Default compliance governance rules',
        rules: complianceRules,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
