/**
 * OnboardingService manages first-time user experience.
 * Tracks whether the onboarding wizard has been completed
 * and whether the "What's New" panel should be shown after updates.
 */
export class OnboardingService {
  private static ONBOARDING_KEY = 'sandforge.onboardingCompleted';
  private static VERSION_KEY = 'sandforge.lastVersion';

  private readonly globalStateGet: (key: string) => string | undefined;
  private readonly globalStateUpdate: (key: string, value: string) => Thenable<void>;

  constructor(globalState: {
    get: (key: string) => string | undefined;
    update: (key: string, value: string) => Thenable<void>;
  }) {
    this.globalStateGet = (key: string) => globalState.get(key);
    this.globalStateUpdate = (key: string, value: string) => globalState.update(key, value);
  }

  /** Returns true if the user has never completed onboarding. */
  shouldShowOnboarding(): boolean {
    const completed = this.globalStateGet(OnboardingService.ONBOARDING_KEY);
    return completed !== 'true';
  }

  /** Returns true if the extension version changed since last launch. */
  shouldShowWhatsNew(currentVersion: string): boolean {
    const lastVersion = this.globalStateGet(OnboardingService.VERSION_KEY);
    return lastVersion !== undefined && lastVersion !== currentVersion;
  }

  /** Returns true if this is the very first activation (no version stored). */
  isFirstLaunch(): boolean {
    return this.globalStateGet(OnboardingService.VERSION_KEY) === undefined;
  }

  /** Mark onboarding as completed. */
  async markOnboardingComplete(): Promise<void> {
    await this.globalStateUpdate(OnboardingService.ONBOARDING_KEY, 'true');
  }

  /** Store the current version as last seen version. */
  async markVersionSeen(version: string): Promise<void> {
    await this.globalStateUpdate(OnboardingService.VERSION_KEY, version);
  }

  /** Reset onboarding state (for testing or user request). */
  async resetOnboarding(): Promise<void> {
    await this.globalStateUpdate(OnboardingService.ONBOARDING_KEY, '');
  }
}
