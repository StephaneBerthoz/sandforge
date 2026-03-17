import { describe, it, expect } from 'vitest';
import {
  SPRING,
  fadeIn,
  slideUp,
  staggerContainer,
  cardHover,
  buttonPress,
  pageTransition,
} from './presets';

describe('presets', () => {
  describe('SPRING', () => {
    it('should have type spring with stiffness 300 and damping 30', () => {
      expect(SPRING).toEqual({ type: 'spring', stiffness: 300, damping: 30 });
    });
  });

  describe('fadeIn', () => {
    it('should have hidden and visible variants', () => {
      expect(fadeIn).toHaveProperty('hidden');
      expect(fadeIn).toHaveProperty('visible');
    });

    it('should set opacity 0 in hidden and opacity 1 in visible', () => {
      expect(fadeIn.hidden).toEqual({ opacity: 0 });
      expect(fadeIn.visible).toMatchObject({ opacity: 1 });
    });
  });

  describe('slideUp', () => {
    it('should have hidden with y=8 and visible with y=0', () => {
      expect(slideUp.hidden).toMatchObject({ opacity: 0, y: 8 });
      expect(slideUp.visible).toMatchObject({ opacity: 1, y: 0 });
    });
  });

  describe('staggerContainer', () => {
    it('should have staggerChildren in visible transition', () => {
      const visible = staggerContainer.visible as Record<string, unknown>;
      const transition = visible['transition'] as Record<string, unknown>;
      expect(transition).toHaveProperty('staggerChildren', 0.04);
    });
  });

  describe('cardHover', () => {
    it('should have whileHover with scale and y', () => {
      expect(cardHover.whileHover).toEqual({ scale: 1.01, y: -2 });
    });

    it('should include the SPRING transition', () => {
      expect(cardHover.transition).toEqual(SPRING);
    });
  });

  describe('buttonPress', () => {
    it('should have whileTap with scale', () => {
      expect(buttonPress.whileTap).toEqual({ scale: 0.97 });
    });
  });

  describe('pageTransition', () => {
    it('should return enter.x=20 and exit.x=-20 for direction 1', () => {
      const variants = pageTransition(1);
      expect(variants.enter).toMatchObject({ opacity: 0, x: 20 });
      expect(variants.exit).toMatchObject({ opacity: 0, x: -20 });
    });

    it('should return enter.x=-20 and exit.x=20 for direction -1', () => {
      const variants = pageTransition(-1);
      expect(variants.enter).toMatchObject({ opacity: 0, x: -20 });
      expect(variants.exit).toMatchObject({ opacity: 0, x: 20 });
    });

    it('should have center with opacity 1 and x 0', () => {
      const variants = pageTransition(1);
      expect(variants.center).toMatchObject({ opacity: 1, x: 0 });
    });
  });
});
