import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'

// The Base44 vite plugin is gone — it injected platform app params and
// rewrote legacy SDK imports, neither of which applies locally.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  server: {
    port: 5173,
    // Bound to loopback: this UI shows positions and can arm trading, so it
    // must not be reachable from the network.
    host: '127.0.0.1',
  },
})
