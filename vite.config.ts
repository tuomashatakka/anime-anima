import { defineConfig } from 'vite'

// On GitHub Pages the app is served from a project sub-path
// (https://<user>.github.io/<repo>/), so the production build needs a matching
// base. The deploy workflow sets VITE_BASE; local dev stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.VITE_BASE ?? '/') : '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
}))
