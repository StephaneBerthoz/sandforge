import type { AuthMethod, ConnectionConfig } from '@sandforge/shared';
import { DEFAULT_SOQL_LIMITS } from '@sandforge/shared';
import type { SfdxBridge } from './SfdxBridge';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/** Authentication result */
export interface AuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  instanceUrl?: string;
  userId?: string;
  orgId?: string;
  error?: string;
}

/** Authentication credentials for different methods */
export interface AuthCredentials {
  method: AuthMethod;
  loginUrl: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  securityToken?: string;
  privateKey?: string;
  accessToken?: string;
  refreshToken?: string;
}

/** Identity + org info returned by validateConnection */
export interface OrgIdentity {
  userId: string;
  username: string;
  displayName: string;
  orgId: string;
  orgName: string;
  orgType: string;
  isSandbox: boolean;
}

/**
 * Provides authentication services for Salesforce orgs.
 * Supports multiple auth methods: OAuth, JWT, Username/Password, SFDX import.
 */
export class AuthProvider {
  private tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  private sfdxBridge: SfdxBridge | undefined;

  /** Inject optional SfdxBridge dependency */
  setSfdxBridge(bridge: SfdxBridge): void {
    this.sfdxBridge = bridge;
  }

  /** Authenticate with the given credentials */
  async authenticate(credentials: AuthCredentials): Promise<AuthResult> {
    switch (credentials.method) {
      case 'oauth_web':
        return this.authenticateOAuth(credentials);
      case 'oauth_device':
        return {
          success: false,
          error: 'OAuth device flow handled via DeviceLogin and SfdxBridge.loginWithRefreshToken()',
        };
      case 'jwt':
        return this.authenticateJwt(credentials);
      case 'usernamePassword':
        return this.authenticateUsernamePassword(credentials);
      case 'sfdx_import':
        return this.importFromSfdx(credentials.username);
      default:
        return {
          success: false,
          error: `Unsupported auth method: ${credentials.method as string}`,
        };
    }
  }

  /** Build a ConnectionConfig from auth result */
  buildConnectionConfig(credentials: AuthCredentials, result: AuthResult): ConnectionConfig {
    return {
      loginUrl: credentials.loginUrl,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      instanceUrl: result.instanceUrl,
      username: credentials.username,
    };
  }

  /**
   * Validate a connection by calling identity() and querying Organization.
   * Returns org identity info if successful.
   */
  async validateConnection(accessToken: string, instanceUrl: string): Promise<OrgIdentity> {
    // Lazy boundary — see jsforceEntry.ts.
    const { jsforce } = await import('./jsforceEntry.js');
    const conn = new jsforce.Connection({ accessToken, instanceUrl });
    const identity = await conn.identity();

    const orgResult = await conn.query<{
      Id: string;
      Name: string;
      OrganizationType: string;
      IsSandbox: boolean;
    }>(
      `SELECT Id, Name, OrganizationType, IsSandbox FROM Organization LIMIT ${DEFAULT_SOQL_LIMITS.singleRecord}`,
    );

    const orgRecord = orgResult.records[0];
    return {
      userId: identity.user_id,
      username: identity.username,
      displayName: identity.display_name,
      orgId: orgRecord.Id,
      orgName: orgRecord.Name,
      orgType: orgRecord.OrganizationType,
      isSandbox: orgRecord.IsSandbox,
    };
  }

  /** Check if a cached token is still valid */
  isTokenValid(orgId: string): boolean {
    const cached = this.tokenCache.get(orgId);
    if (!cached) return false;
    return Date.now() < cached.expiresAt;
  }

  /** Cache a token with TTL */
  cacheToken(orgId: string, token: string, ttlMs: number): void {
    this.tokenCache.set(orgId, { token, expiresAt: Date.now() + ttlMs });
  }

  /** Get a cached token */
  getCachedToken(orgId: string): string | undefined {
    const cached = this.tokenCache.get(orgId);
    if (!cached || Date.now() >= cached.expiresAt) {
      this.tokenCache.delete(orgId);
      return undefined;
    }
    return cached.token;
  }

  /** Clear token cache for an org */
  clearTokenCache(orgId: string): void {
    this.tokenCache.delete(orgId);
  }

  /** Clear all token caches */
  clearAllTokens(): void {
    this.tokenCache.clear();
  }

  private async authenticateOAuth(_credentials: AuthCredentials): Promise<AuthResult> {
    return { success: false, error: 'OAuth handled via SfdxBridge.loginWeb()' };
  }

  private async authenticateJwt(_credentials: AuthCredentials): Promise<AuthResult> {
    return { success: false, error: 'JWT handled via SfdxBridge.loginJwt()' };
  }

  private async authenticateUsernamePassword(credentials: AuthCredentials): Promise<AuthResult> {
    if (!credentials.username || !credentials.password) {
      return { success: false, error: 'Username and password are required' };
    }

    try {
      // Lazy boundary — see jsforceEntry.ts.
      const { jsforce } = await import('./jsforceEntry.js');
      const conn = new jsforce.Connection({ loginUrl: credentials.loginUrl });
      const userInfo = await conn.login(
        credentials.username,
        credentials.password + (credentials.securityToken ?? ''),
      );

      return {
        success: true,
        accessToken: conn.accessToken ?? undefined,
        instanceUrl: conn.instanceUrl,
        userId: userInfo.id,
        orgId: userInfo.organizationId,
      };
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      return { success: false, error: `Login failed: ${message}` };
    }
  }

  /**
   * The session the CLI holds for `username`.
   *
   * It used to be the session of whichever org the CLI listed first, sorted
   * by alias: an answer about an org nobody asked for.
   */
  private async importFromSfdx(username: string | undefined): Promise<AuthResult> {
    if (!this.sfdxBridge) {
      return { success: false, error: 'SFDX bridge not configured' };
    }
    if (!username) {
      return { success: false, error: 'An SFDX import needs the username of the org to import' };
    }

    try {
      const found = await this.sfdxBridge.findOrg(username);
      if (!found) {
        return { success: false, error: `No connected org for ${username} found in SF CLI` };
      }
      return {
        success: true,
        accessToken: found.credentials.accessToken,
        instanceUrl: found.credentials.instanceUrl,
        orgId: found.org.orgId,
      };
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      return { success: false, error: `SFDX import failed: ${message}` };
    }
  }
}
