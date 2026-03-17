import type { Variants, Transition } from 'framer-motion';

/** Global spring configuration for consistent animation feel. */
export const SPRING: Transition = { type: 'spring', stiffness: 300, damping: 30 };

/** Fade in from transparent. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: SPRING },
};

/** Slide up with fade. */
export const slideUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: SPRING },
};

/** Stagger children animations. */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};

/** Card hover lift effect. */
export const cardHover = { whileHover: { scale: 1.01, y: -2 }, transition: SPRING };

/** Button press scale effect. */
export const buttonPress = { whileTap: { scale: 0.97 } };

/** Page transition with directional slide. */
export function pageTransition(direction: 1 | -1): Variants {
  return {
    enter: { opacity: 0, x: direction * 20 },
    center: { opacity: 1, x: 0, transition: SPRING },
    exit: { opacity: 0, x: direction * -20, transition: { duration: 0.15 } },
  };
}
