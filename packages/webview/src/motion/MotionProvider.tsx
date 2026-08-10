import React from 'react';
import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion';

/**
 * Motion provider that wraps the app with LazyMotion for reduced bundle size.
 * `reducedMotion="user"` makes every framer-motion animation/transform honor
 * the OS-level prefers-reduced-motion setting globally.
 */
export const MotionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion="user">{children}</MotionConfig>
  </LazyMotion>
);
