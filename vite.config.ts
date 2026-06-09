import { defineConfig } from 'vite'
import vercel from 'vite-plugin-vercel'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths"

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vercel(),
    react(),
    tsconfigPaths(),
  ],
  server: {
    headers: {
      'X-Frame-Options': 'ALLOWALL',
      'Content-Security-Policy': "frame-ancestors 'self' *",
    },
  },
  vercel: {
    defaultMaxDuration: 60,
    rewrites: [
      { source: '/viewer', destination: '/' },
      { source: '/viewer/(.*)', destination: '/' },
      { source: '/embed/part', destination: '/' },
      { source: '/embed/part/(.*)', destination: '/' },
    ],
  },
})
