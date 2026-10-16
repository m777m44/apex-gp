import { defineConfig } from 'vite';

// Split the three.js vendor code out of the game chunk so the 1.6 MB single
// file becomes a long-cacheable vendor chunk plus the game itself. `three` has
// no game imports, so this split cannot change execution order — it only
// changes which file the module factory lives in.
export default defineConfig({
  build: {
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
});
