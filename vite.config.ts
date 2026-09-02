import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4301,
    // The API and websocket live on the dashboard server; proxying keeps the browser
    // on one origin so there is no CORS configuration to get wrong.
    proxy: {
      '/api': 'http://127.0.0.1:4300',
      '/ws': { target: 'ws://127.0.0.1:4300', ws: true },
    },
  },
})
