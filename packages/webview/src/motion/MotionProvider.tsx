import React from 'react';
import { LazyMotion, domAnimation } from 'framer-motion';

/** Motion provider that wraps the app with LazyMotion for reduced bundle size. */
export const MotionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <LazyMotion features={domAnimation} strict>
    {children}
  </LazyMotion>
);
