import type { UUID, ISODateString } from './common.types.js';

/** Safety tier for Salesforce orgs — controls confirmation UX and audit requirements */
export enum OrgSafetyTier {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

/** Type of Salesforce org */
export type OrgType = 'Production' | 'Sandbox' | 'Scratch' | 'Developer';

/** Type of Salesforce sandbox */
export type SandboxType = 'Developer' | 'DeveloperPro' | 'Partial' | 'Full';

/** Authentication method for connecting to an org */
export type AuthMethod =
  | 'oauth_web'
  | 'oauth_device'
  | 'jwt'
  | 'usernamePassword'
  | 'sfdx_import';

/** Org connection status */
export type OrgStatus = 'connected' | 'expired' | 'error' | 'refreshing';

/** Visual appearance configuration for an org in the sidebar */
export interface OrgAppearance {
  color: string;
  icon: string;
  position: number;
}

/** Org metadata retrieved from Salesforce */
export interface OrgMetadata {
  apiVersion: string;
  edition: string;
  features: string[];
  namespace?: string;
  isSandboxOf?: string;
}

/** Salesforce org configuration */
export interface SalesforceOrg {
  id: UUID;
  alias: string;
  username: string;
  instanceUrl: string;
  orgId: string;
  orgType: OrgType;
  sandboxType?: SandboxType;
  authMethod: AuthMethod;
  safetyTier: OrgSafetyTier;
  appearance: OrgAppearance;
  metadata: OrgMetadata;
  status: OrgStatus;
  lastConnected: ISODateString;
  tags: string[];
}

/** Connection configuration for authentication */
export interface ConnectionConfig {
  loginUrl: string;
  clientId?: string;
  clientSecret?: string;
  privateKey?: string;
  username?: string;
  accessToken?: string;
  refreshToken?: string;
  instanceUrl?: string;
}

/** Connection pool configuration */
export interface PoolConfig {
  maxConnections: number;
  keepAliveInterval: number;
  connectionTimeout: number;
  idleTimeout: number;
}

/** Result of a health probe against an org */
export interface HealthProbeResult {
  orgId: string;
  healthy: boolean;
  latency: number;
  apiVersion: string;
  limitsSnapshot?: Record<string, { max: number; remaining: number }>;
  timestamp: ISODateString;
}

/** Circuit breaker state */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

/** Circuit breaker configuration */
export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenRequests: number;
}
