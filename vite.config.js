import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative paths so the built app works from any sub-path, including file://.
  base: './',
  server: {
    headers: {
      // Required for SharedArrayBuffer, which the unsung wasm module uses for threads.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    // Keep unsung.js/unsung.wasm as separate files rather than inlined.
    assetsInlineLimit: 0,
  },
});
