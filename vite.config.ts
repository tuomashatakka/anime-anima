import { defineConfig } from 'vite'

// Relative base so the built app can be served from any sub-path.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
