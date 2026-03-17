import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    /* Single-file IIFE bundle for VSCode webview — no ES module imports */
    lib: {
      entry: path.resolve(__dirname, 'src/main.tsx'),
      name: 'SandForge',
      formats: ['iife'],
      fileName: () => 'assets/index.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[ext]',
        /* Inline everything — webview CSP blocks dynamic imports */
        inlineDynamicImports: true,
      },
    },
    cssCodeSplit: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});
