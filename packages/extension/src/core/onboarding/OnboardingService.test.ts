import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OnboardingService } from './OnboardingService';

describe('OnboardingService', () => {
  let service: OnboardingService;
  let store: Map<string, string>;
  const mockUpdate = vi.fn<(key: string, value: string) => Promise<void>>();

  beforeEach(() => {
    store = new Map();
    mockUpdate.mockClear();
    mockUpdate.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    });
    service = new OnboardingService({
      get: (key: string) => store.get(key),
      update: mockUpdate,
    });
  });

  describe('shouldShowOnboarding', () => {
    it('should return true when onboarding has never been completed', () => {
      expect(service.shouldShowOnboarding()).toBe(true);
    });

    it('should return false after onboarding is marked complete', async () => {
      await service.markOnboardingComplete();
      expect(service.shouldShowOnboarding()).toBe(false);
    });
  });

  describe('shouldShowWhatsNew', () => {
    it('should return false when no previous version is stored', () => {
      expect(service.shouldShowWhatsNew('1.0.0')).toBe(false);
    });

    it('should return false when version matches stored version', async () => {
      await service.markVersionSeen('1.0.0');
      expect(service.shouldShowWhatsNew('1.0.0')).toBe(false);
    });

    it('should return true when version differs from stored version', async () => {
      await service.markVersionSeen('0.9.0');
      expect(service.shouldShowWhatsNew('1.0.0')).toBe(true);
    });
  });

  describe('isFirstLaunch', () => {
    it('should return true when no version has ever been stored', () => {
      expect(service.isFirstLaunch()).toBe(true);
    });

    it('should return false after a version has been seen', async () => {
      await service.markVersionSeen('1.0.0');
      expect(service.isFirstLaunch()).toBe(false);
    });
  });

  describe('markOnboardingComplete', () => {
    it('should persist the onboarding completed flag', async () => {
      await service.markOnboardingComplete();
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.onboardingCompleted', 'true');
    });
  });

  describe('markVersionSeen', () => {
    it('should persist the version string', async () => {
      await service.markVersionSeen('2.1.0');
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.lastVersion', '2.1.0');
    });
  });

  describe('resetOnboarding', () => {
    it('should clear the onboarding completed flag', async () => {
      await service.markOnboardingComplete();
      await service.resetOnboarding();
      expect(service.shouldShowOnboarding()).toBe(true);
    });

    it('should call update with empty string', async () => {
      await service.resetOnboarding();
      expect(mockUpdate).toHaveBeenCalledWith('sandforge.onboardingCompleted', '');
    });
  });
});
