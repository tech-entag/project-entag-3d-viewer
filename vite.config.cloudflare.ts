import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

// Cloudflare Pages build config.
// Mirrors vite.config.ts but WITHOUT vite-plugin-vercel, so the static SPA
// builds to a plain `dist/` that Cloudflare Pages serves. The original
// vite.config.ts (Vercel) is left untouched.
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
